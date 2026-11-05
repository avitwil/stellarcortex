import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Kanban } from '../src/kanban.mjs';
import { createApp } from '../src/server.mjs';
import { acquireLock } from '../src/lock.mjs';

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-kanban-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    kanban = new Kanban(store, { resources: () => ({ cores: 1, memory: 2 ** 30 }), ...options });
  return { dir, store, kanban, bot: store.data.bots[0].id };
}
function configured(kanban, bot, { mode = 'manual', title = 'Review task' } = {}) {
  const project = kanban.createProject({ name: 'Review project' });
  kanban.configure(project.id, { team: [bot], stages: { 'in-progress': { mode, botIds: [bot] } } });
  const card = kanban.createCard({ projectId: project.id, title });
  kanban.move(card.id, 'in-progress');
  kanban.control(project.id, 'play');
  return { project, card };
}
const drain = kanban => Promise.all([...kanban.pending.values()]);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('invalid semi feedback leaves the persisted feedback gate intact', async t => {
  const { kanban, dir, bot } = fixture(t, { executor: async () => 'Prepared review' });
  const { card } = configured(kanban, bot, { mode: 'semi' }),
    run = kanban.start(card.id);
  await drain(kanban);
  assert.equal(run.status, 'feedback');
  for (const invalid of ['', '   ', 'x'.repeat(12001)]) {
    assert.throws(() => kanban.feedback(card.id, invalid), /Feedback/);
    assert.equal(run.status, 'feedback');
    assert.equal(card.feedback, null);
    assert.throws(() => kanban.move(card.id, 'approval'), /Finish|feedback|reconcile/i);
  }
  // A later unrelated save must not persist a partially applied rejected request.
  kanban.createCard({ title: 'Unrelated save' });
  const recovered = new Kanban(new Store(dir));
  assert.equal(recovered.data.runs.find(r => r.id === run.id).status, 'feedback');
});

test('team-only removal cannot leave executable assignments outside the project team', t => {
  const { kanban, bot } = fixture(t, { executor: async () => 'Unexpected execution' });
  const { project } = configured(kanban, bot);
  assert.throws(() => kanban.configure(project.id, { team: [] }), /team|assignment|configuration/i);
  assert.deepEqual(project.team, [bot]);
  assert.deepEqual(project.stages['in-progress'].botIds, [bot]);
});

test('reconciliation retry requires an explicit boolean and rejects invalid requests atomically', async t => {
  const { kanban, bot } = fixture(t, {
    executor: async () => {
      throw Error('Uncertain submitted effect');
    },
  });
  const { card } = configured(kanban, bot),
    run = kanban.start(card.id);
  await drain(kanban);
  const entry = card.entryId;
  for (const retry of ['false', 'true', 1, null, {}]) {
    assert.throws(
      () => kanban.reconcile(run.id, { checkpoint: 'Reviewed effects', retry }),
      /boolean|retry/i,
    );
    assert.equal(run.status, 'uncertain');
    assert.equal(card.entryId, entry);
  }
  kanban.reconcile(run.id, { checkpoint: 'Confirmed no effect remains', retry: false });
  assert.equal(run.status, 'reconciled');
  assert.notEqual(card.entryId, entry);
  assert.equal(card.requiresUserStart, true);
});

test('uncertain work retains admission reservations and never reports safely paused', async t => {
  const { kanban, bot } = fixture(t, {
    executor: async () => {
      throw Error('Provider outcome unknown');
    },
  });
  const { project, card } = configured(kanban, bot),
    run = kanban.start(card.id);
  await drain(kanban);
  kanban.control(project.id, 'pause');
  assert.equal(project.control, 'needs-reconciliation');
  const other = kanban.createCard({ title: 'Other scope', botIds: [bot] });
  kanban.move(other.id, 'in-progress');
  assert.throws(() => kanban.start(other.id), /Insufficient|uncertain|reconcil/i);
  kanban.reconcile(run.id, {
    checkpoint: 'Reviewed actual effects; unit no longer running',
    retry: false,
  });
  assert.equal(project.control, 'paused');
  kanban.executor = async () => 'Safe other scope';
  kanban.start(other.id);
  await drain(kanban);
});

test('restart preserves uncertainty reservations until reconciliation', t => {
  const { kanban, store, dir, bot } = fixture(t, { executor: async () => 'unused' });
  const { project, card } = configured(kanban, bot);
  store.data.kanban.runs.push({
    id: 'persisted-in-flight',
    cardId: card.id,
    projectId: project.id,
    entryId: card.entryId,
    status: 'running',
    botIds: [bot],
    mode: 'manual',
    cores: 1,
    memory: 256 * 1024 * 1024,
    checkpoint: null,
  });
  kanban.control(project.id, 'pause');
  const recovered = new Kanban(new Store(dir), {
    executor: async () => 'Must not start',
    resources: () => ({ cores: 1, memory: 2 ** 30 }),
  });
  assert.equal(recovered.project(project.id).control, 'needs-reconciliation');
  const other = recovered.createCard({ title: 'Other task', botIds: [bot] });
  recovered.move(other.id, 'in-progress');
  assert.throws(() => recovered.start(other.id), /Insufficient|uncertain|reconcil/i);
  assert.equal(recovered.data.runs.length, 1);
});

test('Kanban close prevents new admissions and waits for bounded-unit completion', async t => {
  let release;
  const { kanban, bot } = fixture(t, {
    executor: () => new Promise(resolve => (release = resolve)),
  });
  const { card } = configured(kanban, bot),
    run = kanban.start(card.id);
  await Promise.resolve();
  let closed = false;
  const closing = kanban.close().then(() => {
    closed = true;
  });
  await nextTurn();
  assert.equal(closed, false);
  const other = kanban.createCard({ title: 'Must not enter', botIds: [bot] });
  kanban.move(other.id, 'in-progress');
  assert.throws(() => kanban.start(other.id), /clos|shut|stopp/i);
  release('Final checkpoint');
  await closing;
  assert.equal(run.status, 'completed');
  assert.ok(run.checkpoint);
});

class FakeRuntime extends EventEmitter {
  async start() {}
  async request() {
    return {};
  }
  stop() {}
}
test('server shutdown keeps the installation lock until Kanban units drain', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-kanban-shutdown-'));
  let release, app, closing;
  t.after(async () => {
    release?.('Cleanup checkpoint');
    await closing;
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  app = await createApp({
    dataDir: dir,
    host: '127.0.0.1',
    port: 0,
    startEngine: false,
    runtime: new FakeRuntime(),
    claudeRuntime: new FakeRuntime(),
    kanbanExecutor: () => new Promise(resolve => (release = resolve)),
    kanbanResources: () => ({ cores: 1, memory: 2 ** 30 }),
  });
  const { card } = configured(app.kanban, app.store.data.bots[0].id),
    run = app.kanban.start(card.id);
  await Promise.resolve();
  let closed = false;
  closing = app.close().then(() => {
    closed = true;
  });
  await nextTurn();
  assert.equal(closed, false);
  assert.throws(() => acquireLock(dir), /Another StellarCortex process/);
  release('Shutdown checkpoint');
  await closing;
  assert.ok(run.checkpoint);
  const unlock = acquireLock(dir);
  unlock();
});

test('nonserializable results and failed persistence retain uncertainty without unhandled rejection', async t => {
  const { kanban, store, dir, bot } = fixture(t, { executor: async () => 1n });
  const { project, card } = configured(kanban, bot),
    run = kanban.start(card.id);
  await drain(kanban);
  assert.equal(run.status, 'uncertain');
  assert.equal(project.control, 'needs-reconciliation');
  kanban.reconcile(run.id, { checkpoint: 'Synthetic no external effect', retry: true });
  kanban.executor = async () => 'checkpoint';
  const original = store.save.bind(store);
  let saves = 0;
  store.save = () => {
    if (++saves > 1) throw Error('Synthetic disk full');
    return original();
  };
  kanban.start(card.id);
  await drain(kanban);
  assert.equal(run.status, 'uncertain');
  assert.match(run.error, /persistence/);
  store.save = original;
  const recovered = new Kanban(new Store(dir));
  assert.equal(recovered.data.runs[0].status, 'uncertain');
});

test('semi feedback can explicitly request another preparation round while preserving original user entry', async t => {
  const { kanban, bot } = fixture(t, {
    executor: async ({ card }) => ({ feedback: card.feedback }),
  });
  const { card } = configured(kanban, bot, { mode: 'semi' });
  card.initialText = 'Original idea';
  const first = kanban.start(card.id);
  await drain(kanban);
  assert.throws(() => kanban.feedback(card.id, 'Revise', { continueWork: 'true' }), /boolean/);
  kanban.feedback(card.id, 'Revise', { continueWork: true });
  assert.notEqual(card.entryId, first.entryId);
  await kanban.tick();
  await drain(kanban);
  assert.equal(kanban.data.runs.length, 2);
  assert.equal(kanban.data.runs[1].checkpoint.result.feedback, 'Revise');
  assert.equal(card.initialText, 'Original idea');
  assert.equal(first.feedback, 'Revise');
});

test('managed updates consider Kanban pending and uncertain work active', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-kanban-update-'));
  let release, activeSeen;
  const updates = {
    status: () => ({}),
    requestApply: async (_, context) => {
      activeSeen = context.active;
      return { ok: false, code: 'work-active' };
    },
  };
  const app = await createApp({
    dataDir: dir,
    host: '127.0.0.1',
    port: 0,
    startEngine: false,
    runtime: new FakeRuntime(),
    claudeRuntime: new FakeRuntime(),
    softwareUpdates: updates,
    kanbanExecutor: () => new Promise(r => (release = r)),
    kanbanResources: () => ({ cores: 1, memory: 2 ** 30 }),
  });
  t.after(async () => {
    release?.('cleanup');
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
      'Content-Type': 'application/json',
      'X-StellarCortex-Client': '1',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
  const { card } = configured(app.kanban, app.store.data.bots[0].id),
    run = app.kanban.start(card.id);
  await Promise.resolve();
  let res = await fetch(base + '/api/software-update/apply', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(res.status, 409);
  assert.equal(activeSeen, true);
  release('checkpoint');
  await drain(app.kanban);
  run.status = 'uncertain';
  app.store.save();
  res = await fetch(base + '/api/software-update/apply', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 409);
  assert.equal(activeSeen, true);
});
test('measured free capacity and total reservations are intersected without double subtraction', async t => {
  const releases = [];
  const { kanban, bot } = fixture(t, {
    resources: () => ({ cores: 2, totalCores: 4, memory: 2 ** 30, totalMemory: 2 ** 31 }),
    executor: () => new Promise(r => releases.push(r)),
  });
  for (let n = 0; n < 2; n++) {
    const c = kanban.createCard({ title: 'Capacity ' + n, botIds: [bot] });
    kanban.move(c.id, 'in-progress');
    kanban.start(c.id, { cores: 2, memory: 2 ** 30 });
  }
  await Promise.resolve();
  assert.equal(kanban.data.runs.length, 2);
  for (const release of releases) release('checkpoint');
  await drain(kanban);
});
test('admission persistence failure never leaves an ownerless running run or submits an executor', t => {
  let calls = 0;
  const { kanban, store, bot } = fixture(t, {
      executor: async () => {
        calls++;
      },
    }),
    { card } = configured(kanban, bot),
    save = store.save.bind(store);
  store.save = () => {
    throw Error('Synthetic admission disk failure');
  };
  assert.throws(() => kanban.start(card.id), /no executor submitted/);
  assert.equal(kanban.data.runs.length, 0);
  assert.equal(kanban.pending.size, 0);
  assert.equal(calls, 0);
  store.save = save;
});
