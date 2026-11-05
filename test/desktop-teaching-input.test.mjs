import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopTeachingInput } from '../src/desktop-teaching-input.mjs';
import { RfbInputGate } from '../src/desktop-rfb-gate.mjs';
import { DesktopTeachingDrafts } from '../src/desktop-provider-teaching.mjs';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
const pointer = (mask, x = 2, y = 3) => {
  const b = Buffer.alloc(6);
  b[0] = 5;
  b[1] = mask;
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
};
const key = (k, down = true) => {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = +down;
  b.writeUInt32BE(k, 4);
  return b;
};
test('only authorized forwarded inputs become scoped reviewed teaching; text pauses without retaining values', async () => {
  const scope = { accountId: 'owner', botId: 'a', vmId: 'vm', generation: 'one' },
    coordinator = new DesktopSessionCoordinator({ releaseInputs: async () => {} }),
    lease = await coordinator.claim(scope, 'session'),
    saved = [];
  const drafts = new DesktopTeachingDrafts({
    coordinator,
    capture: async () => ({ image: 'fixture', mimeType: 'image/png', width: 100, height: 100 }),
    saveSkill: async s => {
      saved.push(s);
      return { id: 'skill' };
    },
  });
  try {
    const d = drafts.start(scope, lease, 'Scroll and return');
    await drafts.captureFrame(d.id, scope, lease);
    const observer = new DesktopTeachingInput(e => drafts.recordInput(scope, lease, e));
    let allowed = false;
    const gate = new RfbInputGate({
      canWrite: () => allowed,
      forward: () => {},
      onForwarded: b => observer.push(b),
    });
    gate.push(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]));
    gate.push(pointer(16));
    assert.equal(drafts.status(d.id, scope, lease).count, 0);
    allowed = true;
    gate.push(Buffer.concat([pointer(16), pointer(0), pointer(1), pointer(0), key(0xff50)]));
    assert.equal(drafts.status(d.id, scope, lease).count, 3);
    gate.push(key('q'.charCodeAt(0)));
    assert.equal(drafts.status(d.id, scope, lease).state, 'paused');
    gate.push(key('x'.charCodeAt(0)));
    const review = drafts.stop(d.id, scope, lease);
    assert.deepEqual(
      review.steps.map(x => x.action),
      ['scroll', 'click', 'key', 'manual-input'],
    );
    assert(!JSON.stringify(review.steps).includes('q'));
    assert.equal(review.steps.filter(s => s.action === 'manual-input').length, 1);
    assert.throws(() => drafts.stop(d.id, { ...scope, botId: 'other' }, lease));
    await drafts.save(d.id, scope, lease, {
      name: 'Test',
      instructions: review.instructions,
      reviewed: true,
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].steps.length, 4);
    await coordinator.release(scope, lease);
    gate.push(pointer(16));
    assert.equal(saved[0].steps.length, 4);
  } finally {
    drafts.close();
  }
});
test('mouse drag and command modifiers are retained, printable and extended Unicode are placeholders', () => {
  const events = [],
    r = new DesktopTeachingInput(e => events.push(e));
  r.push(pointer(1, 2, 3));
  r.push(pointer(1, 4, 5));
  r.push(pointer(0, 8, 9));
  r.push(key(0xffe3));
  r.push(key(97));
  r.push(key(0xffe3, false));
  r.push(key(0x010005d0));
  assert.deepEqual(events, [
    { action: 'drag', x: 2, y: 3, toX: 8, toY: 9, button: 'left' },
    { action: 'key', key: 'Control+a' },
    { action: 'manual-input' },
  ]);
});
