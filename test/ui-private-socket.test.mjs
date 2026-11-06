import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
class Fake extends EventEmitter {
  ready = false;
  async start() {}
  async stop() {}
}
function request(
  app,
  socketPath,
  url,
  { method = 'GET', body, cookie, host, origin, forwardedHost, forwardedProto } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: url,
        method,
        headers: {
          host: host || `127.0.0.1:${app.port}`,
          ...(origin ? { origin } : {}),
          ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}),
          ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
          'x-stellarcortex-client': '1',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      res => {
        let data = '';
        res.on('data', b => (data += b));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
test(
  'a tailnet address set with no socket opens the socket',
  { skip: process.platform === 'win32' },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-ui-socket-')),
      saved = process.env.STELLARCORTEX_TAILNET_UI_URL;
    process.env.STELLARCORTEX_TAILNET_UI_URL = 'https://box.tail1.ts.net/';
    t.after(() => {
      if (saved === undefined) delete process.env.STELLARCORTEX_TAILNET_UI_URL;
      else process.env.STELLARCORTEX_TAILNET_UI_URL = saved;
    });
    const app = await createApp({
      dataDir: dir,
      port: 0,
      startEngine: false,
      runtime: new Fake(),
      claudeRuntime: new Fake(),
    });
    try {
      assert.equal(fs.statSync(path.join(dir, 'tailscale-ui.sock')).mode & 0o777, 0o600);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  'a sign-in over the tailnet gets a Secure cookie, and one on localhost does not',
  { skip: process.platform === 'win32' },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-ui-socket-')),
      socket = path.join(dir, 'tailscale-ui.sock'),
      host = 'synthetic.example.ts.net',
      app = await createApp({
        dataDir: dir,
        port: 0,
        startEngine: false,
        runtime: new Fake(),
        claudeRuntime: new Fake(),
        uiSocket: socket,
        trustedUiOrigin: 'https://' + host,
      });
    t.after(async () => {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const session = { method: 'POST', body: { key: app.accessKey } };
    const over = await request(app, socket, '/api/session', {
      ...session,
      host: 'localhost',
      forwardedHost: host,
      forwardedProto: 'https',
    });
    assert.match(over.headers['set-cookie'][0], /; Secure/);
    const local = await request(app, socket, '/api/session', session);
    assert.doesNotMatch(local.headers['set-cookie'][0], /; Secure/);
  },
);
test('private Tailnet upstream has0600 permissions and preserves application authentication', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-ui-socket-')),
    socket = path.join(dir, 'tailscale-ui.sock');
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Fake(),
    claudeRuntime: new Fake(),
    uiSocket: socket,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  assert.equal((await request(app, socket, '/api/state')).status, 401);
  assert.equal(
    (await request(app, socket, '/api/session', { method: 'POST', body: { key: 'invalid' } }))
      .status,
    401,
  );
  const auth = await request(app, socket, '/api/session', {
    method: 'POST',
    body: { key: app.accessKey },
  });
  assert.equal(auth.status, 200);
  const state = await request(app, socket, '/api/state', {
    cookie: auth.headers['set-cookie'][0].split(';')[0],
  });
  assert.equal(state.status, 200);
  assert.equal(state.data.bots[0].id, app.store.data.bots[0].id);
});

test('private Serve origin is exact, additive, and never bypasses Host/Origin or owner auth', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-ui-origin-')),
    socket = path.join(dir, 'tailscale-ui.sock'),
    host = 'synthetic.example.ts.net';
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Fake(),
    claudeRuntime: new Fake(),
    uiSocket: socket,
    trustedUiOrigin: 'https://' + host,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await request(app, socket, '/api/state', { host })).status, 401);
  assert.equal((await request(app, socket, '/api/state')).status, 401);
  assert.equal(
    (await request(app, socket, '/api/state', { host: 'unconfigured.example' })).status,
    403,
  );
  assert.equal(
    (
      await request(app, socket, '/api/session', {
        method: 'POST',
        host,
        origin: 'https://hostile.example',
        body: { key: app.accessKey },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app, socket, '/api/session', {
        method: 'POST',
        host,
        origin: 'https://' + host,
        body: { key: app.accessKey },
      })
    ).status,
    200,
  );
});

test('only private Unix Serve requests may use exact forwarded HTTPS origin', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-forwarded-origin-')),
    socket = path.join(dir, 'tailscale-ui.sock'),
    host = 'synthetic.example.ts.net';
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Fake(),
    claudeRuntime: new Fake(),
    uiSocket: socket,
    trustedUiOrigin: 'https://' + host,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const forwarded = { host: 'localhost', forwardedHost: host, forwardedProto: 'https' };
  assert.equal((await request(app, socket, '/api/state', forwarded)).status, 401);
  assert.equal(
    (await request(app, socket, '/api/state', { ...forwarded, forwardedHost: 'hostile.example' }))
      .status,
    403,
  );
  assert.equal(
    (await request(app, socket, '/api/state', { ...forwarded, forwardedProto: 'http' })).status,
    403,
  );
  assert.equal(
    (
      await request(app, socket, '/api/session', {
        ...forwarded,
        method: 'POST',
        origin: 'https://' + host,
        body: { key: app.accessKey },
      })
    ).status,
    200,
  );
  const status = await new Promise((resolve, reject) => {
    http
      .get(
        {
          host: '127.0.0.1',
          port: app.port,
          path: '/api/state',
          headers: { host: 'localhost', 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
        },
        res => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on('error', reject);
  });
  assert.equal(status, 403);
});
