import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { GuestExecution } from '../src/guest-execution.mjs';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
import { desktopEngineExecution } from '../src/desktop-engine-adapter.mjs';
class Fake extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.ready = false;
  }
  async start() {
    this.ready = true;
  }
  async stop() {}
  async request(method) {
    this.calls.push(method);
    throw Error('No inference in fixture');
  }
}
const guest = () =>
  new GuestExecution(
    { generation: 'new-generation', call: async () => ({ available: true }), uncertain: new Set() },
    { enabled: true, providerIsolation: { codex: true } },
  );
test('startup has no migration pause and preserves the old acknowledgement file unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-normal-admission-'));
  const file = path.join(dir, 'guest-migration-review.json'),
    prior = '{"generation":"old-generation","reviewedAt":"historical"}';
  fs.writeFileSync(file, prior, { mode: 0o600 });
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Fake(),
    claudeRuntime: new Fake(),
    guestExecution: guest(),
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(app.engine.maintenance, false);
  assert.equal(fs.readFileSync(file, 'utf8'), prior);
  assert.equal(app.store.data.jobs.length, 0);
  const base = 'http://127.0.0.1:' + app.port,
    login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'x-stellarcortex-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ key: app.accessKey }),
    }),
    cookie = login.headers.get('set-cookie').split(';')[0];
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
  assert.equal(state.guestAdmissionPaused, false);
  const retired = await fetch(base + '/api/guest/activate', {
    method: 'POST',
    headers: { cookie, 'x-stellarcortex-client': '1', 'content-type': 'application/json' },
    body: '{"confirm":true}',
  });
  assert.equal(retired.status, 410);
  assert.equal(fs.readFileSync(file, 'utf8'), prior);
});
test('managed software-update boot probe remains separate from normal admission', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-boot-probe-')),
    runtime = new Fake(),
    app = await createApp({
      dataDir: dir,
      port: 0,
      startEngine: false,
      bootProbe: true,
      runtime,
      claudeRuntime: new Fake(),
      guestExecution: guest(),
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(app.engine.maintenance, true);
  app.activate();
  assert.equal(app.engine.maintenance, false);
  await new Promise(r => setImmediate(r));
  assert.equal(app.store.data.jobs.length, 0);
  assert.deepEqual(
    runtime.calls.filter(method => /^(thread|turn)\//.test(method)),
    [],
  );
});
test('new-provider health admits chat and observation while preserving a specific uncertain effect', async () => {
  const scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'one' },
    calls = [];
  const provider = new DesktopProviderRuntime({
    enabled: true,
    records: [scope],
    broker: {
      status: async () => ({ state: 'running' }),
      guest: async input => {
        calls.push(input.method);
        if (input.method === 'execution.ping')
          return { available: true, uncertainRequests: ['existing-uncertain'] };
        if (input.method === 'browser.read') return { title: 'Existing page' };
        throw Error('This VM has an unresolved operation');
      },
    },
  });
  const execution = desktopEngineExecution(provider, {
    accountId: 'owner',
    isolation: { enabled: true, providerIsolation: { codex: true } },
  });
  execution.assertReady('codex');
  const health = await execution.health('bot');
  assert.deepEqual(health.uncertainRequests, ['existing-uncertain']);
  assert.deepEqual(await execution.browser.action('bot', { action: 'read' }), {
    title: 'Existing page',
  });
  await assert.rejects(
    provider.agent(scope, 'desktop.type', { text: 'must not run' }),
    /unresolved/,
  );
  assert.deepEqual(calls, ['execution.ping', 'browser.read', 'desktop.type']);
  assert.equal(execution.admissionPaused, false);
});
