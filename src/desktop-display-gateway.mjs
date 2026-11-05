import { scopeKey } from './desktop-provider-session.mjs';
import { WebSocketServer } from 'ws';
import { authorizeDisplayUpgrade } from './desktop-display-auth.mjs';
import { DesktopTeachingInput } from './desktop-teaching-input.mjs';
import { RfbInputGate } from './desktop-rfb-gate.mjs';
// Deliberately not attached to the running application until provider approval.
// connectConsole(scope) is supplied by the scoped broker; no request can select
// a host path or TCP target. No listener is created by this constructor.
export class DesktopDisplayGateway {
  constructor({
    enabled = false,
    origins,
    authenticate,
    lookup,
    tickets,
    coordinator,
    connectConsole,
    recordTeachingInput = () => {},
  }) {
    Object.assign(this, {
      enabled,
      origins,
      authenticate,
      lookup,
      tickets,
      coordinator,
      connectConsole,
      recordTeachingInput,
    });
    this.connections = new Set();
    this.controllers = new Map();
    this.cleanups = new Map();
    this.pendingCleanup = new Set();
    this.cleanupFailures = [];
    this.websockets = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      handleProtocols: protocols => [...protocols][0],
    });
  }
  upgrade(req, socket, head) {
    let authorization;
    try {
      if (!this.enabled) throw Error('Desktop provider disabled');
      authorization = authorizeDisplayUpgrade(req, this);
      if (
        authorization.ticket.mode === 'control' &&
        !this.coordinator.canWrite(authorization.scope, authorization.ticket.lease)
      )
        throw Error('Control expired');
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.websockets.handleUpgrade(req, socket, head, ws => this.connect(ws, req, authorization));
  }
  async connect(ws, req, { scope, ticket }) {
    const controlKey = JSON.stringify(scope);
    if (ticket.mode === 'control' && this.controllers.has(controlKey)) {
      ws.close(1008, 'A controller is already connected');
      return;
    }
    if (ticket.mode === 'control') this.controllers.set(controlKey, ws);
    this.connections.add(ws);
    ws.pause();
    let upstream,
      closed = false,
      timer;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      upstream?.destroy();
      this.connections.delete(ws);
      if (this.controllers.get(controlKey) === ws) this.controllers.delete(controlKey);
      if (ticket.mode === 'control') {
        const work = this.coordinator.release(scope, ticket.lease);
        this.pendingCleanup.add(work);
        work
          .catch(error => this.cleanupFailures.push(error))
          .finally(() => this.pendingCleanup.delete(work));
      }
      this.cleanups.delete(ws);
    };
    this.cleanups.set(ws, cleanup);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    try {
      upstream = await this.connectConsole(scope, { mode: ticket.mode });
      if (closed) {
        upstream.destroy();
        return;
      }
      const stillAuthorized = () => {
        try {
          const identity = this.authenticate(req),
            current = this.lookup(scope.accountId, scope.botId);
          return (
            identity?.sessionId === ticket.sessionId &&
            current &&
            scopeKey({ ...current, accountId: scope.accountId, botId: scope.botId }) ===
              scopeKey(scope) &&
            current?.state === 'running'
          );
        } catch {
          return false;
        }
      };
      const teachingInput = new DesktopTeachingInput(event =>
        this.recordTeachingInput(scope, ticket.lease, event),
      );
      const gate = new RfbInputGate({
        onForwarded: bytes => teachingInput.push(bytes),
        canWrite: () =>
          stillAuthorized() &&
          ticket.mode === 'control' &&
          this.coordinator.canWrite(scope, ticket.lease),
        forward: bytes => {
          if (upstream.writableLength > 2 * 1024 * 1024)
            throw Error('Console input backpressure exceeded');
          upstream.write(bytes);
        },
      });
      ws.on('message', (bytes, binary) => {
        try {
          if (!binary || !stillAuthorized()) throw Error('Display authorization changed');
          gate.push(bytes);
        } catch {
          ws.close(1008, 'Display input rejected');
          cleanup();
        }
      });
      upstream.on('data', bytes => {
        if (ws.bufferedAmount > 16 * 1024 * 1024) {
          ws.close(1013, 'Display connection too slow');
          cleanup();
          return;
        }
        if (ws.readyState === 1) ws.send(bytes, { binary: true });
      });
      upstream.on('error', () => {
        ws.close(1011, 'Console unavailable');
        cleanup();
      });
      upstream.on('end', () => {
        ws.close(1000, 'Console disconnected');
        cleanup();
      });
      upstream.resume();
      ws.resume();
      timer = setInterval(() => {
        if (
          !stillAuthorized() ||
          (ticket.mode === 'control' && !this.coordinator.canWrite(scope, ticket.lease))
        ) {
          ws.close(1008, 'Display authorization expired');
          cleanup();
        }
      }, 1000);
      timer.unref();
    } catch {
      ws.close(1011, 'Console unavailable');
      cleanup();
    }
  }
  async close() {
    for (const ws of [...this.connections]) {
      this.cleanups.get(ws)?.();
      ws.terminate();
    }
    this.websockets.close();
    await Promise.allSettled([...this.pendingCleanup]);
    if (this.cleanupFailures.length)
      throw new AggregateError(this.cleanupFailures, 'Desktop input cleanup was not confirmed');
  }
}
