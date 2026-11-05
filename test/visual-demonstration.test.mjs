import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualDemonstration } from '../public/visual-demonstration.js';
import { frameRedactionPlan } from '../src/guest-redaction.mjs';
test('visual teaching retains reviewed semantic examples, not just coordinates, and pause/type discards pending capture', async () => {
  let captures = 0;
  const v = new VisualDemonstration({
    captureRedacted: async () => {
      captures++;
      return { redacted: true, image: 'synthetic-redacted-frame', mimeType: 'image/jpeg' };
    },
  });
  assert.throws(
    () => v.start({ botId: 'a', objective: 'Preferences', manualControl: false }),
    /control/,
  );
  v.start({ botId: 'a', objective: 'Change view preferences', manualControl: true });
  const step = {
    botId: 'a',
    purpose: 'Open appearance settings',
    target: 'Preferences menu',
    expectedResult: 'Theme selector becomes visible',
    safeScreenConfirmed: true,
    crop: { x: 0, y: 0, width: 100, height: 100 },
    masks: [],
  };
  await v.capture(step);
  assert.throws(() => v.approveCandidate({ reviewedNoSecrets: false }), /Review/);
  v.approveCandidate({ reviewedNoSecrets: true });
  await v.capture(step);
  v.sensitiveInput();
  assert.equal(v.candidate, null);
  await assert.rejects(v.capture(step), /safe/);
  v.resume({ botId: 'a', manualControl: true, safeScreenConfirmed: true });
  const draft = v.stop();
  assert.match(draft.instructions, /Open appearance settings/);
  assert.match(draft.instructions, /Theme selector/);
  assert.equal(draft.steps.length, 1);
  assert.equal(draft.steps[0].frame.image, 'synthetic-redacted-frame');
  assert.equal(captures, 2);
  v.discard();
  assert.equal(v.session, null);
});
test('guest redaction applies opaque masks before crop/export and strips metadata', () => {
  const plan = frameRedactionPlan({
    width: 100,
    height: 100,
    crop: { x: 10, y: 10, width: 50, height: 50 },
    masks: [{ x: 20, y: 20, width: 10, height: 10 }],
  });
  assert(plan.indexOf('-draw') < plan.indexOf('-crop'));
  assert(plan.includes('-strip'));
  assert.throws(
    () =>
      frameRedactionPlan({ width: 100, height: 100, crop: { x: 90, y: 0, width: 20, height: 10 } }),
    /rectangle/,
  );
});
