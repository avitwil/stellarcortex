import { ComputerOwnership } from './computer-ownership.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
const mutating = m =>
  m !== 'execution.ping' &&
  m !== 'execution.inspect' &&
  m !== 'browser.read' &&
  !m.endsWith('.status') &&
  !m.endsWith('.snapshot') &&
  ![
    'demo.frame',
    'files.list',
    'files.read',
    'files.inspect',
    'files.chunk',
    'browser.snapshot',
  ].includes(m);
export class GuestWorker {
  constructor({
    vmId,
    generation,
    allowedBots,
    desktop,
    browser,
    workspace,
    runShell,
    typeText = null,
    captureFrame = null,
    ledgerFile,
  }) {
    Object.assign(this, {
      vmId,
      generation,
      desktop,
      browser,
      workspace,
      runShell,
      typeText,
      captureFrame,
      ledgerFile,
    });
    this.computerOwnership = new ComputerOwnership();
    this.allowedBots = new Set(allowedBots);
    this.rosterFile = ledgerFile ? path.join(path.dirname(ledgerFile), 'bot-roster.json') : null;
    if (this.rosterFile && fs.existsSync(this.rosterFile))
      for (const b of JSON.parse(fs.readFileSync(this.rosterFile))) this.allowedBots.add(b);
    this.ledger =
      ledgerFile && fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile)) : {};
    for (const e of Object.values(this.ledger)) if (e.state === 'inflight') e.state = 'uncertain';
    this.pending = new Map();
    this.controllers = new Map();
  }
  save() {
    if (!this.ledgerFile) return;
    const temporary = this.ledgerFile + '.tmp';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.ledger));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.ledgerFile);
    const directory = fs.openSync(path.dirname(this.ledgerFile), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
  file(relative) {
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative))
      throw Error('Guest workspace relative path required');
    const root = fs.realpathSync(this.workspace),
      file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep))
      throw Error('Guest path escapes workspace');
    let current = root;
    for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw Error('Guest workspace symlink boundary');
    }
    return file;
  }
  async handle(request) {
    const reply = {
      protocol: 'scx-guest-v1',
      vmId: this.vmId,
      generation: this.generation,
      requestId: request.requestId,
    };
    try {
      if (
        request.protocol !== reply.protocol ||
        request.vmId !== this.vmId ||
        request.generation !== this.generation
      )
        throw Error('Wrong VM generation');
      if (typeof request.botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.botId))
        throw Error('Invalid guest bot identity');
      if (request.method !== 'roster.register' && !this.allowedBots.has(request.botId))
        throw Error('Unknown guest bot identity');
      if (typeof request.requestId !== 'string' || request.requestId.length > 100)
        throw Error('Request identity required');
      if (
        ['browser.takeover', 'desktop.takeover'].includes(request.method) &&
        request.args?.enabled === true &&
        [...this.pending.keys()].some(
          id =>
            this.ledger[id]?.botId === request.botId &&
            this.ledger[id]?.state === 'inflight' &&
            !['browser.action', 'desktop.action', 'browser.takeover', 'desktop.takeover'].includes(
              this.ledger[id]?.method,
            ),
        )
      )
        throw Error(
          'An agent operation is still running. Observe its screen and wait for completion before taking control.',
        );
      const { transient, ...durable } = request,
        digest = crypto.createHash('sha256').update(JSON.stringify(durable)).digest('hex'),
        old = this.ledger[request.requestId];
      if (old) {
        if (old.state === 'cancelled-before-start') {
          if (old.botId !== request.botId) throw Error('Request belongs to another bot');
          return { ...reply, error: 'Cancelled before guest execution' };
        }
        if (old.digest !== digest) throw Error('Request identity reused with different action');
        if (this.pending.has(request.requestId)) return await this.pending.get(request.requestId);
        if (old.state === 'rejected-before-effects') return { ...reply, error: old.error };
        return {
          ...reply,
          ...(old.state === 'done' && old.safeResult
            ? { result: old.safeResult }
            : { uncertain: true }),
        };
      }
      const execute = async () => {
        if (mutating(request.method)) {
          this.ledger[request.requestId] = {
            digest,
            state: 'inflight',
            botId: request.botId,
            method: request.method,
            action: request.args?.input?.action || null,
          };
          this.save();
        }
        try {
          const result = await this.dispatch(request);
          if (mutating(request.method)) {
            this.ledger[request.requestId] = {
              digest,
              state: 'done',
              botId: request.botId,
              safeResult:
                request.method.startsWith('desktop.') || request.method === 'roster.register'
                  ? { ok: true }
                  : null,
            };
            this.save();
          }
          return { ...reply, result };
        } catch (e) {
          if (mutating(request.method) && e.rejectedBeforeEffects === true) {
            this.ledger[request.requestId] = {
              digest,
              state: 'rejected-before-effects',
              botId: request.botId,
              method: request.method,
              action: request.args?.input?.action || null,
              error: e.message,
            };
            this.save();
            return { ...reply, error: e.message };
          }
          if (mutating(request.method)) {
            this.ledger[request.requestId] = {
              digest,
              state: 'uncertain',
              botId: request.botId,
              method: request.method,
              action: request.args?.input?.action || null,
              errorType: e.name || 'Error',
            };
            this.save();
            return { ...reply, uncertain: true };
          }
          return { ...reply, error: e.message };
        }
      };
      const work = execute().finally(() => this.pending.delete(request.requestId));
      this.pending.set(request.requestId, work);
      return await work;
    } catch (e) {
      return { ...reply, error: e.message };
    }
  }
  async close() {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.pending.values()]);
  }
  async dispatch({ method, botId, requestId, args: a = {}, transient }) {
    if (method === 'roster.register') {
      this.allowedBots.add(botId);
      if (this.rosterFile)
        fs.writeFileSync(this.rosterFile, JSON.stringify([...this.allowedBots]), { mode: 0o600 });
      return { ok: true };
    }
    if (method === 'execution.ping')
      return {
        available: true,
        scope: 'guest',
        vmId: this.vmId,
        generation: this.generation,
        uncertainRequests: Object.entries(this.ledger)
          .filter(([_, r]) => r.botId === botId && r.state === 'uncertain')
          .map(([id]) => id),
      };
    if (method === 'execution.reconcile') {
      if (typeof a.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(a.requestId))
        throw Error('Specific request identity required');
      const r = this.ledger[a.requestId];
      if (typeof a.note !== 'string' || !a.note.trim())
        throw Error('Actual effects review required');
      if (r && r.botId !== botId) throw Error('Cannot reconcile another bot request');
      if (r && r.state === 'inflight') throw Error('Stop active work before reconciliation');
      if (!r && a.tombstone === true) {
        this.ledger[a.requestId] = {
          state: 'reviewed-abandoned',
          botId,
          digest: null,
          reviewNote: a.note.slice(0, 4000),
        };
        this.save();
      }
      if (r && r.state === 'uncertain') {
        r.state = 'reviewed-abandoned';
        r.reviewNote = a.note.slice(0, 4000);
        this.save();
      }
      return { reviewed: true, noReplay: true };
    }
    if (method === 'execution.cancel') {
      const record = this.ledger[a.requestId];
      if (!record) {
        if (typeof a.requestId !== 'string' || a.requestId.length > 100)
          throw Error('Cancellation identity required');
        this.ledger[a.requestId] = { state: 'cancelled-before-start', botId, digest: null };
        this.save();
        return { requested: true, state: 'cancelled-before-start' };
      }
      if (record.botId !== botId) throw Error('Cannot cancel another bot request');
      const controller = this.controllers.get(a.requestId);
      if (controller) controller.abort();
      return { requested: !!controller, state: record.state };
    }
    if (method === 'execution.inspect') {
      const item = this.ledger[a.requestId];
      if (item && item.botId !== botId) throw Error('Request belongs to another bot');
      return {
        found: !!item,
        state: item?.state || null,
        active: this.pending.has(a.requestId),
        method: item?.method || null,
      };
    }
    if (method === 'execution.status') {
      const item = this.ledger[a.requestId];
      if (!item || item.botId !== botId) throw Error('Unknown request for this bot');
      return {
        requestId: a.requestId,
        state: item.state,
        method: item.method || null,
        action: item.action || null,
        errorType: item.errorType || null,
      };
    }
    if (method === 'demo.frame') {
      if (!this.captureFrame) throw Error('Guest visual capture unavailable');
      const status = await this.desktop.status(botId);
      if (!status.takeover || (status.takeoverBotId && status.takeoverBotId !== botId))
        throw Error('Take control before teaching');
      return this.captureFrame({ ...a, botId });
    }
    if (method === 'desktop.type') {
      if (!this.typeText)
        throw Object.assign(Error('Native text input unavailable'), {
          rejectedBeforeEffects: true,
        });
      const controller = new AbortController();
      this.controllers.set(requestId, controller);
      try {
        return await this.typeText(a.text, { signal: controller.signal });
      } finally {
        this.controllers.delete(requestId);
      }
    }
    if (method === 'desktop.status') return this.desktop.status(botId);
    if (method === 'desktop.snapshot') return this.desktop.snapshot(botId);
    if (method === 'desktop.acquire') return this.desktop.acquire(botId, a.runId);
    if (method === 'desktop.release') return this.desktop.release(a.runId);
    if (method === 'desktop.takeover' || method === 'browser.takeover') {
      if (typeof a.enabled !== 'boolean')
        throw Object.assign(Error('Explicit takeover required'), { rejectedBeforeEffects: true });
      await this.computerOwnership.takeover(botId, a.enabled, enabled => {
        this.desktop.setTakeover(botId, enabled);
        enabled ? this.browser.takeover.add(botId) : this.browser.takeover.delete(botId);
      });
      return this.desktop.status(botId);
    }
    if (method === 'desktop.action')
      return this.computerOwnership.input(botId, a.manual === true, () =>
        this.desktop.action(botId, a.input, a.manual === true),
      );
    if (method === 'desktop.remove') return this.desktop.removeBot(botId);
    if (method === 'browser.read') return this.browser.action(botId, { action: 'read' });
    if (method === 'browser.login.status') return this.browser.loginTarget(botId);
    if (method === 'browser.login')
      return this.computerOwnership.input(botId, false, () =>
        this.browser.deliverLogin(botId, a.target, transient),
      );
    if (method === 'browser.snapshot') return this.browser.snapshot(botId);
    if (method === 'browser.action')
      return this.computerOwnership.input(botId, a.manual === true, () =>
        this.browser.action(botId, a.input, a.manual === true),
      );

    if (method === 'files.list') {
      const file = this.file(a.path || '.');
      return {
        entries: fs
          .readdirSync(file, { withFileTypes: true })
          .slice(0, 500)
          .map(f => ({
            name: f.name,
            type: f.isSymbolicLink() ? 'symlink' : f.isDirectory() ? 'directory' : 'file',
          })),
      };
    }
    if (method === 'files.inspect') {
      const file = this.file(a.path);
      if (!fs.existsSync(file)) return { exists: false, hash: null };
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw Error('Guest regular file required');
      const hash = crypto.createHash('sha256');
      for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
      return { exists: true, size: stat.size, hash: hash.digest('hex') };
    }
    if (method === 'files.chunk') {
      const file = this.file(a.path);
      if (
        !Number.isInteger(a.offset) ||
        a.offset < 0 ||
        !Number.isInteger(a.length) ||
        a.length < 1 ||
        a.length > 262144
      )
        throw Error('Bounded file chunk required');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== a.expectedSize) throw Error('Guest artifact changed');
        const buffer = Buffer.alloc(a.length),
          read = fs.readSync(fd, buffer, 0, a.length, a.offset);
        return { data: buffer.subarray(0, read).toString('base64') };
      } finally {
        fs.closeSync(fd);
      }
    }
    if (method === 'files.read') {
      const file = this.file(a.path);
      if (fs.statSync(file).size > 256 * 1024) throw Error('File too large');
      return { text: fs.readFileSync(file, 'utf8') };
    }
    if (method === 'files.write') {
      if (typeof a.text !== 'string' || Buffer.byteLength(a.text) > 256 * 1024)
        throw Error('Text file too large');
      const file = this.file(a.path);
      if ('expectedHash' in a) {
        const current = fs.existsSync(file)
          ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
          : null;
        if (current !== a.expectedHash) throw Error('Guest file changed after approval');
      }
      fs.writeFileSync(file, a.text, {
        mode: 0o600,
        flag:
          fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_NOFOLLOW,
      });
      return { ok: true };
    }
    if (method === 'shell.run') {
      if (!this.runShell) throw Error('Guest shell unavailable');
      if (
        typeof a.command !== 'string' ||
        a.command.includes('\0') ||
        !Array.isArray(a.args) ||
        a.args.some(x => typeof x !== 'string' || x.includes('\0'))
      )
        throw Error('Executable and argument array required');
      const controller = new AbortController();
      this.controllers.set(requestId, controller);
      try {
        return await this.runShell(
          { ...a, cwd: this.file(a.cwd || '.') },
          { signal: controller.signal },
        );
      } finally {
        this.controllers.delete(requestId);
      }
    }
    throw Error('Unsupported guest operation');
  }
}
export async function guestSocketServer(worker, socketPath) {
  if (!path.isAbsolute(socketPath) || fs.existsSync(socketPath))
    throw Error('Unused private guest socket required');
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      socket.pause();
      Promise.resolve()
        .then(() => worker.handle(JSON.parse(line)))
        .then(reply => socket.end(JSON.stringify(reply) + '\n'))
        .catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  return server;
}

export async function prepareGuestSocket(socketPath) {
  if (!path.isAbsolute(socketPath)) throw Error('Private absolute worker socket required');
  if (!fs.existsSync(socketPath)) return;
  const before = fs.lstatSync(socketPath);
  if (!before.isSocket() || before.uid !== process.getuid())
    throw Error('Refusing foreign or non-socket worker path');
  await new Promise((resolve, reject) => {
    let done = false;
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(Error('Cannot establish stale socket ownership')), 1000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    }
    socket.once('connect', () => finish(Error('A guest worker is already active')));
    socket.once('error', error => {
      if (error.code !== 'ECONNREFUSED') return finish(error);
      try {
        const current = fs.lstatSync(socketPath);
        if (current.ino !== before.ino || current.dev !== before.dev)
          throw Error('Worker socket changed during recovery');
        fs.unlinkSync(socketPath);
        finish();
      } catch (e) {
        finish(e);
      }
    });
  });
}
