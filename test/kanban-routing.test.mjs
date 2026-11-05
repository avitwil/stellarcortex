import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Kanban } from '../src/kanban.mjs';
import { botRoles, roleForCard, routingCandidates } from '../public/kanban-routing.js';
const drain = async k => Promise.all([...k.pending.values()]);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.data.bots[0].title = 'Unassigned';
  const calls = [],
    executor = async x => {
      calls.push(x);
      return {
        synthetic: true,
        workflow: {
          kind: {
            specification: 'specification-ready',
            development: 'development-completed',
            testing: 'validation-passed',
            'in-progress': 'task-completed',
          }[x.card.stage],
          simulated: true,
          evidence: 'Explicit fake stage outcome',
        },
      };
    };
  executor.manualOnly = true;
  const k = new Kanban(store, { executor, resources: () => ({ cores: 4, memory: 2 ** 31 }) }),
    bot = (name, title) => store.createBot({ name, title }).bot;
  return { dir, store, k, executor, calls, bot };
}
test('roles use declared titles/capabilities, never misleading names; email classification is local only', () => {
  assert.deepEqual(botRoles({ name: 'Researcher', title: 'Unassigned' }), []);
  assert(botRoles({ name: 'Any name', title: 'בוט מחקר' }).includes('research'));
  assert.equal(roleForCard({ stage: 'todo', title: 'בדוק מיילים', initialText: '' }), 'email');
  assert.equal(roleForCard({ stage: 'development', title: 'email' }), 'development');
});
test('specialist first, eligible generalist fallback, and insufficient-permission fallback are deterministic', () => {
  const specialist = { id: 's', title: 'Researcher' },
    general = { id: 'g', title: 'General-purpose assistant' },
    c = { stage: 'specification' };
  assert.equal(routingCandidates(c, [], [specialist, general]).candidates[0].id, 's');
  assert.equal(routingCandidates(c, [], [general]).candidates[0].id, 'g');
  const eligible = b => ({ allowed: b.id !== 's', reason: 'Existing permission unavailable' });
  const fallback = routingCandidates(c, [], [specialist, general], eligible);
  assert.equal(fallback.candidates[0].id, 'g');
  assert.match(fallback.basis, /fallback/);
  assert.equal(
    routingCandidates(c, [], [specialist, general], () => ({ allowed: false })).candidates.length,
    0,
  );
});
test('opted-in research -> approved development -> testing queues for busy specialist and retains context', async t => {
  const { k, store, bot, calls } = setup(t),
    research = bot('A', 'Research specialist'),
    dev = bot('B', 'Software developer'),
    tester = bot('C', 'Validation tester'),
    general = bot('D', 'General-purpose assistant');
  const c = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'Research and develop' }),
    entry = c.entryId;
  await k.tick();
  assert.equal(calls.length, 0);
  k.start(c.id, { entryId: entry });
  await drain(k);
  assert.equal(calls[0].run.botIds[0], research.id);
  assert.equal(k.data.approvals[0].kind, 'development');
  await k.tick();
  assert.equal(calls.length, 1);
  k.decide(k.data.approvals[0].id, true);
  store.data.jobs.push({ id: 'busy-elsewhere', botId: dev.id, status: 'running' });
  await k.tick();
  assert.equal(c.routingStatus.code, 'busy');
  assert.equal(calls.length, 1);
  assert.notEqual(c.routingStatus.botId, general.id);
  store.data.jobs[0].status = 'completed';
  await k.tick();
  await drain(k);
  assert.equal(calls[1].run.botIds[0], dev.id);
  assert(
    calls[1].context.history.some(
      r => r.checkpoint?.result?.workflow?.kind === 'specification-ready',
    ),
  );
  await k.tick();
  await drain(k);
  assert.equal(calls[2].run.botIds[0], tester.id);
  assert.equal(c.stage, 'approval');
  assert.equal(k.start(c.id, { entryId: entry }).id, k.data.runs[0].id);
  await k.tick();
  assert.equal(calls.length, 3);
  assert.equal(store.data.bots.length, 5);
});
test('concurrent automatic starts reserve a specialist before provider job creation', async t => {
  const { k, bot, calls } = setup(t);
  bot('Research', 'Research specialist');
  const a = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'A' }),
    b = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'B' });
  k.start(a.id);
  const waiting = k.start(b.id);
  assert.equal(waiting.queued, true);
  assert.equal(b.routingStatus.code, 'busy');
  assert.equal(k.data.runs.length, 1);
  await drain(k);
  await k.tick();
  await drain(k);
  assert.equal(calls.length, 2);
  assert.equal(k.data.runs.length, 2);
});
test('no eligible role blocks for user input and manual override does not create bots', async t => {
  const { k, store, calls } = setup(t),
    c = k.createCard({ routingMode: 'automatic', taskRole: 'email', title: 'Check mail' });
  const count = store.data.bots.length,
    result = k.start(c.id);
  assert(result.queued);
  assert.equal(c.routingStatus.code, 'missing-role');
  assert.equal(calls.length, 0);
  k.assignCard(c.id, [store.data.bots[0].id]);
  k.start(c.id);
  await drain(k);
  assert.equal(calls.length, 1);
  assert.equal(store.data.bots.length, count);
});
test('unknown task type requests a user choice instead of guessing a generalist', t => {
  const { k, bot } = setup(t);
  bot('Any', 'General-purpose assistant');
  const c = k.createCard({ routingMode: 'automatic', title: 'Help me' });
  k.start(c.id);
  assert.equal(c.routingStatus.code, 'missing-type');
  assert.equal(k.data.runs.length, 0);
});
test('stop, archive/restore and manual mode never silently resume queued routing', async t => {
  const { k, store, bot, calls } = setup(t),
    research = bot('R', 'Research specialist');
  store.data.jobs.push({ id: 'busy', botId: research.id, status: 'running' });
  const stopped = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'Stop queue' });
  k.start(stopped.id);
  k.control(null, 'stop');
  assert.equal(stopped.autoAuthorization, undefined);
  k.control(null, 'play');
  const archived = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'Archive queue' });
  k.start(archived.id);
  k.archiveCard(archived.id);
  assert.equal(archived.autoAuthorization, undefined);
  k.restoreCard(archived.id);
  store.data.jobs[0].status = 'completed';
  await k.tick();
  assert.equal(calls.length, 0);
  const manual = k.createCard({ title: 'Manual research', botIds: [research.id] });
  await k.tick();
  assert.equal(calls.length, 0);
  assert.equal(manual.autoAuthorization, undefined);
});
test('persisted authorized queue requires explicit restart review and reuses its stage entry', async t => {
  const { dir, k, store, executor, bot, calls } = setup(t),
    r = bot('R', 'Research specialist');
  store.data.jobs.push({ id: 'busy', botId: r.id, status: 'running' });
  const c = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'Resume after restart' });
  k.start(c.id);
  const loadedStore = new Store(dir),
    loaded = new Kanban(loadedStore, {
      executor,
      resources: () => ({ cores: 4, memory: 2 ** 31 }),
    });
  loadedStore.data.jobs[0].status = 'completed';
  await loaded.tick();
  assert.equal(calls.length, 0);
  assert.equal(loaded.card(c.id).routingNeedsResume, true);
  loaded.start(c.id);
  await drain(loaded);
  assert.equal(calls.length, 1);
  assert.equal(loaded.card(c.id).routingNeedsResume, false);
});
test('pause/resume preserves explicit authorization but no dispatch occurs while paused', async t => {
  const { k, store, bot, calls } = setup(t),
    r = bot('R', 'Research specialist');
  store.data.jobs.push({ id: 'busy', botId: r.id, status: 'running' });
  const c = k.createCard({ kind: 'idea', routingMode: 'automatic', title: 'Pause queue' });
  k.start(c.id);
  k.control(null, 'pause');
  store.data.jobs[0].status = 'completed';
  await k.tick();
  assert.equal(calls.length, 0);
  k.control(null, 'resume');
  await k.tick();
  await drain(k);
  assert.equal(calls.length, 1);
});
