import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Store, due, markRun, safeFile } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { createApp } from '../src/server.mjs';
import { privateAddress } from '../src/browser.mjs';
import { acquireLock } from '../src/lock.mjs';

const tempDirs = [];
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-test-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) {
    const relative = path.relative(os.tmpdir(), dir);
    if (!relative.startsWith('stellarcortex-test-') || relative.includes(path.sep))
      throw new Error('Unsafe cleanup target');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const waitFor = async fn => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Condition not reached');
};
class FakeCodex extends EventEmitter {
  constructor() {
    super();
    this.ready = true;
    this.threads = 0;
    this.turns = 0;
    this.active = 0;
    this.peak = 0;
    this.calls = [];
  }
  async start() {
    this.ready = true;
  }
  async request(method, p) {
    this.calls.push({ method, p });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threads}` } };
    if (method === 'thread/resume') return { thread: { id: p.threadId } };
    if (method === 'turn/start') {
      const turnId = `turn-${++this.turns}`;
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      setTimeout(() => {
        this.emit('notification', {
          method: 'item/agentMessage/delta',
          params: { threadId: p.threadId, itemId: turnId, delta: 'A real event path' },
        });
        this.active--;
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } },
        });
      }, 30);
      return { turn: { id: turnId } };
    }
    return {};
  }
  stop() {
    this.ready = false;
  }
  respond() {}
}
test('store preserves data and flags interrupted tasks after a restart', t => {
  const dir = temp(t),
    s = new Store(dir),
    b = s.createBot({ name: 'Research', instructions: 'Find sources' });
  s.message(b.chat.id, 'user', 'Hello');
  s.data.jobs.push({ id: 'job', status: 'running' });
  s.save();
  const loaded = new Store(dir);
  assert.equal(loaded.data.bots.length, 2);
  assert.equal(loaded.data.messages[0].text, 'Hello');
  assert.equal(loaded.data.jobs[0].status, 'interrupted');
});
test('corrupt storage is reported and never silently reset', t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  assert.throws(() => new Store(dir));
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{broken');
});
test('a second process cannot mutate an active data directory', t => {
  const dir = temp(t),
    release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /Another StellarCortex process/);
  release();
  const next = acquireLock(dir);
  next();
});
test('daily schedules use the selected timezone and run only once per local date', t => {
  const s = new Store(temp(t)),
    r = s.createRoutine({
      botId: s.data.bots[0].id,
      name: 'Daily',
      prompt: 'Report',
      kind: 'daily',
      time: '09:00',
      timezone: 'Asia/Jerusalem',
    });
  const before = new Date('2026-10-26T06:59:00Z'),
    after = new Date('2026-10-26T07:00:00Z');
  assert.equal(due(r, before), false);
  assert.equal(due(r, after), true);
  markRun(r, after);
  assert.equal(due(r, new Date('2026-10-26T15:00:00Z')), false);
  assert.equal(due(r, new Date('2026-10-27T07:00:00Z')), true);
});
test('intervals do not backfill missed runs and reject invalid schedules', t => {
  const s = new Store(temp(t));
  assert.throws(() =>
    s.createRoutine({ botId: s.data.bots[0].id, name: 'Bad', prompt: 'x', minutes: 1 }),
  );
  const r = s.createRoutine({ botId: s.data.bots[0].id, name: 'Hourly', prompt: 'x', minutes: 60 });
  markRun(r, new Date('2026-10-26T07:00:00Z'));
  assert.equal(due(r, new Date('2026-10-26T07:59:00Z')), false);
  assert.equal(due(r, new Date('2026-10-26T10:00:00Z')), true);
  markRun(r, new Date('2026-10-26T10:00:00Z'));
  assert.equal(r.nextRun, '2026-10-26T11:00:00.000Z');
});
test('workspace path traversal and private browser destinations are rejected', t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'ok');
  assert.equal(safeFile(dir, 'file.txt'), path.join(dir, 'file.txt'));
  assert.throws(() => safeFile(dir, '../secret'));
  assert.throws(() => safeFile(dir, dir));
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.0.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])
    assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress('1.1.1.1'), false);
  assert.equal(privateAddress('2606:4700:4700::1111'), false);
});
test('engine streams messages, serializes one bot, and runs different bots concurrently', async t => {
  const s = new Store(temp(t)),
    c = new FakeCodex(),
    e = new Engine(s, c, { close: async () => {} });
  t.after(() => e.close());
  const first = s.data.chats[0],
    second = s.createBot({ name: 'Second' }).chat;
  e.enqueue(first.id, 'One');
  e.enqueue(first.id, 'Two');
  e.enqueue(second.id, 'Three');
  await waitFor(() => s.data.jobs.every(j => j.status === 'completed'));
  assert.equal(c.peak, 2);
  assert.equal(c.threads, 2);
  assert.equal(c.calls.filter(x => x.method === 'thread/resume').length, 1);
  assert.equal(s.data.messages.filter(m => m.role === 'assistant').length, 3);
});
test('API-key auth cannot silently switch to separately billed usage', async t => {
  const s = new Store(temp(t)),
    c = new FakeCodex();
  const original = c.request.bind(c);
  c.request = (m, p) =>
    m === 'account/read' ? Promise.resolve({ account: { type: 'apiKey' } }) : original(m, p);
  const e = new Engine(s, c, { close: async () => {} });
  t.after(() => e.close());
  e.enqueue(s.data.chats[0].id, 'Hello');
  await waitFor(() => s.data.jobs[0].status === 'failed');
  assert.equal(c.turns, 0);
  assert.match(s.data.jobs[0].error, /API-key billing is not used/);
});
test('approval denial resolves once and cannot be replayed', async t => {
  const s = new Store(temp(t)),
    e = new Engine(s, new FakeCodex(), { close: async () => {} });
  t.after(() => e.close());
  const job = { id: 'j', chatId: s.data.chats[0].id, botId: s.data.bots[0].id, status: 'running' };
  e.active.set(job.id, job);
  const result = e.approval(job, 'browser', { action: 'click' });
  assert.equal(job.status, 'waiting');
  const a = s.data.approvals[0];
  e.resolveApproval(a.id, { approve: false });
  assert.equal((await result).approve, false);
  assert.equal(a.status, 'denied');
  assert.throws(() => e.resolveApproval(a.id, { approve: true }));
  e.active.clear();
});
test('logout invalidates the server session: the old cookie is refused and its event stream ends', async t => {
  const app = await createApp({
    dataDir: temp(t),
    port: 0,
    runtime: new FakeCodex(),
    startEngine: false,
  });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`,
    client = { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' };
  const signIn = async () => ({
      ...client,
      Cookie: (
        await fetch(base + '/api/session', {
          method: 'POST',
          headers: client,
          body: JSON.stringify({ key: app.accessKey }),
        })
      ).headers
        .get('set-cookie')
        .split(';')[0],
    }),
    headers = await signIn(),
    other = await signIn();
  assert.equal((await fetch(base + '/api/state', { headers })).status, 200);
  const stream = await fetch(base + '/api/events', { headers }),
    otherStream = await fetch(base + '/api/events', { headers: other });
  t.after(() => otherStream.body.cancel().catch(() => {}));
  const logout = await fetch(base + '/api/logout', { method: 'POST', headers, body: '{}' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/state', { headers })).status, 401);
  assert.equal((await fetch(base + '/api/events', { headers })).status, 401);
  await Promise.race([
    stream.text(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Event stream stayed open after logout')), 2000).unref(),
    ),
  ]);
  assert.equal(
    (await fetch(base + '/api/state', { headers: other })).status,
    200,
    'other sessions stay signed in',
  );
});
test('clear conversation needs a session and refuses a chat with queued work', async t => {
  const app = await createApp({
    dataDir: temp(t),
    port: 0,
    runtime: new FakeCodex(),
    startEngine: false,
  });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`,
    client = { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
    chat = app.store.data.chats[0],
    url = `${base}/api/chats/${chat.id}/clear`;
  assert.equal((await fetch(url, { method: 'POST', headers: client, body: '{}' })).status, 401);
  const headers = {
    ...client,
    Cookie: (
      await fetch(base + '/api/session', {
        method: 'POST',
        headers: client,
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0],
  };
  app.store.message(chat.id, 'user', 'Old message');
  chat.externalContent = true;
  const job = { id: 'queued', chatId: chat.id, botId: chat.botIds[0], status: 'queued' };
  app.store.data.jobs.push(job);
  const refused = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Wait for the work/);
  assert.equal(chat.externalContent, true);
  job.status = 'completed';
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(chat.externalContent, undefined);
  assert.equal(
    app.store.data.messages.some(m => m.chatId === chat.id),
    false,
  );
});
test('continue in a new conversation needs a session, waits for queued work and resends the last owner message', async t => {
  const app = await createApp({
    dataDir: temp(t),
    port: 0,
    runtime: new FakeCodex(),
    startEngine: false,
  });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`,
    client = { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
    chat = app.store.data.chats[0],
    url = `${base}/api/chats/${chat.id}/continue`;
  assert.equal((await fetch(url, { method: 'POST', headers: client, body: '{}' })).status, 401);
  const headers = {
    ...client,
    Cookie: (
      await fetch(base + '/api/session', {
        method: 'POST',
        headers: client,
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0],
  };
  app.store.message(chat.id, 'user', 'Create a bot named Helper');
  chat.externalContent = true;
  const job = { id: 'queued', chatId: chat.id, botId: chat.botIds[0], status: 'queued' };
  app.store.data.jobs.push(job);
  const refused = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Wait for the work/);
  assert.equal(chat.externalContent, true);
  job.status = 'completed';
  const sent = await fetch(url, { method: 'POST', headers, body: '{}' });
  assert.equal(sent.status, 202);
  const { jobs } = await sent.json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].text, 'Create a bot named Helper');
  assert.equal(jobs[0].external, undefined);
  assert.equal(chat.externalContent, undefined);
  assert.equal(
    app.store.data.messages.filter(m => m.chatId === chat.id && m.role === 'user').length,
    2,
  );
});
test('HTTP blocks unauthenticated access, CSRF and hostile hosts; authenticated changes persist', async t => {
  const app = await createApp({
    dataDir: temp(t),
    port: 0,
    runtime: new FakeCodex(),
    startEngine: false,
  });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal(
    (
      await fetch(base + '/api/session', {
        method: 'POST',
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).status,
    403,
  );
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
    body: JSON.stringify({ key: app.accessKey }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {
    Cookie: cookie,
    'X-StellarCortex-Client': '1',
    'Content-Type': 'application/json',
  };
  assert.equal(
    (await fetch(base + '/api/state', { headers: { ...headers, Origin: 'https://evil.example' } }))
      .status,
    403,
  );
  const hostileStatus = await new Promise((resolve, reject) => {
    const req = http.get(
      base + '/api/state',
      { headers: { ...headers, Host: 'evil.example' } },
      res => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
  });
  assert.equal(hostileStatus, 403);
  const bot = await (
    await fetch(base + '/api/bots', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Tester' }),
    })
  ).json();
  assert.equal(bot.bot.name, 'Tester');
  const state = await (await fetch(base + '/api/state', { headers })).json();
  assert.equal(state.bots.length, 2);
  assert.equal(
    (
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ concurrency: 99 }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ design: 'nope' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await (
        await fetch(base + '/api/settings', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ design: 'observatory' }),
        })
      ).json()
    ).design,
    'observatory',
  );
  const output = await fetch(base + '/api/bots/' + bot.bot.id + '/template', { headers });
  const template = await output.json();
  assert.equal(template.format, 'stellarcortex-bot-template');
  assert.equal('memory' in template.bot, false);
  assert.equal(
    (await fetch(base + '/api/bots/' + bot.bot.id, { method: 'DELETE', headers })).status,
    200,
  );
  assert.equal((await fetch(base + '/api/browser/' + bot.bot.id, { headers })).status, 400);
  assert.equal(
    (
      await fetch(base + '/api/browser/' + bot.bot.id + '/takeover', {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: true }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + '/api/browser/' + bot.bot.id + '/action', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'read' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(base + '/api/bots/' + bot.bot.id + '/restore', { method: 'POST', headers }))
      .status,
    200,
  );
  assert.equal((await fetch(base + '/api/browser/' + bot.bot.id, { headers })).status, 200);
});
