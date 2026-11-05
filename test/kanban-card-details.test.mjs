import test from 'node:test';
import assert from 'node:assert/strict';
import { Kanban } from '../src/kanban.mjs';
const setup = () => {
  const store = { data: { bots: [] }, save() {} },
    k = new Kanban(store),
    c = k.createCard({ title: 'Original', text: 'Original description' });
  return { store, k, c };
};
test('editing preserves revisions and does not change entry or lifecycle', () => {
  const { k, c } = setup(),
    entry = c.entryId;
  k.editCard(c.id, { entryId: entry, title: 'Updated', text: 'New description' });
  assert.equal(c.title, 'Updated');
  assert.equal(c.revisions[0].text, 'Original description');
  assert.equal(c.entryId, entry);
  assert.equal(c.stage, 'todo');
  k.editCard(c.id, { entryId: entry, title: 'Updated', text: 'New description' });
  assert.equal(c.revisions.length, 1);
  assert.throws(() => k.editCard(c.id, { entryId: 'stale', title: 'No', text: '' }), /changed/);
});
test('active and uncertain work prevents editing executor input', () => {
  const { k, c } = setup();
  for (const status of [
    'running',
    'pausing',
    'stopping',
    'uncertain',
    'feedback',
    'checkpointed',
  ]) {
    k.data.runs = [{ cardId: c.id, status }];
    assert.throws(
      () => k.editCard(c.id, { entryId: c.entryId, title: 'No', text: '' }),
      /reconcile/,
    );
    assert.equal(c.title, 'Original');
  }
});
test('comments are append-only and repeated requests are deduplicated', () => {
  const { k, c } = setup();
  const a = k.comment(c.id, { requestId: 'one', text: 'User feedback' });
  assert.equal(k.comment(c.id, { requestId: 'one', text: 'User feedback' }).id, a.id);
  assert.equal(c.comments.length, 1);
  assert.equal(c.initialText, 'Original description');
  assert.throws(() => k.comment(c.id, { requestId: 'two', text: ' ' }), /Comment/);
  assert.equal(c.comments.length, 1);
});
test('failed saves restore detail edits and comments', () => {
  const { k, c, store } = setup();
  store.save = () => {
    throw Error('disk');
  };
  assert.throws(() => k.editCard(c.id, { entryId: c.entryId, title: 'No', text: '' }), /disk/);
  assert.equal(c.title, 'Original');
  assert.equal(c.revisions, undefined);
  assert.throws(() => k.comment(c.id, { requestId: 'one', text: 'No' }), /disk/);
  assert.equal(c.comments.length, 0);
});

test('pending approval prevents changing the description supporting its evidence', () => {
  const { k, c } = setup();
  k.data.approvals.push({ cardId: c.id, entryId: c.entryId, status: 'pending' });
  assert.throws(
    () => k.editCard(c.id, { entryId: c.entryId, title: 'Changed', text: '' }),
    /approval/,
  );
  assert.equal(c.title, 'Original');
});
test('edited description, revisions and comments survive reopening persisted Store', async t => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path'),
    { Store } = await import('../src/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-details-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = new Kanban(new Store(dir)),
    c = k.createCard({ title: 'Original', text: 'Original body' });
  k.editCard(c.id, { entryId: c.entryId, title: 'Updated', text: 'Updated body' });
  k.comment(c.id, { requestId: 'persisted', text: 'A note' });
  const loaded = new Kanban(new Store(dir)),
    again = loaded.card(c.id);
  assert.equal(again.initialText, 'Updated body');
  assert.equal(again.revisions[0].text, 'Original body');
  assert.equal(again.comments[0].text, 'A note');
  assert.equal(
    loaded.comment(c.id, { requestId: 'persisted', text: 'A note' }).id,
    again.comments[0].id,
  );
  assert.equal(again.comments.length, 1);
});
