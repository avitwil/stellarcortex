import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../src/store.mjs';
import { Kanban } from '../src/kanban.mjs';
import { createSyntheticKanbanExecutor } from './helpers/kanban-synthetic.mjs';
const resources = () => ({ cores: 8, memory: 2 ** 33 });
function setup(
  t,
  { executor = createSyntheticKanbanExecutor({ delayMs: 0 }), mode = 'manual' } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-transitions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    k = new Kanban(store, { executor, resources }),
    bot = store.data.bots[0].id,
    p = k.createProject({ name: 'Synthetic project' });
  k.configure(p.id, {
    team: [bot],
    stages: Object.fromEntries(
      ['specification', 'development', 'testing', 'in-progress'].map(stage => [
        stage,
        { mode, botIds: [bot] },
      ]),
    ),
  });
  k.control(p.id, 'play');
  return { dir, store, k, p, bot };
}
const drain = k => Promise.all([...k.pending.values()]);
const event = (kind, evidence = 'Explicit simulated outcome') => ({
  synthetic: true,
  workflow: { kind, evidence, simulated: true },
});
function development(k, p) {
  const c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Feature' });
  k.move(c.id, 'specification');
  k.decide(k.requestDevelopment(c.id).id, true);
  return c;
}
test('project task starts directly from To Do, then explicit completion awaits user approval', async t => {
  let release;
  const f = setup(t, { executor: () => new Promise(r => (release = r)) }),
    { k, p } = f,
    c = k.createCard({ projectId: p.id, title: 'Task' }),
    entry = c.entryId,
    r = k.start(c.id, { entryId: entry });
  assert.equal(k.start(c.id, { entryId: entry }).id, r.id);
  await Promise.resolve();
  assert.equal(c.stage, 'in-progress');
  assert.equal(c.entryId, entry);
  release(event('task-completed'));
  await drain(k);
  assert.equal(c.stage, 'approval');
  assert(c.simulated);
  assert.equal(k.data.approvals.at(-1).status, 'pending');
  assert.equal(k.start(c.id, { entryId: entry }).id, r.id);
  assert.equal(k.data.runs.length, 1);
  const a = k.data.approvals.at(-1);
  k.decide(a.id, true);
  k.decide(a.id, false);
  assert.equal(c.stage, 'done');
});
test('idea entry never auto-starts; specification/development/final approval gates remain explicit', async t => {
  const { k, p } = setup(t, { mode: 'automatic' }),
    c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Idea' });
  await k.tick();
  assert.equal(k.data.runs.length, 0);
  await assert.rejects(async () => k.start(c.id, { automatic: true }), /Explicit/);
  k.start(c.id, { entryId: c.entryId });
  await drain(k);
  assert.equal(c.stage, 'specification');
  let a = k.data.approvals.at(-1);
  assert.equal(a.kind, 'development');
  await k.tick();
  assert.equal(k.data.runs.length, 1);
  assert.throws(() => k.move(c.id, 'development'), /approval/);
  k.decide(a.id, false, 'Refine specification');
  await k.tick();
  assert.equal(k.data.runs.length, 1);
  k.start(c.id, { entryId: c.entryId });
  await drain(k);
  a = k.data.approvals.at(-1);
  k.decide(a.id, true);
  await k.tick();
  await drain(k);
  assert.equal(c.stage, 'testing');
  await k.tick();
  await drain(k);
  assert.equal(c.stage, 'approval');
  await k.tick();
  assert.equal(c.stage, 'approval');
  k.decide(k.data.approvals.at(-1).id, true);
  assert.equal(c.stage, 'done');
});
test('failed validation records evidence and returns to development without an automatic retry loop', async t => {
  const { k, p } = setup(t, {
      executor: createSyntheticKanbanExecutor({
        delayMs: 0,
        validation: () => ({
          passed: false,
          evidence: 'Simulated failing check: expected value differs.',
        }),
      }),
      mode: 'automatic',
    }),
    c = development(k, p);
  k.start(c.id);
  await drain(k);
  assert.equal(c.stage, 'testing');
  await k.tick();
  await drain(k);
  assert.equal(c.stage, 'development');
  assert.equal(c.lastProgress.kind, 'validation-failed');
  assert.match(c.lastProgress.evidence, /expected value/);
  assert(c.requiresUserStart);
  const count = k.data.runs.length;
  await k.tick();
  assert.equal(k.data.runs.length, count);
  k.start(c.id, { entryId: c.entryId });
  await drain(k);
  assert.equal(c.stage, 'testing');
});
test('final rejection returns to work with review feedback and requires explicit restart', async t => {
  const { k, p } = setup(t, { mode: 'automatic' }),
    c = k.createCard({ projectId: p.id, title: 'Task' });
  k.start(c.id);
  await drain(k);
  k.decide(k.data.approvals.at(-1).id, false, 'Revise the result');
  assert.equal(c.stage, 'in-progress');
  assert.equal(c.feedback, 'Revise the result');
  await k.tick();
  assert.equal(k.data.runs.length, 1);
  k.start(c.id, { entryId: c.entryId });
  await drain(k);
  assert.equal(c.stage, 'approval');
});
test('semi-auto outcome waits for feedback and revision never advances development approval', async t => {
  const { k, p } = setup(t, { mode: 'semi' }),
    c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Idea' });
  k.start(c.id);
  await drain(k);
  assert.equal(c.stage, 'specification');
  assert.equal(k.data.approvals.length, 0);
  k.feedback(c.id, 'Prepare another draft', { continueWork: true });
  await k.tick();
  await drain(k);
  assert.equal(k.data.approvals.length, 0);
  k.feedback(c.id, 'Specification reviewed');
  assert.equal(k.data.approvals.at(-1).kind, 'development');
  assert.equal(c.stage, 'specification');
});
test('pause finishes one outcome and blocks next automatic stage; partial checkpoints do not advance', async t => {
  let release;
  const { k, p } = setup(t, {
      executor: () => new Promise(r => (release = r)),
      mode: 'automatic',
    }),
    c = development(k, p);
  k.start(c.id);
  await Promise.resolve();
  k.control(p.id, 'pause');
  release(event('development-completed'));
  await drain(k);
  assert.equal(c.stage, 'testing');
  assert.equal(p.control, 'paused');
  await k.tick();
  assert.equal(k.data.runs.length, 1);
  k.control(p.id, 'resume');
  k.start(c.id);
  await Promise.resolve();
  release({ yielded: true });
  await drain(k);
  assert.equal(c.stage, 'testing');
  const r = k.data.runs.at(-1);
  assert.equal(r.status, 'checkpointed');
  k.start(c.id, { entryId: c.entryId });
  await Promise.resolve();
  release(event('validation-passed'));
  await drain(k);
  assert.equal(c.stage, 'approval');
  assert.equal(k.data.runs.length, 2);
});
test('unverified text, malformed evidence, wrong-stage and stale outcomes cannot imply success', async t => {
  const { k, p } = setup(t, { executor: async () => ({ text: 'All done' }) }),
    c = k.createCard({ projectId: p.id, title: 'Legacy text' });
  k.start(c.id);
  await drain(k);
  assert.equal(c.stage, 'in-progress');
  assert.equal(k.data.approvals.length, 0);
  for (const result of [
    event('validation-passed'),
    event('task-completed', ''),
    {
      synthetic: true,
      workflow: { kind: 'task-completed', evidence: 'Not real', simulated: false },
    },
  ]) {
    k.executor = async () => result;
    const next = k.createCard({ projectId: p.id, title: 'Invalid' });
    k.start(next.id);
    await drain(k);
    assert.equal(next.stage, 'in-progress');
    assert.equal(k.data.runs.at(-1).status, 'uncertain');
  }
  let release;
  k.executor = () => new Promise(r => (release = r));
  const stale = k.createCard({ projectId: p.id, title: 'Stale' });
  k.start(stale.id);
  await Promise.resolve();
  stale.entryId = id();
  release(event('task-completed'));
  await drain(k);
  assert.equal(k.data.runs.at(-1).status, 'uncertain');
  assert.equal(k.data.approvals.length, 0);
});
test('restart never invents a result or replays uncertain execution', t => {
  const { k, p, store, dir, bot } = setup(t),
    c = k.createCard({ projectId: p.id, title: 'Interrupted' });
  c.stage = 'in-progress';
  k.data.runs.push({
    id: 'run',
    cardId: c.id,
    projectId: p.id,
    entryId: c.entryId,
    stage: c.stage,
    status: 'running',
    botIds: [bot],
    cores: 1,
    memory: 256 * 1024 * 1024,
  });
  store.save();
  let calls = 0;
  const recovered = new Kanban(new Store(dir), {
    executor: async () => {
      calls++;
      return event('task-completed');
    },
    resources,
  });
  const r = recovered.start(c.id, { entryId: c.entryId });
  assert.equal(r.status, 'uncertain');
  assert.equal(recovered.card(c.id).stage, 'in-progress');
  assert.equal(calls, 0);
  assert.equal(recovered.data.approvals.length, 0);
});
test('failed outcome persistence rolls back column/approval claims and retains uncertainty', async t => {
  let release;
  const { k, p, store, dir } = setup(t, { executor: () => new Promise(r => (release = r)) }),
    c = k.createCard({ projectId: p.id, title: 'Persist' });
  k.start(c.id);
  await Promise.resolve();
  const save = store.save.bind(store);
  store.save = () => {
    throw Error('Synthetic disk failure');
  };
  release(event('task-completed'));
  await drain(k);
  assert.equal(c.stage, 'in-progress');
  assert.equal(k.data.approvals.length, 0);
  assert.equal(k.data.runs.at(-1).status, 'uncertain');
  store.save = save;
  const recovered = new Kanban(new Store(dir));
  assert.equal(recovered.data.runs.at(-1).status, 'uncertain');
  assert.equal(recovered.card(c.id).stage, 'in-progress');
});
