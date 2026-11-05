import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import WebSocket from 'ws';
import { DesktopDisplayGateway } from '../src/desktop-display-gateway.mjs';
import { DesktopDisplayTickets } from '../src/desktop-display-auth.mjs';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
const scope = { accountId: 'owner', botId: 'a', vmId: 'vm-a', generation: 'one' },
  origin = 'https://app.example';
async function fixture(t) {
  let authenticated = true;
  const received = [],
    tickets = new DesktopDisplayTickets(),
    coordinator = new DesktopSessionCoordinator({ releaseInputs: async () => {} });
  const gateway = new DesktopDisplayGateway({
    enabled: true,
    origins: new Set([origin]),
    authenticate: req =>
      authenticated && req.headers.cookie === 'fixture=session'
        ? { accountId: 'owner', sessionId: 'session-a' }
        : null,
    lookup: () => ({ ...scope, state: 'running' }),
    tickets,
    coordinator,
    connectConsole: async () =>
      new Duplex({
        read() {},
        write(chunk, encoding, callback) {
          received.push(Buffer.from(chunk));
          callback();
        },
      }),
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => gateway.upgrade(req, socket, head));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await gateway.close();
    await new Promise(r => server.close(r));
  });
  return {
    received,
    tickets,
    coordinator,
    gateway,
    url: `ws://127.0.0.1:${server.address().port}/api/desktops/a/display`,
    revoke: () => (authenticated = false),
  };
}
async function connect(f, mode = 'view', lease = null) {
  const ticket = f.tickets.issue({ scope, sessionId: 'session-a', origin, mode, lease });
  const ws = new WebSocket(f.url, ticket.protocol, {
    origin,
    headers: { cookie: 'fixture=session' },
  });
  await once(ws, 'open');
  return ws;
}
const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]),
  key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]),
  read = Buffer.from([3, 1, 0, 0, 0, 0, 0, 10, 0, 10]);
const tick = () => new Promise(r => setTimeout(r, 30));
test('actual WebSocket viewer forwards framebuffer requests but cannot inject keys', async t => {
  const f = await fixture(t),
    ws = await connect(f);
  ws.send(Buffer.concat([handshake, key, read]));
  await tick();
  assert.equal(f.received.length, 4);
  assert.equal(f.received.at(-1)[0], 3);
  ws.close();
  await once(ws, 'close');
});
test('actual control connection loses write authority on release and session revocation', async t => {
  const f = await fixture(t),
    lease = await f.coordinator.claim(scope, 'session-a'),
    ws = await connect(f, 'control', lease);
  ws.send(Buffer.concat([handshake, key]));
  await tick();
  assert.equal(f.received.at(-1)[0], 4);
  await f.coordinator.release(scope, lease);
  const count = f.received.length;
  ws.send(key);
  await tick();
  assert.equal(f.received.length, count);
  f.revoke();
  ws.send(read);
  await once(ws, 'close');
  assert.equal(f.received.length, count);
});
test('disabled gateway rejects upgrade before connecting a console', async t => {
  const f = await fixture(t);
  f.gateway.enabled = false;
  const ticket = f.tickets.issue({ scope, sessionId: 'session-a', origin });
  const ws = new WebSocket(f.url, ticket.protocol, {
    origin,
    headers: { cookie: 'fixture=session' },
  });
  await assert.rejects(once(ws, 'open'), /403/);
  assert.equal(f.received.length, 0);
});
test('gateway shutdown waits for confirmed controller cleanup', async t => {
  const f = await fixture(t);
  let complete,
    called = false;
  f.coordinator.releaseInputs = () => {
    called = true;
    return new Promise(resolve => (complete = resolve));
  };
  const lease = await f.coordinator.claim(scope, 'session-a');
  await connect(f, 'control', lease);
  await tick();
  let finished = false;
  const closing = f.gateway.close().then(() => (finished = true));
  await tick();
  assert.equal(called, true);
  assert.equal(finished, false);
  complete();
  await closing;
  assert.equal(f.coordinator.observation(scope).mode, 'agent');
});
