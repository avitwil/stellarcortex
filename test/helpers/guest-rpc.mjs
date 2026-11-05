// A test client for a real GuestWorker socket. Production talks to the guest through the broker.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
const passiveRPC = method =>
  method === 'execution.ping' ||
  method === 'browser.read' ||
  method.endsWith('.status') ||
  method.endsWith('.snapshot') ||
  ['demo.frame', 'files.list', 'files.read', 'files.inspect', 'files.chunk'].includes(method);
export class GuestRPC {
  constructor({ socketPath, vmId, generation, timeoutMs = 15000 }) {
    if (!socketPath?.startsWith('/') || !vmId || !generation)
      throw Error('Explicit private VM socket and generation required');
    Object.assign(this, { socketPath, vmId, generation, timeoutMs });
    this.uncertain = new Set();
    this.roster = new Map();
  }
  ensureBot(botId) {
    if (!this.roster.has(botId)) {
      const work = this.call('roster.register', botId, {}).catch(error => {
        this.roster.delete(botId);
        throw error;
      });
      this.roster.set(botId, work);
    }
    return this.roster.get(botId);
  }
  call(method, botId, args = {}, requestId = randomUUID()) {
    const manualRecovery =
      (['desktop.takeover', 'browser.takeover'].includes(method) &&
        typeof args.enabled === 'boolean') ||
      (['desktop.action', 'browser.action'].includes(method) && args.manual === true);
    if (
      this.uncertain.size &&
      !manualRecovery &&
      ![
        'demo.frame',
        'browser.read',
        'desktop.status',
        'desktop.snapshot',
        'browser.status',
        'browser.snapshot',
        'files.list',
        'files.read',
        'files.inspect',
        'files.chunk',
        'execution.status',
        'execution.cancel',
        'execution.ping',
        'execution.reconcile',
      ].includes(method)
    )
      return Promise.reject(Error('Guest effects uncertain; reconcile before more input'));
    const budget =
      method === 'shell.run' && Number.isInteger(args.timeoutMs)
        ? Math.max(this.timeoutMs, args.timeoutMs + 5000)
        : this.timeoutMs === 15000 &&
            (method.startsWith('desktop.') || method.startsWith('browser.'))
          ? 45000
          : this.timeoutMs;
    const request = {
      protocol: 'scx-guest-v1',
      vmId: this.vmId,
      generation: this.generation,
      requestId,
      method,
      botId,
      args,
    };
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 1024 * 1024) throw Error('Guest request too large');
    return new Promise((resolve, reject) => {
      let buffer = '',
        submitted = false,
        finished = false;
      const socket = net.createConnection(this.socketPath),
        done = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) {
            Object.assign(error, {
              guestRequestId: requestId,
              guestMethod: method,
              guestBotId: botId,
              guestSubmitted: submitted,
            });
            if (submitted && !passiveRPC(method)) this.uncertain.add(requestId);
            reject(error);
          } else resolve(value);
        };
      const send = () => {
        submitted = true;
        socket.write(payload + '\n');
      };
      const timer = setTimeout(
        () => done(Error('Guest RPC timeout; outcome may require reconciliation')),
        budget,
      );
      socket.on('connect', send);
      socket.on('error', e => done(Error('Guest channel unavailable: ' + e.code)));
      socket.on('end', () => done(Error('Guest closed before confirmed reply')));
      socket.on('data', chunk => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024)
          return done(Error('Guest reply too large'));
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const reply = JSON.parse(line);
            if (
              reply.protocol !== request.protocol ||
              reply.requestId !== requestId ||
              reply.vmId !== this.vmId ||
              reply.generation !== this.generation
            )
              return done(Error('Stale or mismatched guest reply'));
            if (reply.uncertain)
              return done(Error('Guest effect requires reconciliation; no automatic retry'));
            if (reply.error) {
              finished = true;
              clearTimeout(timer);
              socket.destroy();
              reject(
                Object.assign(Error(reply.error), {
                  guestRequestId: requestId,
                  guestMethod: method,
                  guestBotId: botId,
                  guestSubmitted: submitted,
                }),
              );
              return;
            }
            done(null, reply.result);
          } catch (e) {
            done(Error('Invalid guest reply'));
          }
        }
      });
    });
  }
  reconcile(requestId, note) {
    if (!note?.trim()) throw Error('Record actual guest effects first');
    this.uncertain.delete(requestId);
  }
}
