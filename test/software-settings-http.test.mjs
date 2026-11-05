import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { SoftwareUpdates } from '../src/software-updates.mjs';
import { fakeSite, releaseKey, signedSite } from './helpers/signed-release.mjs';

class Runtime extends EventEmitter {
  async start() {
    this.ready = true;
  }
  async stop() {}
  async request() {
    throw new Error('No model calls expected');
  }
}
const old = 'a'.repeat(40),
  key = releaseKey();
async function fixture(t, { manager = null, bootProbe = false, site = signedSite(key) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-settings-http-'));
  const updates = new SoftwareUpdates({
    installed: { version: '0.1.0', commit: old, modified: false },
    manager,
    keys: [key.pinned],
    fetchImpl: site.call ? site : fakeSite(site),
  });
  const app = await createApp({
    dataDir: dir,
    port: 0,
    runtime: new Runtime(),
    claudeRuntime: new Runtime(),
    startEngine: false,
    bootProbe,
    softwareUpdates: updates,
  });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert(path.basename(dir).startsWith('stellar-settings-http-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`;
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'X-StellarCortex-Client': '1' },
    body: JSON.stringify({ key: app.accessKey }),
  });
  const headers = {
    'X-StellarCortex-Client': '1',
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie')?.split(';')[0] || '',
  };
  const api = async (route, input, method = input ? 'POST' : 'GET') => {
    const r = await fetch(base + route, {
      method,
      headers,
      body: input ? JSON.stringify(input) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  return { app, updates, base, api, headers, login };
}
test('permission and updater HTTP routes require authentication, same origin and client header', async t => {
  const f = await fixture(t);
  for (const route of [
    '/api/claude-permissions',
    '/api/software-update',
    '/api/software-update/check',
    '/api/software-update/apply',
  ])
    assert.equal((await fetch(f.base + route)).status, 401);
  assert.equal(
    (
      await fetch(f.base + '/api/claude-permissions', {
        method: 'PATCH',
        headers: { Cookie: f.headers.Cookie },
        body: '{"mode":"automatic"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.base + '/api/software-update/check', {
        method: 'POST',
        headers: { ...f.headers, Origin: 'https://evil.test' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.api('/api/software-update/check', { url: 'https://evil.test' })).status,
    400,
  );
  const bot = f.app.store.createBot({ name: 'Claude test', provider: 'claude' }).bot;
  assert.equal(
    (await f.api('/api/claude-permissions', { botId: bot.id, mode: 'free' }, 'PATCH')).status,
    400,
  );
  assert.equal(
    (await f.api('/api/claude-permissions', { botId: bot.id, mode: 'automatic' }, 'PATCH')).status,
    200,
  );
  assert.equal(f.app.store.bot(bot.id).claudePermissionMode, 'automatic');
  assert.equal(f.app.store.data.settings.claudePermissionMode, 'manual');
  await f.api('/api/software-update/check', {});
  assert.equal(
    (await f.api('/api/software-update/apply', { version: '0.2.0', confirm: false })).status,
    400,
  );
  const unsupported = await f.api('/api/software-update/apply', {
    version: '0.2.0',
    confirm: true,
  });
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.data.code, 'administrator-required');
  assert.equal(f.app.engine.maintenance, false);
});
test('no release, a rate limit or a lost connection is a normal answer that names the cause', async t => {
  for (const [site, cause] of [
    [async () => new Response('{}', { status: 404 }), /No release is published/],
    [
      async () => new Response('{}', { status: 403, headers: { 'retry-after': '720' } }),
      /rate limit.*12 minutes/,
    ],
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      /Could not reach|fetch failed/,
    ],
  ]) {
    const f = await fixture(t, { site }),
      checked = await f.api('/api/software-update/check', {});
    assert.equal(checked.status, 200);
    assert.match(checked.data.checkError, cause);
    assert.equal(checked.data.installed.version, '0.1.0');
  }
});
test('confirmed managed update rejects active work and duplicate clicks, then freezes mutations until restart', async t => {
  let release,
    started,
    commits = 0;
  const prepared = new Promise(resolve => {
    started = resolve;
  });
  const manager = {
    prepare: async () => {
      started();
      await new Promise(resolve => {
        release = resolve;
      });
    },
    commit: () => commits++,
  };
  const f = await fixture(t, { manager });
  await f.api('/api/software-update/check', {});
  f.app.store.data.jobs.push({ id: 'pending', status: 'queued' });
  const active = await f.api('/api/software-update/apply', { version: '0.2.0', confirm: true });
  assert.equal(active.data.code, 'work-active');
  assert.equal(f.app.engine.maintenance, false);
  f.app.store.data.jobs = [];
  const apply = f.api('/api/software-update/apply', { version: '0.2.0', confirm: true });
  await prepared;
  assert.equal(
    (await f.api('/api/software-update/apply', { version: '0.2.0', confirm: true })).status,
    409,
  );
  assert.equal((await f.api('/api/settings', { language: 'en' }, 'PATCH')).status, 503);
  assert.equal((await f.api('/hooks/anything', {})).status, 503);
  assert.throws(() => f.app.engine.enqueue('anything', 'task'), /maintenance/);
  release();
  assert.equal((await apply).status, 202);
  assert.equal(commits, 1);
  assert.equal(f.app.engine.maintenance, true);
});
test('failed preparation unlocks existing installation without shutdown or data mutation', async t => {
  const f = await fixture(t, {
    manager: {
      prepare: async () => {
        throw new Error('staging failed');
      },
      commit: () => assert.fail('must not activate'),
    },
  });
  await f.api('/api/software-update/check', {});
  assert.equal(
    (await f.api('/api/software-update/apply', { version: '0.2.0', confirm: true })).status,
    400,
  );
  assert.equal(f.app.engine.maintenance, false);
  assert.equal((await f.api('/api/settings', { language: 'en' }, 'PATCH')).status, 200);
});
test('candidate boot keeps task execution and mutations disabled until supervisor activation', async t => {
  const f = await fixture(t, { bootProbe: true });
  assert.equal(f.login.status, 503);
  assert.equal(f.app.engine.maintenance, true);
  assert.equal((await fetch(f.base + '/health')).status, 200);
  f.app.activate();
  assert.equal(f.app.engine.maintenance, false);
});
test('sending returns the stored message, so the page can show it with the event stream down', async t => {
  const f = await fixture(t),
    { chat } = f.app.store.createBot({ name: 'Send fixture' });
  const { status, data } = await f.api(`/api/chats/${chat.id}/messages`, { text: 'hello' });
  assert.equal(status, 202);
  assert.equal(data.message.text, 'hello');
  assert.equal(data.message.role, 'user');
  assert.equal(data.message.chatId, chat.id);
  assert.ok(f.app.store.data.messages.some(item => item.id === data.message.id));
});
