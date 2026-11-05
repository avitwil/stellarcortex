import test from 'node:test';
import assert from 'node:assert/strict';
import { KanbanPage } from '../public/kanban.js';
function fixture() {
  const page = Object.create(KanbanPage.prototype);
  page.data = {
    executionEnabled: true,
    general: {},
    projects: [],
    cards: [],
    runs: [],
    approvals: [],
  };
  page.bots = [{ id: 'bot' }];
  return page;
}
const card = (stage = 'todo') => ({
  id: 'card',
  projectId: null,
  entryId: 'entry',
  stage,
  botIds: ['bot'],
});
test('unified lanes are a reversible projection and preserve card records', () => {
  const p = fixture(),
    c = card();
  const before = structuredClone(c);
  assert.equal(p.lane(c), 'ready');
  assert.deepEqual(c, before);
  p.data.general.individual = true;
  assert.equal(p.lane(c), 'todo');
  c.stage = 'done';
  assert.equal(p.lane(c), 'done');
});
test('unified run states use actual entry and never infer success from a completed run', () => {
  const p = fixture(),
    c = card('in-progress');
  p.data.runs = [{ cardId: c.id, entryId: c.entryId, status: 'running' }];
  assert.equal(p.lane(c), 'running');
  p.data.runs[0].status = 'completed';
  assert.equal(p.lane(c), 'todo');
  p.data.runs[0].entryId = 'old';
  p.data.runs[0].status = 'running';
  assert.equal(p.lane(c), 'ready');
});
test('uncertain, feedback and checkpointed work are blocked, not ready or done', () => {
  const p = fixture(),
    c = card('development');
  for (const status of ['uncertain', 'feedback', 'checkpointed']) {
    p.data.runs = [{ cardId: c.id, entryId: c.entryId, status }];
    assert.equal(p.lane(c), 'blocked');
  }
});
test('development approval and final approval share review without changing workflow', () => {
  const p = fixture(),
    c = card('specification');
  p.data.approvals = [{ cardId: c.id, entryId: c.entryId, status: 'pending', kind: 'development' }];
  assert.equal(p.lane(c), 'review');
  c.stage = 'approval';
  assert.equal(p.lane(c), 'review');
  c.stage = 'idea';
  p.data.approvals = [];
  assert.equal(p.lane(c), 'triage');
});

test('scheduled work is projected from an explicit resume time; approvals stay review', () => {
  const p = fixture(),
    c = card();
  p.data.general.until = '2099-01-01T00:00:00Z';
  assert.equal(p.lane(c), 'scheduled');
  c.stage = 'approval';
  assert.equal(p.lane(c), 'review');
});
