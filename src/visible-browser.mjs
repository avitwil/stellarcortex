import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { browserTarget } from './browser.mjs';

export function browserSocket(dir, botId) {
  if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(botId))
    throw Error('Invalid browser identity');
  return path.join(
    dir,
    'browser-sockets',
    createHash('sha256').update(botId).digest('hex').slice(0, 20) + '.sock',
  );
}
export function browserRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '',
      finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () => finish(Error('Visible browser response lost; inspect before retrying')),
      35000,
    );
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(Error('Visible browser disconnected before reply')));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024)
        return finish(Error('Browser reply too large'));
      if (!buffer.includes('\n')) return;
      try {
        const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        reply.error
          ? finish(
              Object.assign(Error(reply.error), {
                rejectedBeforeEffects: reply.rejectedBeforeEffects === true,
              }),
            )
          : finish(null, reply.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

// This facade never launches a hidden browser. The session-owned process runs
// on the same DISPLAY and private D-Bus session as the visible desktop.
export class VisibleBrowserWorkspace {
  constructor(dir, desktop) {
    this.dir = dir;
    this.desktop = desktop;
    this.takeover = new Set();
  }
  async request(botId, request, { start = false } = {}) {
    const socket = browserSocket(this.dir, botId);
    if (start) {
      await this.desktop.snapshot(botId);
      for (let i = 0; i < 100 && !fs.existsSync(socket); i++)
        await new Promise(r => setTimeout(r, 100));
    }
    if (!fs.existsSync(socket))
      return { available: false, image: null, url: '', title: '', text: 'No browser is open.' };
    return browserRequest(socket, request);
  }
  async snapshot(botId) {
    return {
      ...(await this.request(botId, { method: 'snapshot' })),
      takeover: this.takeover.has(botId),
    };
  }
  async action(botId, args, manual = false) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw Object.assign(Error('Browser action arguments are required'), {
        rejectedBeforeEffects: true,
      });
    if (args.action !== 'read' && !manual && this.takeover.has(botId))
      throw Object.assign(Error('The user has control of this computer.'), {
        rejectedBeforeEffects: true,
      });
    if (!['open', 'read', 'click', 'fill', 'type', 'key', 'scroll'].includes(args.action))
      throw Object.assign(Error('Unknown browser action'), { rejectedBeforeEffects: true });
    if (args.action === 'open')
      try {
        await browserTarget(args.url);
      } catch (error) {
        error.rejectedBeforeEffects = true;
        throw error;
      }
    return this.request(botId, { method: 'action', args }, { start: args.action !== 'read' });
  }
  async loginTarget(botId) {
    const facts = await this.request(botId, { method: 'login-status' });
    return facts.origin || facts.status ? facts : { status: 'no-field' };
  }
  async deliverLogin(botId, target, secret) {
    const result = await this.request(botId, { method: 'login', target, secret });
    return result.status ? result : { status: 'failed', passwordFieldStillShown: false };
  }
  async close() {} // Desktop session lifetime owns the visible browser process.
}
