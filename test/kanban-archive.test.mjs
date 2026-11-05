import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Kanban } from '../src/kanban.mjs';
import { canArchiveCard, cardExecution } from '../public/kanban.js';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-trash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    k = new Kanban(store),
    bot = store.data.bots[0],
    c = k.createCard({ title: 'Keep history', text: 'Original', botIds: [bot.id] });
  return { dir, store, k, c };
}
test('removal is recoverable, idempotent and preserves agent, history, approvals and entry identity', t => {
  const { k, c, store, dir } = fixture(t),
    bots = structuredClone(store.data.bots),
    entry = c.entryId;
  k.comment(c.id, { requestId: 'one', text: 'Keep this comment' });
  k.data.approvals.push({
    id: 'pending',
    cardId: c.id,
    entryId: entry,
    status: 'pending',
    kind: 'final',
  });
  k.archiveCard(c.id);
  const at = c.archivedAt;
  k.archiveCard(c.id);
  assert.equal(c.archivedAt, at);
  assert.equal(c.entryId, entry);
  assert.throws(() => k.start(c.id), /Restore/);
  assert.throws(() => k.decide('pending', true), /Restore/);
  assert.equal(
    cardExecution({ ...k.data, executionEnabled: true }, c, store.data.bots).canRun,
    false,
  );
  const loaded = new Kanban(new Store(dir));
  assert(loaded.data.cards[0].archivedAt);
  loaded.restoreCard(c.id);
  loaded.restoreCard(c.id);
  assert.equal(loaded.card(c.id).comments[0].text, 'Keep this comment');
  assert.equal(loaded.card(c.id).entryId, entry);
  assert.equal(loaded.card(c.id).requiresUserStart, true);
  assert.equal(loaded.data.approvals[0].status, 'pending');
  assert.deepEqual(store.data.bots, bots);
});
test('active, paused checkpoint, feedback and uncertain runs cannot be orphaned by removal', t => {
  const { k, c } = fixture(t);
  for (const status of [
    'running',
    'pausing',
    'stopping',
    'checkpointed',
    'feedback',
    'uncertain',
  ]) {
    k.data.runs = [{ id: 'run', cardId: c.id, status }];
    assert.equal(canArchiveCard(k.data, c), false);
    assert.throws(() => k.archiveCard(c.id), /Stop and reconcile/);
    assert.equal(c.archivedAt, undefined);
  }
  k.data.runs = [{ id: 'run', cardId: c.id, status: 'completed' }];
  assert.equal(canArchiveCard(k.data, c), true);
});
test('queued or deferred engine jobs independently prevent removal', t => {
  const { k, c, store } = fixture(t);
  for (const status of ['queued', 'deferred', 'running', 'waiting']) {
    store.data.jobs = [{ id: 'job', workflowUnit: { cardId: c.id }, status }];
    assert.throws(() => k.archiveCard(c.id), /Stop and reconcile/);
    assert.equal(canArchiveCard({ ...k.data, engineJobs: store.data.jobs }, c), false);
  }
});
test('restoration does not dispatch automatic work and failed saves roll back removal metadata', async t => {
  const { k, c, store } = fixture(t);
  let calls = 0;
  k.executor = async () => {
    calls++;
  };
  const p = k.createProject({ name: 'Automatic board' });
  k.configure(p.id, {
    team: c.botIds,
    stages: { 'in-progress': { mode: 'automatic', botIds: c.botIds } },
  });
  c.projectId = p.id;
  k.control(p.id, 'play');
  k.archiveCard(c.id);
  await k.tick();
  assert.equal(calls, 0);
  k.restoreCard(c.id);
  await k.tick();
  assert.equal(calls, 0);
  const save = store.save.bind(store);
  store.save = () => {
    throw Error('disk');
  };
  assert.throws(() => k.archiveCard(c.id), /disk/);
  assert.equal(c.archivedAt, undefined);
  store.save = save;
  k.archiveCard(c.id);
  const at = c.archivedAt;
  store.save = () => {
    throw Error('disk');
  };
  assert.throws(() => k.restoreCard(c.id), /disk/);
  assert.equal(c.archivedAt, at);
});
test('manual follow-up in a linked task session also prevents orphaning work', t => {
  const { k, c, store } = fixture(t);
  store.data.chats.push({
    id: 'task-session',
    type: 'direct',
    botIds: c.botIds,
    kanbanCardId: c.id,
  });
  store.data.jobs.push({ id: 'followup', chatId: 'task-session', status: 'running' });
  assert.throws(() => k.archiveCard(c.id), /Stop and reconcile/);
  assert.equal(
    canArchiveCard({ ...k.data, taskSessionJobs: [{ cardId: c.id, status: 'running' }] }, c),
    false,
  );
});
