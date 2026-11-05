import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
import { Store } from '../src/store.mjs';
import { readSkillFrames } from '../src/computer-demonstration.mjs';
import { qmpReleaseCommand } from '../src/desktop-qmp.mjs';
const scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'one' };
test('runtime applies the same ownership gate to native and browser agent input and confirms release', async () => {
  const calls = [],
    broker = {
      status: async () => ({ state: 'running' }),
      release: async input => calls.push(['release', input]),
      guest: async input => {
        calls.push(['guest', input]);
        return { ok: true };
      },
      capture: async () => ({ width: 100, height: 100 }),
      input: async input => calls.push(['input', input]),
    };
  const p = new DesktopProviderRuntime({ records: [scope], broker, enabled: true, approved: true });
  await p.refresh('owner', 'bot');
  assert.equal(p.lookup('owner', 'bot').state, 'running');
  assert.equal(p.lookup('other', 'bot'), null);
  const lease = await p.coordinator.claim(scope, 'session');
  await assert.rejects(
    p.agent(scope, 'browser.action', {
      input: { action: 'open', url: 'https://www.wikipedia.org' },
    }),
    /Human/,
  );
  await assert.rejects(p.desktopAction(scope, { action: 'click', x: 1, y: 1 }), /Human/);
  await p.agent(scope, 'browser.read');
  assert.equal(calls[0][0], 'guest');
  await p.coordinator.release(scope, lease);
  assert.equal(calls[1][0], 'release');
  await p.desktopAction(scope, { action: 'click', x: 1, y: 1 });
  assert.equal(calls[2][0], 'input');
  await assert.rejects(p.agent({ ...scope, generation: 'old' }, 'browser.read'), /identity/);
  await p.close();
});
test('reviewed visual teaching persists to the real bot-scoped skill store and is readable by skill tools', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-runtime-teach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    s = { ...scope, botId: store.data.bots[0].id };
  const raw = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64'),
    redacted = Buffer.from([255, 216, 255, 217]).toString('base64');
  const p = new DesktopProviderRuntime({
    records: [s],
    enabled: true,
    broker: {
      release: async () => ({ released: true }),
      capture: async () => ({ image: raw, mimeType: 'image/png', width: 10, height: 10 }),
    },
    redact: async () => ({ image: redacted, mimeType: 'image/jpeg' }),
  });
  p.attachStore(store);
  t.after(() => p.close());
  const lease = await p.coordinator.claim(s, 'owner-session'),
    draft = p.teaching.start(s, lease, 'Find Files'),
    frame = await p.teaching.captureFrame(draft.id, s, lease),
    preview = await p.teaching.preview(draft.id, s, lease, {
      frameId: frame.frameId,
      crop: { x: 0, y: 0, width: 5, height: 5 },
      masks: [],
      safeScreenConfirmed: true,
    });
  await assert.rejects(
    p.teaching.save(draft.id, s, lease, {
      name: 'Files',
      instructions: 'Find the Files icon and confirm the home folder opens.',
      reviewed: true,
    }),
    /Demonstrate/,
  );
  p.teaching.review(draft.id, s, lease, { previewId: preview.previewId, reviewedNoSecrets: true });
  const skill = await p.teaching.save(draft.id, s, lease, {
    name: 'Files',
    instructions: 'Find the Files icon and confirm the home folder opens.',
    reviewed: true,
  });
  assert.equal(skill.botId, s.botId);
  assert.equal(skill.source, 'user-demonstration');
  assert.match(readSkillFrames(store, skill)[0].imageUrl, /^data:image\/jpeg;base64,/);
  assert.equal(store.data.skills.length, 1);
  assert.equal(store.data.computerTeachingFrames.length, 1);
  assert(!fs.readFileSync(store.file, 'utf8').includes(raw));
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'computer-teaching', store.data.computerTeachingFrames[0].file)),
    Buffer.from(redacted, 'base64'),
  );
});
test('release command uses only advertised key/button releases and rejects an ambiguous schema', () => {
  const schema = [
    {
      name: '1',
      'meta-type': 'enum',
      members: ['unmapped', 'ctrl', 'shift', 'ret', 'a'].map(name => ({ name })),
    },
    {
      name: '2',
      'meta-type': 'enum',
      members: ['left', 'right', 'wheel-up'].map(name => ({ name })),
    },
  ];
  const command = qmpReleaseCommand(schema);
  assert.equal(command.arguments.events.length, 7);
  assert(command.arguments.events.every(e => e.data.down === false));
  assert.throws(() => qmpReleaseCommand([...schema, schema[0]]), /Ambiguous/);
});
