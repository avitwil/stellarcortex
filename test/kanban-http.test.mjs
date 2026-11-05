import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
class Fake extends EventEmitter {
  async start() {}
  async request() {
    return {};
  }
  stop() {}
}
test('authenticated workflow API persists boards without dispatching provider work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-kanban-http-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      startEngine: false,
      runtime: new Fake(),
      claudeRuntime: new Fake(),
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(base + '/api/kanban')).status, 401);
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
    body: JSON.stringify({ key: app.accessKey }),
  });
  const headers = {
    Cookie: login.headers.get('set-cookie').split(';')[0],
    'X-StellarCortex-Client': '1',
    'Content-Type': 'application/json',
  };
  const post = async body => {
    const res = await fetch(base + '/api/kanban', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const p = (await post({ action: 'project', name: 'Synthetic project' })).result;
  const c = (await post({ action: 'card', projectId: p.id, kind: 'idea', title: 'Feature' }))
    .result;
  assert.equal((await post({ action: 'move', cardId: c.id, stage: 'development' })).status, 400);
  await post({ action: 'move', cardId: c.id, stage: 'specification' });
  const a = (await post({ action: 'development', cardId: c.id })).result;
  assert.equal((await post({ action: 'decide', approvalId: a.id, accept: 'yes' })).status, 400);
  await post({ action: 'decide', approvalId: a.id, accept: true });
  const state = await (await fetch(base + '/api/kanban', { headers })).json();
  assert.equal(state.cards[0].stage, 'development');
  assert.equal(state.executionEnabled, false);
  assert.equal(state.runs.length, 0);
  assert.equal(app.store.data.jobs.length, 0);
  assert.equal((await post({ action: 'run', cardId: c.id })).status, 400);
  assert.equal(
    (
      await fetch(base + '/api/kanban', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
});
test('HTTP starts require an entry token and repeated old requests never run the next stage', async t => {
  const { createSyntheticKanbanExecutor } = await import('./helpers/kanban-synthetic.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-entry-http-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      startEngine: false,
      runtime: new Fake(),
      claudeRuntime: new Fake(),
      kanbanResources: () => ({ cores: 4, memory: 2 ** 31 }),
      kanbanExecutor: createSyntheticKanbanExecutor({ delayMs: 5 }),
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`,
    login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
      body: JSON.stringify({ key: app.accessKey }),
    }),
    headers = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      'X-StellarCortex-Client': '1',
      'Content-Type': 'application/json',
    };
  const c = app.kanban.createCard({ title: 'HTTP task', botIds: [app.store.data.bots[0].id] }),
    entryId = c.entryId,
    post = body =>
      fetch(base + '/api/kanban', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'run', cardId: c.id })).status, 400);
  const requests = await Promise.all([
    post({ action: 'run', cardId: c.id, entryId }),
    post({ action: 'run', cardId: c.id, entryId }),
  ]);
  assert(requests.every(r => r.status === 200));
  await Promise.all([...app.kanban.pending.values()]);
  assert.equal(c.stage, 'approval');
  assert.equal(app.kanban.data.runs.length, 1);
  assert.equal((await post({ action: 'run', cardId: c.id, entryId })).status, 200);
  assert.equal(c.stage, 'approval');
  assert.equal(app.kanban.data.runs.length, 1);
  const a = app.kanban.data.approvals.at(-1);
  await post({ action: 'decide', approvalId: a.id, accept: true });
  assert.equal(c.stage, 'done');
  await post({ action: 'run', cardId: c.id, entryId });
  assert.equal(c.stage, 'done');
  assert.equal(app.kanban.data.runs.length, 1);
  assert.equal(app.store.data.jobs.length, 0);
});
