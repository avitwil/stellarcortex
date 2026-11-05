import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GuestDesktop } from './guest-desktop.mjs';
import { browserTarget } from './browser.mjs';
import { isCustomProvider } from './models.mjs';
export class GuestExecution {
  constructor(rpc, { enabled = false, providerIsolation = {} } = {}) {
    this.boundary = 'guest-desktop';
    this.rpc = rpc;
    this.enabled = enabled;
    this.providerIsolation = providerIsolation;
    this.desktop = new GuestDesktop(rpc, { enabled });
    this.browser = {
      snapshot: botId => rpc.call('browser.snapshot', botId),
      action: async (botId, input, manual = false) => {
        if (input.action === 'open') await browserTarget(input.url);
        return input.action === 'read'
          ? rpc.call('browser.read', botId)
          : rpc.call('browser.action', botId, { input, manual });
      },
      loginTarget: botId => rpc.call('browser.login.status', botId),
      deliverLogin: (botId, target, secret) =>
        rpc
          .call('browser.login', botId, { target }, undefined, secret)
          .catch(() => ({ status: 'failed', passwordFieldStillShown: false })),
      setTakeover: (botId, enabled) => rpc.call('browser.takeover', botId, { enabled }),
      close: async () => {},
    };
  }
  providerReady(provider) {
    return (
      this.enabled &&
      !this.rpc.uncertain?.size &&
      (this.providerIsolation[provider] ?? isCustomProvider(provider)) === true
    );
  }
  assertReady(provider) {
    if (this.rpc.uncertain?.size)
      throw Error('Guest effects require explicit review before new work; no automatic replay');
    if (!this.providerReady(provider))
      throw Error(
        this.problems?.[provider] ||
          'Provider is not verified for guest-only tools; no host fallback or task started',
      );
  }
  async health(botId) {
    await this.rpc.ensureBot?.(botId);
    const status = await this.rpc.call('execution.ping', botId);
    this.lastHealth = status;
    for (const id of status.uncertainRequests || []) this.rpc.uncertain?.add(id);
    if (this.rpc.uncertain?.size)
      throw Error('Guest effects require explicit review before new work');
    return status;
  }
  async reconcile(botId, requestId, note) {
    if (!note?.trim()) throw Error('Record actual guest effects before continuing');
    const result = await this.rpc.call('execution.reconcile', botId, { requestId, note });
    this.rpc.reconcile(requestId, note);
    return result;
  }
  async file(botId, args, requestId) {
    await this.rpc.ensureBot?.(botId);
    return this.rpc.call('files.' + args.action, botId, args, requestId);
  }
  async shell(botId, args, { signal } = {}) {
    await this.rpc.ensureBot?.(botId);
    if (signal?.aborted) throw Error('Task cancelled before guest dispatch');
    const requestId = randomUUID(),
      work = this.rpc.call('shell.run', botId, args, requestId),
      cancel = () => {
        this.rpc.call('execution.cancel', botId, { requestId }).catch(() => {});
      };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await work;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  async exportArtifact(botId, relative, { directory, approve, cancelled = () => false }) {
    await this.rpc.ensureBot?.(botId);
    const before = await this.rpc.call('files.inspect', botId, { path: relative });
    if (!before.exists) throw Error('Guest artifact not found');
    if (!(await approve(before))) throw Error('Guest artifact export declined');
    if (cancelled()) throw Error('Task stopped');
    const suffix = path
        .extname(relative)
        .slice(0, 15)
        .replace(/[^.A-Za-z0-9]/g, ''),
      name = randomUUID() + suffix;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, name),
      temporary = target + '.partial',
      digest = createHash('sha256');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      let offset = 0;
      while (offset < before.size) {
        if (cancelled()) throw Error('Task stopped');
        const reply = await this.rpc.call('files.chunk', botId, {
            path: relative,
            offset,
            length: Math.min(262144, before.size - offset),
            expectedSize: before.size,
          }),
          bytes = Buffer.from(reply.data, 'base64');
        if (!bytes.length || bytes.length > 262144) throw Error('Invalid guest artifact chunk');
        fs.writeSync(fd, bytes);
        digest.update(bytes);
        offset += bytes.length;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (digest.digest('hex') !== before.hash)
        throw Error('Guest artifact content changed after approval');
      fs.renameSync(temporary, target);
      return { file: target, size: before.size, hash: before.hash };
    } catch (error) {
      if (fd !== undefined && fd !== null) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }
}
