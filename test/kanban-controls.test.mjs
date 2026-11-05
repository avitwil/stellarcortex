import test from 'node:test';
import assert from 'node:assert/strict';
import { cardExecution, scopeExecution, KanbanPage } from '../public/kanban.js';
function data() {
  return {
    general: { control: 'playing' },
    projects: [
      {
        id: 'p',
        lifecycle: 'active',
        individual: true,
        control: 'paused',
        stages: { development: { mode: 'manual', botIds: ['b'] } },
      },
    ],
    cards: [],
    runs: [],
    approvals: [],
  };
}
const card = { id: 'c', projectId: 'p', stage: 'development', entryId: 'e' };
test('empty/idea-only projects have no execution or scheduling controls', () => {
  const d = data();
  for (const c of [[], [{ ...card, stage: 'idea' }]]) {
    d.cards = c;
    const s = scopeExecution(d, 'p');
    for (const key of ['showStart', 'showPause', 'showStop', 'showResume', 'showSchedule'])
      assert.equal(s[key], false, key);
  }
});
test('ready first work offers enable only, without pause/stop/resume scheduling', () => {
  const d = data();
  d.cards = [card];
  const s = scopeExecution(d, 'p');
  assert.equal(s.showStart, true);
  for (const key of ['showPause', 'showStop', 'showResume', 'showSchedule'])
    assert.equal(s[key], false, key);
  assert.equal(cardExecution(d, card).canRun, false);
  d.projects[0].individual = false;
  assert.equal(cardExecution(d, card).canRun, true);
});
test('active/pausing/stopping work uses only meaningful drain controls', () => {
  const d = data();
  d.cards = [card];
  d.projects[0].individual = false;
  d.projects[0].control = 'playing';
  d.runs = [{ id: 'r', cardId: 'c', projectId: 'p', entryId: 'e', status: 'running' }];
  let s = scopeExecution(d, 'p');
  assert(s.showPause && s.showStop);
  assert(!s.showStart && !s.showResume && !s.showSchedule);
  assert(!cardExecution(d, card).canRun);
  d.projects[0].individual = true;
  d.projects[0].control = 'pausing';
  s = scopeExecution(d, 'p');
  assert(!s.showPause && !s.showResume && s.showStop);
  d.projects[0].stopped = true;
  d.projects[0].control = 'stopping';
  assert(!scopeExecution(d, 'p').showStop);
});
test('checkpointed work can resume or schedule, but uncertainty and feedback cannot run', () => {
  const d = data();
  d.cards = [card];
  d.runs = [{ cardId: 'c', projectId: 'p', entryId: 'e', status: 'checkpointed' }];
  let s = scopeExecution(d, 'p');
  assert(s.showResume && s.showSchedule && !s.showStart);
  d.projects[0].bulk = true;
  assert(!scopeExecution(d, 'p').showResume);
  d.projects[0].bulk = false;
  for (const status of ['uncertain', 'feedback', 'completed', 'reconciled']) {
    d.runs[0].status = status;
    assert(!cardExecution(d, card).canRun);
    assert(!scopeExecution(d, 'p').showStart);
    assert(!scopeExecution(d, 'p').showResume);
  }
});
test('approval, done, inactive lifecycle, missing/deleted assignees remain blocked', () => {
  for (const stage of ['idea', 'approval', 'done']) {
    const d = data();
    d.projects[0].individual = false;
    const c = { ...card, stage };
    d.cards = [c];
    assert(!cardExecution(d, c).canRun);
  }
  const d = data();
  d.cards = [card];
  d.projects[0].individual = false;
  d.projects[0].lifecycle = 'parked';
  assert(!cardExecution(d, card).canRun);
  d.projects[0].lifecycle = 'active';
  assert(!cardExecution(d, card, [{ id: 'b', deletedAt: 'now' }]).canRun);
  d.approvals = [{ cardId: 'c', entryId: 'e', status: 'pending' }];
  assert(!cardExecution(d, card).canRun);
});

test('bulk controls wait for draining runs and empty/disabled boards offer no start', () => {
  const d = data(),
    page = new KanbanPage({ tr: (_, en) => en });
  page.data = d;
  page.bots = [];
  assert.equal(page.bulkControls(), '');
  d.cards = [card];
  d.projects[0].individual = false;
  d.projects[0].control = 'playing';
  d.runs = [{ cardId: 'c', projectId: 'p', entryId: 'e', status: 'running' }];
  assert.match(page.bulkControls(), /data-bulk="pause"/);
  d.projects[0].bulk = true;
  d.projects[0].control = 'pausing';
  assert.equal(page.bulkControls(), '');
  d.runs[0].status = 'checkpointed';
  d.projects[0].control = 'paused';
  assert.match(page.bulkControls(), /data-bulk="resume"/);
  d.runs = [];
  d.projects[0].bulk = false;
  d.executionEnabled = false;
  assert(!cardExecution(d, card).canRun);
  assert.equal(page.bulkControls(), '');
});
