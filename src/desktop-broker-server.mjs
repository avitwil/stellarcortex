import { connectSessionConsole } from './desktop-session-console.mjs';
import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { desktopScope, scopeKey, STOPPED_COMPUTER } from './desktop-provider-session.mjs';
// This listener belongs on a protected Unix socket, never a TCP endpoint.
export function createDesktopBrokerServer({
  broker,
  consoleRoot = '/run/stellarcortex-desktops',
  connect = path => net.createConnection({ path }),
  connectSession = connectSessionConsole,
}) {
  const controllers = new Map();
  const closeControllers = async scope => {
    const sockets = controllers.get(scopeKey(scope));
    if (!sockets) return;
    await Promise.all(
      [...sockets].map(
        socket =>
          new Promise(resolve => {
            if (socket.destroyed) return resolve();
            socket.once('close', resolve);
            socket.destroy();
          }),
      ),
    );
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) throw Error('Broker request too large');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/boot-policy') {
        if (!broker.bootPolicy) throw Error('Boot setting is not installed');
        if (Object.keys(input).some(key => key !== 'enabled'))
          throw Error('Only the boot setting can change here');
        return json(res, 200, broker.bootPolicy(input.enabled));
      }
      if (req.url === '/session-setup') {
        if (!broker.sessionSetup) throw Error('Environment session provisioning is not installed');
        return json(
          res,
          200,
          await broker.sessionSetup(
            input.accountId,
            input.environmentId,
            input.botId,
            input.start === true,
          ),
        );
      }
      if (req.url === '/session-remove') {
        if (!broker.sessionRemove) throw Error('Environment session provisioning is not installed');
        return json(
          res,
          200,
          await broker.sessionRemove(input.accountId, input.environmentId, input.botId),
        );
      }
      if (req.url === '/computer-build') {
        if (!broker.computerBuild) throw Error('Computer setup is not configured');
        if (Object.keys(input).some(key => key !== 'retry'))
          throw Error('Only Retry can be asked for here');
        return json(res, 200, broker.computerBuild(input.retry === true));
      }
      if (req.url === '/computer-stop') {
        if (!broker.computerStop) throw Error('Computer setup is not configured');
        if (Object.keys(input).length) throw Error('Stopping takes no settings');
        return json(res, 200, broker.computerStop());
      }
      if (req.url === '/kit-update') {
        if (!broker.kitUpdate) throw Error('Root updates are not installed');
        if (Object.keys(input).some(key => key !== 'version'))
          throw Error('Only a version can be asked for here');
        return json(res, 200, broker.kitUpdate(input.version));
      }
      desktopScope(input.scope);
      let result;
      if (req.url === '/status') result = await broker.status(input.scope);
      else if (req.url === '/capture') result = await broker.capture(input.scope);
      else if (req.url === '/release') {
        await closeControllers(input.scope);
        result = await broker.release(input);
      } else if (req.url === '/operations') result = await broker.operations(input.scope);
      else if (req.url === '/cancel') result = await broker.cancel(input);
      else if (req.url === '/review') result = await broker.review(input);
      else if (req.url === '/guest') result = await broker.guest(input);
      else if (req.url === '/input') result = await broker.input(input);
      else if (req.url === '/lifecycle') result = await broker.change(input);
      else return json(res, 404, { error: 'Unsupported broker operation' });
      json(res, 200, result);
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    let upstream;
    try {
      if (
        req.method !== 'GET' ||
        req.url !== '/console' ||
        req.headers.upgrade !== 'scx-console' ||
        head.length
      )
        throw Error('Unsupported console upgrade');
      const encoded = req.headers['x-scx-scope'];
      if (typeof encoded !== 'string' || encoded.length > 2048) throw Error('Scope required');
      const scope = desktopScope(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))),
        r = await broker.checked(scope);
      const status = await broker.status(scope);
      if (status.state !== 'running') throw Error(STOPPED_COMPUTER);
      // Domain is checked against a registry, not a client-selected path.
      if (!/^scx-desktop-[A-Za-z0-9_-]{1,128}$/.test(r.domain)) throw Error('Invalid domain');
      const mode = req.headers['x-scx-mode'] || 'view';
      if (!['view', 'control'].includes(mode)) throw Error('Invalid console mode');
      upstream = r.sessionId ? connectSession(r) : connect(`${consoleRoot}/${r.domain}/vnc.sock`);
      if (mode === 'control') {
        const key = scopeKey(scope);
        if (!controllers.has(key)) controllers.set(key, new Set());
        controllers.get(key).add(upstream);
        upstream.once('close', () => {
          const set = controllers.get(key);
          set?.delete(upstream);
          if (!set?.size) controllers.delete(key);
        });
      }
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: scx-console\r\n\r\n',
        );
        pipeline(socket, upstream, () => {});
        pipeline(upstream, socket, () => {});
      });
    } catch {
      upstream?.destroy();
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  return server;
}
export function createDesktopBrokerClient(socketPath) {
  const request = (operation, input) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(input),
        req = http.request(
          {
            socketPath,
            path: operation,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
            },
          },
          res => {
            const parts = [];
            let size = 0;
            res.on('data', chunk => {
              size += chunk.length;
              if (size > 24 * 1024 * 1024) res.destroy(Error('Broker response exceeds limit'));
              else parts.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
              try {
                const value = JSON.parse(Buffer.concat(parts));
                if (res.statusCode !== 200) throw Error(value.error || 'Broker rejected request');
                resolve(value);
              } catch (e) {
                reject(e);
              }
            });
          },
        );
      req.setTimeout(
        operation === '/guest'
          ? Math.max(50000, Math.min(3610000, (input.args?.timeoutMs || 0) + 10000))
          : 20000,
        () => req.destroy(Error('Broker response timed out; operation outcome may be uncertain')),
      );
      req.on('error', reject);
      req.end(data);
    });
  return {
    kitUpdate: version => request('/kit-update', version === undefined ? {} : { version }),
    bootPolicy: enabled => request('/boot-policy', enabled === undefined ? {} : { enabled }),
    sessionSetup: (accountId, environmentId, botId, start = false) =>
      request('/session-setup', { accountId, environmentId, botId, start }),
    sessionRemove: (accountId, environmentId, botId) =>
      request('/session-remove', { accountId, environmentId, botId }),
    computerBuild: (retry = false) => request('/computer-build', { retry }),
    operations: scope => request('/operations', { scope }),
    cancel: input => request('/cancel', input),
    review: input => request('/review', input),
    release: input => request('/release', input),
    guest: input => request('/guest', input),
    status: scope => request('/status', { scope }),
    capture: scope => request('/capture', { scope }),
    input: input => request('/input', input),
    change: input => request('/lifecycle', input),
    connectConsole: (scope, { mode = 'view' } = {}) =>
      new Promise((resolve, reject) => {
        desktopScope(scope);
        const req = http.request({
          socketPath,
          path: '/console',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'scx-console',
            'X-Scx-Mode': mode,
            'X-Scx-Scope': Buffer.from(JSON.stringify(scope)).toString('base64url'),
          },
        });
        req.on('upgrade', (_res, socket, head) => {
          socket.pause();
          socket.setTimeout(0);
          if (head.length) socket.unshift(head);
          resolve(socket);
        });
        req.on('response', res => {
          res.resume();
          reject(Error('Console authorization rejected'));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(Error('Console connection timed out')));
        req.end();
      }),
  };
}
