import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
import { DesktopTeachingDrafts } from '../src/desktop-provider-teaching.mjs';
const scope = { accountId: 'owner', botId: 'a', vmId: 'vm-a', generation: 'one' };
async function fixture() {
  const coordinator = new DesktopSessionCoordinator({ releaseInputs: async () => {} }),
    lease = await coordinator.claim(scope, 'session-a'),
    saved = [],
    captureCalls = [];
  const drafts = new DesktopTeachingDrafts({
    coordinator,
    capture: async () => {
      captureCalls.push(true);
      return { image: 'raw-fixture', mimeType: 'image/jpeg', width: 10, height: 10 };
    },
    redact: async () => ({ image: 'redacted-fixture', mimeType: 'image/jpeg' }),
    saveSkill: async data => {
      saved.push(data);
      return { id: 'saved-fixture' };
    },
  });
  return { coordinator, lease, saved, captureCalls, drafts };
}
test('explicit capture, redaction and review are required before a visual example is saved', async () => {
  const f = await fixture(),
    d = f.drafts.start(scope, f.lease, 'Open Files');
  assert.equal(f.captureCalls.length, 0);
  const raw = await f.drafts.captureFrame(d.id, scope, f.lease);
  const preview = await f.drafts.preview(d.id, scope, f.lease, {
    frameId: raw.frameId,
    crop: { x: 0, y: 0, width: 5, height: 5 },
    masks: [],
    safeScreenConfirmed: true,
  });
  await assert.rejects(
    f.drafts.save(d.id, scope, f.lease, {
      name: 'Files',
      instructions: 'Open the Files application.',
      reviewed: true,
    }),
    /Demonstrate/,
  );
  f.drafts.review(d.id, scope, f.lease, { previewId: preview.previewId, reviewedNoSecrets: true });
  await f.drafts.save(d.id, scope, f.lease, {
    name: 'Files',
    instructions: 'Open the Files application.',
    reviewed: true,
  });
  await f.drafts.save(d.id, scope, f.lease, {
    name: 'Files',
    instructions: 'Open the Files application.',
    reviewed: true,
  });
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].frames[0].image, 'redacted-fixture');
  assert(!JSON.stringify(f.saved).includes('raw-fixture'));
});
test('typed values are never retained and pause capture; another bot cannot use a draft', async () => {
  const f = await fixture(),
    d = f.drafts.start(scope, f.lease, 'Test workflow');
  f.drafts.record(
    d.id,
    scope,
    f.lease,
    { action: 'type', text: 'private value' },
    { width: 10, height: 10 },
  );
  assert(!JSON.stringify([...f.drafts.drafts.values()]).includes('private value'));
  await assert.rejects(f.drafts.captureFrame(d.id, scope, f.lease), /paused/);
  assert.throws(() => f.drafts.get(d.id, { ...scope, botId: 'b' }, f.lease));
});
test('control revocation during capture prevents delivery of the late frame', async () => {
  const f = await fixture(),
    d = f.drafts.start(scope, f.lease, 'Inspect Files');
  let resolve;
  f.drafts.capture = () => new Promise(r => (resolve = r));
  const pending = f.drafts.captureFrame(d.id, scope, f.lease);
  await f.coordinator.release(scope, f.lease);
  resolve({ image: 'must-not-deliver', mimeType: 'image/jpeg', width: 10, height: 10 });
  await assert.rejects(pending, /human control/);
  assert.equal(f.drafts.drafts.get(d.id).frames.size, 0);
});

test('ordinary text can be explicitly reviewed per step; raw typing, denial and revocation never retain values', async () => {
  const f = await fixture();
  try {
    const d = f.drafts.start(scope, f.lease, 'Enter a synthetic greeting');
    f.drafts.record(
      d.id,
      scope,
      f.lease,
      { action: 'type', text: 'not-retained-synthetic' },
      { width: 10, height: 10 },
    );
    assert.throws(
      () =>
        f.drafts.reviewText(d.id, scope, f.lease, {
          index: 0,
          text: 'Hello שלום',
          confirmed: true,
        }),
      /Stop recording/,
    );
    f.drafts.stop(d.id, scope, f.lease);
    assert.throws(
      () =>
        f.drafts.reviewText(d.id, scope, f.lease, {
          index: 0,
          text: 'Hello שלום',
          confirmed: false,
        }),
      /Confirm storage/,
    );
    assert.throws(
      () =>
        f.drafts.reviewText(d.id, scope, f.lease, {
          index: 0,
          text: 'password=synthetic-fixture',
          confirmed: true,
        }),
      /non-sensitive/,
    );
    const review = f.drafts.reviewText(d.id, scope, f.lease, {
      index: 0,
      text: 'Hello שלום',
      confirmed: true,
    });
    assert.deepEqual(review.steps[0], {
      action: 'reviewed-text',
      text: 'Hello שלום',
      reviewed: true,
    });
    assert.throws(() =>
      f.drafts.reviewText(d.id, { ...scope, botId: 'other' }, f.lease, {
        index: 0,
        text: 'Different',
        confirmed: true,
      }),
    );
    f.drafts.reviewText(d.id, scope, f.lease, { index: 0, text: null });
    assert.deepEqual(review.steps[0], { action: 'manual-input' });
    f.drafts.reviewText(d.id, scope, f.lease, { index: 0, text: 'Hello שלום', confirmed: true });
    await f.drafts.save(d.id, scope, f.lease, {
      name: 'Synthetic greeting',
      instructions: 'Type the reviewed greeting into the observed target.',
      reviewed: true,
    });
    assert.equal(f.saved[0].steps[0].text, 'Hello שלום');
    assert(!JSON.stringify(f.saved).includes('not-retained-synthetic'));
    assert.throws(
      () => f.drafts.reviewText(d.id, scope, f.lease, { index: 0, text: null }),
      /Stop recording/,
    );
    await f.coordinator.release(scope, f.lease);
    assert.throws(
      () => f.drafts.reviewText(d.id, scope, f.lease, { index: 0, text: 'new', confirmed: true }),
      /human control/,
    );
  } finally {
    f.drafts.close();
  }
});
