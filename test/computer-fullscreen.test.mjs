import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerFullscreen } from '../public/computer-fullscreen.js';

function fixture() {
  let changed,
    exits = 0,
    handbacks = 0;
  const document = {
    fullscreenElement: null,
    addEventListener(type, handler) {
      changed = handler;
    },
    async exitFullscreen() {
      exits++;
      this.fullscreenElement = null;
      changed();
    },
  };
  const viewer = new ComputerFullscreen(document, () => {
    handbacks++;
  });
  return { document, viewer, changed: () => changed(), counts: () => ({ exits, handbacks }) };
}

test('fullscreen requests retain click activation and browser exit hands control back once', async () => {
  const f = fixture();
  let requested = false;
  const element = {
    requestFullscreen() {
      requested = true;
      f.document.fullscreenElement = element;
      f.changed();
      return Promise.resolve();
    },
  };
  const opening = f.viewer.open(element);
  assert.equal(requested, true);
  assert.equal(await opening, true);
  f.document.fullscreenElement = null;
  f.changed();
  f.changed();
  assert.deepEqual(f.counts(), { exits: 0, handbacks: 1 });
});

test('closing before fullscreen completes exits the late fullscreen without duplicate handback', async () => {
  const f = fixture();
  let complete;
  const element = {
    requestFullscreen() {
      return new Promise(resolve => {
        complete = resolve;
      });
    },
  };
  const opening = f.viewer.open(element);
  await f.viewer.close();
  f.document.fullscreenElement = element;
  f.changed();
  complete();
  assert.equal(await opening, false);
  assert.deepEqual(f.counts(), { exits: 1, handbacks: 0 });
});

test('unsupported or denied fullscreen preserves the application fallback', async () => {
  const f = fixture();
  assert.equal(await f.viewer.open({}), false);
  assert.equal(
    await f.viewer.open({ requestFullscreen: () => Promise.reject(new Error('Not allowed')) }),
    false,
  );
  assert.deepEqual(f.counts(), { exits: 0, handbacks: 0 });
});
