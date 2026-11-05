import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Kanban } from '../src/kanban.mjs';
function fixture(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-kanban-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    k = new Kanban(store, { resources: () => ({ cores: 2, memory: 2 ** 30 }), ...opts }),
    bot = store.data.bots[0].id;
  return { dir, store, k, bot };
}
function project(k, bot, mode = 'manual') {
  const p = k.createProject({ name: 'Persistent project' });
  k.configure(p.id, {
    team: [bot],
    stages: Object.fromEntries(
      ['specification', 'development', 'testing', 'in-progress'].map(stage => [
        stage,
        { mode, botIds: [bot] },
      ]),
    ),
  });
  return p;
}
const drain = async k => Promise.all([...k.pending.values()]);
test('general tasks and persistent projects keep independent boards and linked sessions', t => {
  const { k, dir } = fixture(t),
    p = k.createProject({ name: 'One' }),
    c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Feature', text: 'Original idea' }),
    g = k.createCard({ title: 'Maintenance' }),
    s = k.session(p.id, { name: 'Discussion', cardId: c.id });
  k.discuss(s.id, { text: 'Separate follow-up' });
  assert.equal(c.stage, 'idea');
  assert.equal(g.projectId, null);
  assert.equal(c.initialText, 'Original idea');
  assert.throws(
    () => k.session(k.createProject({ name: 'Other' }).id, { name: 'wrong', cardId: c.id }),
    /another project/,
  );
  const loaded = new Kanban(new Store(dir));
  assert.equal(loaded.data.sessions[0].messages[0].text, 'Separate follow-up');
  assert.equal(loaded.data.projects.length, 2);
});
test('approval gates cannot be bypassed by automatic stages or repeated decisions', async t => {
  let calls = 0;
  const { k, bot } = fixture(t, {
      executor: async () => {
        calls++;
        return 'Prepared';
      },
    }),
    p = project(k, bot, 'automatic'),
    c = k.createCard({ projectId: p.id, kind: 'idea', title: 'New idea' });
  k.control(p.id, 'play');
  await k.tick();
  assert.equal(calls, 0);
  k.move(c.id, 'specification');
  await k.tick();
  await drain(k);
  assert.equal(calls, 1);
  await k.tick();
  assert.equal(calls, 1);
  assert.throws(() => k.move(c.id, 'development'), /approval/);
  const a = k.requestDevelopment(c.id);
  assert.equal(k.requestDevelopment(c.id).id, a.id);
  k.decide(a.id, true);
  k.decide(a.id, false);
  assert.equal(c.stage, 'development');
  await k.tick();
  await drain(k);
  assert.equal(calls, 2);
  k.move(c.id, 'testing');
  await k.tick();
  await drain(k);
  k.move(c.id, 'approval');
  assert.throws(() => k.move(c.id, 'done'), /approval/);
  const final = k.data.approvals.at(-1);
  k.decide(final.id, false, 'Fix');
  assert.equal(c.stage, 'development');
  assert.equal(p.lifecycle, 'active');
});
test('manual Run deduplicates repeated clicks and semi preparation awaits feedback', async t => {
  let release,
    calls = 0;
  const { k, bot } = fixture(t, {
      executor: () => {
        calls++;
        return new Promise(r => (release = r));
      },
    }),
    p = project(k, bot, 'semi'),
    c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Plan' });
  k.move(c.id, 'specification');
  k.control(p.id, 'play');
  const r = k.start(c.id);
  assert.equal(k.start(c.id).id, r.id);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.throws(() => k.requestDevelopment(c.id), /Finish/);
  release('Draft');
  await drain(k);
  assert.equal(r.status, 'feedback');
  await k.tick();
  assert.equal(calls, 1);
  k.feedback(c.id, 'Revise detail');
  assert.equal(r.status, 'completed');
  assert.equal(c.feedback, 'Revise detail');
  assert.equal(c.initialText, '');
});
test('pause drains bounded work, checkpoints, and resume never duplicates submitted effects', async t => {
  let release;
  const { k, bot } = fixture(t, { executor: () => new Promise(r => (release = r)) }),
    p = project(k, bot),
    c = k.createCard({ projectId: p.id, title: 'Work' });
  k.move(c.id, 'in-progress');
  k.control(p.id, 'play');
  const r = k.start(c.id);
  await Promise.resolve();
  k.control(p.id, 'pause');
  assert.equal(p.control, 'pausing');
  assert.equal(r.status, 'running');
  const lower = k.createCard({ projectId: p.id, title: 'Queued' });
  k.move(lower.id, 'in-progress');
  assert.throws(() => k.start(lower.id), /paused/);
  release({ files: ['synthetic.txt'] });
  await drain(k);
  assert.equal(p.control, 'paused');
  assert.deepEqual(r.checkpoint.result, { files: ['synthetic.txt'] });
  k.control(p.id, 'resume');
  assert.equal(k.start(c.id).id, r.id);
  assert.equal(k.data.runs.length, 1);
});
test('Stop is draining and cannot erase an external effect', async t => {
  let release;
  const effects = [];
  const { k, bot } = fixture(t, {
      executor: async () => {
        effects.push('submitted');
        await new Promise(r => (release = r));
        return 'effect remains';
      },
    }),
    p = project(k, bot),
    c = k.createCard({ projectId: p.id, title: 'Work' });
  k.move(c.id, 'in-progress');
  k.control(p.id, 'play');
  k.start(c.id);
  await Promise.resolve();
  k.control(p.id, 'stop');
  assert.equal(p.control, 'stopping');
  release();
  await drain(k);
  assert.equal(p.control, 'stopped');
  assert.deepEqual(effects, ['submitted']);
});
test('bulk resume preserves individual pauses and timed resume does not invent reset dates', t => {
  const { k } = fixture(t),
    a = k.createProject({ name: 'A' }),
    b = k.createProject({ name: 'B' });
  k.control(b.id, 'play');
  k.bulk('pause');
  k.bulk('resume');
  assert.equal(a.control, 'paused');
  assert.equal(b.control, 'playing');
  assert.throws(() => k.control(b.id, 'pause', 'unknown reset'), /future/);
  k.control(b.id, 'pause', '2099-01-01T00:00:00Z');
  assert.equal(b.until, '2099-01-01T00:00:00Z');
});
test('resource admission skips blocked priorities, reserves capacity, and reorder never preempts', async t => {
  let release;
  const { k, bot } = fixture(t, {
      executor: () => new Promise(r => (release = r)),
      resources: () => ({ cores: 1, memory: 2 ** 30 }),
    }),
    a = project(k, bot, 'automatic'),
    b = project(k, bot, 'automatic'),
    ca = k.createCard({ projectId: a.id, title: 'A' }),
    cb = k.createCard({ projectId: b.id, title: 'B' });
  k.move(ca.id, 'in-progress');
  k.move(cb.id, 'in-progress');
  k.control(b.id, 'play');
  await k.tick();
  assert.equal(k.data.runs[0].cardId, cb.id);
  k.control(a.id, 'play');
  await k.tick();
  assert.match(ca.admissionError, /Insufficient/);
  k.reorder([b.id, a.id]);
  assert.equal(k.data.runs[0].status, 'running');
  release();
  await drain(k);
  await k.tick();
  assert.equal(k.data.runs[1].cardId, ca.id);
  release();
  await drain(k);
  assert.throws(() => k.reorder([a.id, a.id]), /each project/);
});
test('restart and executor failure require effect reconciliation before explicit retry', async t => {
  const { k, bot, dir } = fixture(t, {
      executor: async () => {
        throw Error('Unknown submission result');
      },
    }),
    p = project(k, bot),
    c = k.createCard({ projectId: p.id, title: 'Work' });
  k.move(c.id, 'in-progress');
  k.control(p.id, 'play');
  const r = k.start(c.id);
  await drain(k);
  assert.equal(r.status, 'uncertain');
  assert.throws(() => k.move(c.id, 'approval'), /reconcile/);
  assert.throws(() => k.reconcile(r.id, {}), /Record review/);
  k.reconcile(r.id, { checkpoint: 'Inspected synthetic effects', retry: true });
  assert.equal(c.entryId, r.entryId);
  assert.equal(r.status, 'checkpointed');
  k.data.runs.push({ ...r, id: 'restart', entryId: c.entryId, status: 'running' });
  k.save();
  const loaded = new Kanban(new Store(dir));
  assert.equal(loaded.data.runs.at(-1).status, 'uncertain');
  assert.throws(() => loaded.move(c.id, 'approval'), /reconcile/);
});
test('disabled adapter, manual stage and invalid configuration never launch work', async t => {
  const { k, bot } = fixture(t),
    p = project(k, bot),
    c = k.createCard({ projectId: p.id, title: 'Task' });
  k.move(c.id, 'in-progress');
  k.control(p.id, 'play');
  await k.tick();
  assert.equal(k.data.runs.length, 0);
  assert.throws(() => k.start(c.id), /disabled/);
  assert.throws(
    () =>
      k.configure(p.id, { team: [], stages: { testing: { mode: 'automatic', botIds: [bot] } } }),
    /configuration/,
  );
  assert.deepEqual(p.team, [bot]);
});
test('stage teams have no fixed bot cap and executor receives scoped model identities', async t => {
  let captured;
  const { k, store } = fixture(t, {
    executor: async input => {
      captured = input;
      return 'ok';
    },
  });
  const bots = Array.from(
      { length: 5 },
      (_, i) => store.createBot({ name: 'Specialist ' + i }).bot.id,
    ),
    p = k.createProject({ name: 'Team' });
  k.configure(p.id, { team: bots, stages: { specification: { mode: 'manual', botIds: bots } } });
  const c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Five perspectives' });
  k.move(c.id, 'specification');
  k.control(p.id, 'play');
  k.start(c.id);
  await drain(k);
  assert.deepEqual(captured.run.botIds, bots);
  assert.equal(captured.context.bots.length, 5);
  assert.equal(captured.context.project.id, p.id);
});
test('timed resume preserves bulk pause and other scopes continue', async t => {
  const { k, bot } = fixture(t, { executor: async () => 'general checkpoint' }),
    p = project(k, bot),
    g = k.createCard({ title: 'General', botIds: [bot] });
  k.move(g.id, 'in-progress');
  k.control(p.id, 'pause', '2099-01-01T00:00:00Z');
  p.until = '2000-01-01T00:00:00Z';
  k.bulk('pause');
  await k.tick();
  assert.equal(p.individual, false);
  assert.equal(p.bulk, true);
  assert.equal(p.control, 'paused');
  k.bulk('resume');
  k.control(p.id, 'pause');
  k.start(g.id);
  await drain(k);
  assert.equal(k.data.runs[0].projectId, null);
  assert.equal(p.control, 'paused');
});
test('unknown measurements fail closed and semi feedback cannot bypass stage gates', async t => {
  const { k, bot } = fixture(t, {
      executor: async () => 'draft',
      resources: () => ({ cores: NaN, memory: 2 ** 30 }),
    }),
    p = project(k, bot, 'semi'),
    c = k.createCard({ projectId: p.id, kind: 'idea', title: 'Feedback' });
  k.move(c.id, 'specification');
  k.control(p.id, 'play');
  assert.throws(() => k.start(c.id), /measurements/);
  assert.equal(k.data.runs.length, 0);
  k.resources = () => ({ cores: 2, memory: 2 ** 30 });
  k.start(c.id);
  await drain(k);
  assert.throws(() => k.requestDevelopment(c.id), /Finish/);
  k.feedback(c.id, 'Reviewed');
  const a = k.requestDevelopment(c.id);
  k.decide(a.id, false);
  assert.equal(c.stage, 'specification');
  const next = k.requestDevelopment(c.id);
  assert.notEqual(next.id, a.id);
  assert.equal(k.requestDevelopment(c.id).id, next.id);
  assert.equal(k.data.runs.length, 1);
});
