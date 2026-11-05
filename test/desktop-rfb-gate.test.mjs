import test from 'node:test';
import assert from 'node:assert/strict';
import { RfbInputGate } from '../src/desktop-rfb-gate.mjs';
const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 0])]);
test('fragmented RFB reads pass; input is checked at forwarding, not only at connection', () => {
  let granted = false;
  const out = [],
    rejected = [],
    gate = new RfbInputGate({
      canWrite: () => granted,
      forward: b => out.push(Buffer.from(b)),
      onRejected: x => rejected.push(x),
    });
  for (const b of handshake) gate.push(Buffer.from([b]));
  assert.equal(out[2][0], 1);
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
  gate.push(key.subarray(0, 3));
  granted = true;
  gate.push(key.subarray(3));
  assert.deepEqual(out.at(-1), key);
  granted = false;
  gate.push(key);
  gate.push(Buffer.from([3, 1, 0, 0, 0, 0, 0, 10, 0, 10]));
  assert.deepEqual(rejected, ['ownership']);
  assert.equal(out.at(-1)[0], 3);
});
test('clipboard is never forwarded and malformed/oversized protocol fails closed', () => {
  const out = [],
    gate = new RfbInputGate({ canWrite: () => true, forward: b => out.push(b) });
  gate.push(handshake);
  gate.push(Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 65, 66, 67]));
  assert.equal(out.length, 3);
  assert.throws(() => gate.push(Buffer.from([250, 0, 0, 0])), /Unsupported/);
  const other = new RfbInputGate({ canWrite: () => true, forward: () => {} });
  other.push(handshake);
  assert.throws(() => other.push(Buffer.from([6, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff])), /limit/);
});
test('resize and extended key inputs require control, ordinary frame updates do not', () => {
  const out = [],
    gate = new RfbInputGate({ canWrite: () => false, forward: b => out.push(b) });
  gate.push(handshake);
  const resize = Buffer.alloc(24);
  resize[0] = 251;
  resize[6] = 1;
  gate.push(resize);
  const key = Buffer.alloc(12);
  key[0] = 255;
  gate.push(key);
  gate.push(Buffer.from([150, 1, 0, 0, 0, 0, 0, 10, 0, 10]));
  assert.equal(out.length, 4);
  assert.equal(out.at(-1)[0], 150);
});
