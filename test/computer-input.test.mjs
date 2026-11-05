import test from 'node:test';
import assert from 'node:assert/strict';
import { computerKeyAction, screenPoint, ComputerInputQueue } from '../public/computer-input.js';

test('remote keyboard keeps Unicode and IME native, maps shortcuts by physical key and permits local paste', () => {
  for (const event of [
    { key: 'ש' },
    { key: 'A', shiftKey: true },
    { key: 'Process', isComposing: true },
    { key: 'Dead' },
    { key: 'v', code: 'KeyV', ctrlKey: true },
    { key: '€', ctrlKey: true, altKey: true, getModifierState: k => k === 'AltGraph' },
  ])
    assert.equal(computerKeyAction(event), null);
  assert.deepEqual(computerKeyAction({ key: 'ש', code: 'KeyA', ctrlKey: true }), {
    action: 'key',
    key: 'Control+A',
  });
  assert.deepEqual(computerKeyAction({ key: 'Tab', shiftKey: true }), {
    action: 'key',
    key: 'Shift+Tab',
  });
  assert.deepEqual(computerKeyAction({ key: 'ArrowLeft', ctrlKey: true }), {
    action: 'key',
    key: 'Control+ArrowLeft',
  });
});
test('remote image coordinates respect scaled boundaries and reject letterbox clicks', () => {
  const rect = { left: 200, top: 50, width: 800, height: 500 };
  assert.deepEqual(screenPoint({ clientX: 600, clientY: 300 }, rect, 1600, 1000), {
    x: 800,
    y: 500,
  });
  assert.deepEqual(screenPoint({ clientX: 1000, clientY: 550 }, rect, 1600, 1000), {
    x: 1599,
    y: 999,
  });
  assert.equal(screenPoint({ clientX: 199, clientY: 200 }, rect, 1600, 1000), null);
});
test('fast remote input is serialized and session cancellation drops queued actions', async () => {
  const queue = new ComputerInputQueue(),
    calls = [];
  let release;
  const first = queue.enqueue(async () => {
    calls.push('click');
    await new Promise(r => (release = r));
  });
  const second = queue.enqueue(() => calls.push('type'));
  await Promise.resolve();
  assert.deepEqual(calls, ['click']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['click', 'type']);
  let releaseNext, markStarted;
  const started = new Promise(r => (markStarted = r));
  const current = queue.enqueue(async () => {
    markStarted();
    await new Promise(r => (releaseNext = r));
  });
  const stale = queue.enqueue(() => calls.push('wrong-screen'));
  await started;
  queue.cancel();
  releaseNext();
  await Promise.all([current, stale]);
  assert.deepEqual(calls, ['click', 'type']);
  await queue.enqueue(() => calls.push('new-screen'));
  assert.equal(calls.at(-1), 'new-screen');
});
