import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerOwnership } from '../src/computer-ownership.mjs';
const deferred = () => {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return { promise, resolve };
};
test('human priority waits for active input and rejects older queued input across tools', async () => {
  const gate = new ComputerOwnership(),
    active = deferred(),
    entered = deferred(),
    events = [];
  const first = gate.input('a', false, async () => {
    events.push('browser-start');
    entered.resolve();
    await active.promise;
    events.push('browser-end');
  });
  await entered.promise;
  const queued = gate.input('a', false, () => events.push('desktop-queued'));
  const rejected = assert.rejects(queued, /control changed/);
  const takeover = gate.takeover('a', true, () => events.push('human-granted'));
  await assert.rejects(
    gate.input('a', false, () => {}),
    /control changed/,
  );
  active.resolve();
  await Promise.all([first, rejected, takeover]);
  await gate.input('a', true, () => events.push('human-input'));
  assert.deepEqual(events, ['browser-start', 'browser-end', 'human-granted', 'human-input']);
});
test('return changes epoch; bots do not inherit another bot control', async () => {
  const gate = new ComputerOwnership();
  await gate.takeover('a', true, () => {});
  await gate.input('b', false, () => {});
  await assert.rejects(gate.input('a', false, () => {}));
  await gate.takeover('a', false, () => {});
  await gate.input('a', false, () => {});
  await assert.rejects(gate.input('a', true, () => {}));
});
