import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { ComputerDemonstration, demonstrationText } from '../public/computer-demonstration.js';
import { saveDemonstration } from '../src/computer-demonstration.mjs';
const scope = { botId: 'bot', mode: 'desktop', authorized: true };
test('demonstration requires explicit control and never stores screenshots, typed text, clipboard or raw letter keys', () => {
  const r = new ComputerDemonstration();
  assert.throws(
    () => r.start({ ...scope, authorized: false, objective: 'A procedure' }),
    /control/,
  );
  r.start({ ...scope, objective: 'Open a settings page' });
  r.capture(
    {
      action: 'type',
      text: 'password=super-secret-token',
      image: 'sensitive-screen',
      clipboard: 'secret',
    },
    null,
    scope,
  );
  r.capture({ action: 'type', text: 'more secret' }, null, scope);
  assert.equal(r.current.steps.length, 1);
  assert.deepEqual(r.current.steps, [{ action: 'manual-input' }]);
  assert(!JSON.stringify(r.current).includes('super-secret'));
  assert.throws(() => r.capture({ action: 'key', key: 'A' }, null, scope), /command/);
  assert.throws(() => r.start({ ...scope, objective: 'Again' }), /previous/);
  assert(!demonstrationText(r.current).includes('super-secret'));
});
test('pause and context changes exclude sensitive actions; stop, review and discard never auto-save or execute', () => {
  const r = new ComputerDemonstration();
  r.start({ ...scope, objective: 'Safe example' });
  r.capture({ action: 'click', x: 10, y: 20 }, { width: 1600, height: 1000 }, scope);
  r.pause();
  r.capture({ action: 'type', text: 'secret' }, null, scope);
  assert.equal(r.current.steps.length, 1);
  assert.throws(() => r.resume({ ...scope, botId: 'other' }), /same/);
  r.resume(scope);
  r.capture({ action: 'key', key: 'Control+L' }, null, scope);
  r.capture({ action: 'type', text: 'never recorded' }, null, { ...scope, botId: 'other' });
  assert.equal(r.current.state, 'paused');
  r.stop();
  r.capture({ action: 'key', key: 'Tab' }, null, scope);
  assert.equal(r.current.steps.length, 2);
  r.discard();
  assert.equal(r.current, null);
});
test('ten-minute and memory bounds pause without recording more actions or silently resuming', () => {
  let now = 0;
  const r = new ComputerDemonstration({ clock: () => now });
  r.start({ ...scope, objective: 'Time bound' });
  now = 600001;
  r.capture({ action: 'key', key: 'Tab' }, null, scope);
  assert.equal(r.current.state, 'paused');
  assert.equal(r.current.steps.length, 0);
  assert.throws(() => r.resume(scope), /limit/);
});
test('reviewed demonstration persists as scoped reusable skill, deduplicates saves and rejects obvious secrets/unreviewed content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-demonstration-'));
  try {
    const s = new Store(dir),
      bot = s.data.bots[0],
      input = {
        botId: bot.id,
        demoId: 'test-demo-unique',
        mode: 'desktop',
        name: 'Open preferences',
        objective: 'Open preferences safely',
        instructions: 'Inspect the current screen and open preferences.',
        steps: [{ action: 'type', text: 'password=not-persisted' }],
        reviewed: true,
      };
    assert.throws(() => saveDemonstration(s, { ...input, reviewed: false }), /Review/);
    assert.throws(
      () => saveDemonstration(s, { ...input, instructions: 'token=verysecret' }),
      /secrets/,
    );
    const skill = saveDemonstration(s, input);
    assert.equal(skill.botId, bot.id);
    assert(!JSON.stringify(skill).includes('not-persisted'));
    assert.equal(saveDemonstration(s, input).id, skill.id);
    assert.equal(s.data.skills.length, 1);
    assert.throws(() => saveDemonstration(s, { ...input, name: 'different' }), /different/);
    assert.equal(new Store(dir).data.skills[0].id, skill.id);
    assert.equal(s.data.jobs.length, 0);
    s.data.bots[0].deletedAt = 'now';
    assert.throws(() => saveDemonstration(s, { ...input, demoId: 'other-demo-id' }), /Restore/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed ordinary text persists and reloads, while unreviewed literal text is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-reviewed-text-'));
  try {
    const s = new Store(dir),
      input = {
        botId: s.data.bots[0].id,
        demoId: 'reviewed-text-fixture',
        mode: 'desktop',
        name: 'Greeting',
        objective: 'Enter greeting',
        instructions: 'Use the reviewed text step; inspect the target first.',
        steps: [{ action: 'reviewed-text', text: 'Hello שלום', reviewed: false }],
        reviewed: true,
      };
    assert.throws(() => saveDemonstration(s, input), /Explicitly reviewed/);
    input.steps[0].reviewed = true;
    const skill = saveDemonstration(s, input);
    assert.equal(
      new Store(dir).data.skills.find(x => x.id === skill.id).demonstration.steps[0].text,
      'Hello שלום',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
