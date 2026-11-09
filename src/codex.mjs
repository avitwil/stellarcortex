import { CODEX_GUEST_CONFIG } from './codex-guest-policy.mjs';
import { logProcessOutput } from './process-output.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOT_INSTALLED = 'Codex is not fully installed on this server. Run the installer again.';
export function codexCommand() {
  if (process.env.CODEX_BIN) return { bin: process.env.CODEX_BIN, prefix: [] };
  const bundled = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(bundled)) return { bin: process.execPath, prefix: [bundled] };
  return { bin: process.platform === 'win32' ? 'codex.exe' : 'codex', prefix: [] };
}
export class Codex extends EventEmitter {
  constructor({ guestMode = false, executable = null } = {}) {
    super();
    this.guestMode = guestMode;
    this.executable = executable;
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
    this.starting = null;
  }
  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  // Thread config cannot clear mcp_servers, so each configured server is disabled by name. A name that
  // is not in the config makes Codex reject every thread, so a built-in must not be named: codex_apps
  // goes with features.apps, as plugin servers go with features.plugins. Anything else stops an external job.
  // The config takes milliseconds and shows a server added while the app runs, so every turn names what it lists.
  // The server list can hang on a bad server, so only a job with external content waits for it, and stops without it.
  async disabledNativeServers({ live = false } = {}) {
    const configured =
        (await this.request('config/read', { includeLayers: false })).config?.mcp_servers || {},
      names = Object.keys(configured);
    if (names.some(name => !/^[\w-]+$/.test(name)))
      throw new Error('Codex reported an MCP server name that cannot be disabled safely');
    if (live) await this.checkNativeServers(configured);
    return Object.fromEntries(names.map(name => [`mcp_servers.${name}.enabled`, false]));
  }
  async checkNativeServers(configured) {
    let cursor;
    do {
      const page = await this.request('mcpServerStatus/list', cursor ? { cursor } : {}, 15000);
      for (const server of page.data || [])
        if (
          !server.pluginId &&
          server.name !== 'codex_apps' &&
          !Object.hasOwn(configured, server.name)
        )
          throw new Error('Codex reported an MCP server name that cannot be disabled safely');
      cursor = page.nextCursor;
    } while (cursor);
  }
  // `off` is rebuilt on each start: naming a server that is no longer configured stops Codex from starting.
  async boot(off = []) {
    const c = this.executable ? { bin: this.executable, prefix: [] } : codexCommand();
    this.child = spawn(
      c.bin,
      [
        ...c.prefix,
        ...(this.guestMode
          ? Object.entries(CODEX_GUEST_CONFIG).flatMap(([key, value]) => [
              '-c',
              key + '=' + JSON.stringify(value),
            ])
          : []),
        ...off.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]),
        'app-server',
        '--listen',
        'stdio://',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env },
    );
    this.stderr = '';
    this.child.stderr.on('data', d => {
      this.stderr = (this.stderr + d.toString()).slice(-5000);
    });
    const fail = error => {
      this.ready = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.emit('offline', error.message);
    };
    this.child.on('error', e => {
      logProcessOutput('Codex', e.message);
      fail(new Error(NOT_INSTALLED));
    });
    this.child.on('exit', (code, signal) => {
      if (code || (signal && signal !== 'SIGTERM'))
        logProcessOutput('Codex', this.stderr, signal && 'signal ' + signal);
      fail(
        new Error(
          /Missing optional dependency/.test(this.stderr)
            ? NOT_INSTALLED
            : `Codex stopped (${code ?? signal}). Details are in the server log.`,
        ),
      );
    });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.method) {
        this.emit(m.id !== undefined ? 'request' : 'notification', m);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
    await this.request('initialize', {
      clientInfo: { name: 'stellarcortex_bots', title: 'StellarCortex', version: '0.1.5' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
    // The owner's own servers must not run beside a guest bot, and must not stop its chat either, so they start turned off.
    if (this.guestMode) {
      const effective = await this.request('config/read', { includeLayers: false }),
        enabled = Object.entries(effective.config?.mcp_servers || {})
          .filter(([, server]) => server.enabled !== false)
          .map(([name]) => name);
      if (enabled.length) {
        await this.stop();
        const stuck = enabled.filter(name => off.includes(name) || !/^[\w-]+$/.test(name));
        if (stuck.length)
          throw Error(
            'Codex cannot turn off the MCP server "' +
              stuck[0] +
              '". Rename it in the Codex config, using only letters, digits, _ and -.',
          );
        return this.boot([...off, ...enabled]);
      }
    }
    this.ready = true;
  }
  send(m) {
    if (!this.child?.stdin.writable) throw new Error('Codex is disconnected');
    this.child.stdin.write(JSON.stringify(m) + '\n');
  }
  request(method, params = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id, result) {
    this.send({ id, result });
  }
  reject(id, message) {
    this.send({ id, error: { code: -32601, message } });
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.ready = false;
    // EOF lets app-server dispose of tool processes before its wrapper exits.
    await new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once('exit', done);
      child.stdin.end();
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.on('exit', done);
          killer.on('error', done);
        } else {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            done();
          }, 1000).unref();
        }
      }, 4000);
    });
  }
}
