import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
class Offline extends EventEmitter {
  ready = false;
  async start() {}
  stop() {}
  async request() {
    return { account: null, data: [] };
  }
}
test('real app session authentication protects new desktop routes; provider is injectable but not enabled by default', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-provider-http-'));
  let expectedAccount,
    expectedBot,
    cleaned = 0;
  const setupCalls = [];
  const provider = {
    enabled: true,
    onboarding: async (account, bot, start) => {
      setupCalls.push({ account, bot, start });
      return { state: 'setup-required', message: 'Allocate this bot computer' };
    },
    coordinator: new DesktopSessionCoordinator({
      releaseInputs: async () => {
        cleaned++;
      },
    }),
    lookup: (account, bot) =>
      account === expectedAccount && bot === expectedBot
        ? { vmId: 'vm-a', generation: 'one', state: 'running' }
        : null,
    connectConsole: () => {
      throw Error('No VM provisioned in test');
    },
    lifecycle: {
      change: () => {
        throw Error('Provisioning not part of test');
      },
    },
  };
  const app = await createApp({
    dataDir: dir,
    port: 0,
    host: '127.0.0.1',
    startEngine: false,
    runtime: new Offline(),
    claudeRuntime: new Offline(),
    desktopProvider: provider,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.port;
  expectedBot = app.store.data.bots[0].id;
  const route = '/api/desktops/' + expectedBot;
  assert.equal((await fetch(base + route)).status, 401);
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-stellarcortex-client': '1' },
    body: JSON.stringify({ key: app.accessKey }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {
    cookie,
    'Content-Type': 'application/json',
    'X-StellarCortex-Client': '1',
    Origin: base,
  };
  expectedAccount = createHash('sha256')
    .update('android-owner-v1:' + app.accessKey)
    .digest('hex');
  const post = (suffix, body) =>
    fetch(base + route + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(base + route, { headers })).status, 200);
  assert.equal(
    (await (await fetch(base + route + '/setup', { headers })).json()).state,
    'setup-required',
  );
  assert.equal(setupCalls.at(-1).start, false);
  await post('/setup', {});
  assert.equal(setupCalls.at(-1).start, true);
  assert.equal(setupCalls.at(-1).account, expectedAccount);
  const ticket = await (await post('/ticket', { mode: 'view' })).json();
  assert.match(ticket.protocol, /^scx-display\./);
  assert.equal(
    (await post('/ticket', { mode: 'control', lease: { epoch: 9, sessionId: 'forged' } })).status,
    400,
  );
  const lease = await (await post('/control', { enabled: true })).json();
  assert(lease.connectionId);
  assert.equal((await post('/heartbeat', { lease })).status, 200);
  assert.equal(
    (
      await fetch(base + '/api/desktops/unregistered/ticket', {
        method: 'POST',
        headers,
        body: '{}',
      })
    ).status,
    404,
  );
  assert.equal((await post('/control', { enabled: false, lease })).status, 200);
  assert.equal(cleaned, 1);
  provider.enabled = false;
  assert.equal((await fetch(base + route, { headers })).status, 503);
  assert.equal(app.store.data.jobs.length, 0);
});
test('one bad desktop record cannot take down the app state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-provider-state-')),
    provider = {
      enabled: true,
      coordinator: new DesktopSessionCoordinator({ releaseInputs: async () => {} }),
      lookup: () => {
        throw Error('Bot desktop session has not been provisioned');
      },
      connectConsole: () => {
        throw Error('unused');
      },
    };
  const app = await createApp({
    dataDir: dir,
    port: 0,
    host: '127.0.0.1',
    startEngine: false,
    runtime: new Offline(),
    claudeRuntime: new Offline(),
    desktopProvider: provider,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.port;
  const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-stellarcortex-client': '1' },
      body: JSON.stringify({ key: app.accessKey }),
    }),
    state = await fetch(base + '/api/state', {
      headers: {
        cookie: login.headers.get('set-cookie').split(';')[0],
        'X-StellarCortex-Client': '1',
      },
    });
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).desktopProvider.bots, []);
});
