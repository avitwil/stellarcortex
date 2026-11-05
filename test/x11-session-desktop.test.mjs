import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { X11SessionDesktop, x11SessionText } from '../src/x11-session-desktop.mjs';
const env = {
  DISPLAY: ':21',
  XAUTHORITY: '/private/session/.Xauthority',
  XDG_RUNTIME_DIR: '/run/user/1101',
};
test('X11 session adapter uses fixed executables and validates geometry before input', async () => {
  const calls = [],
    desktop = new X11SessionDesktop({
      env,
      run: async (file, args, opts) => {
        calls.push({ file, args, opts });
        return { stdout: '1280 800' };
      },
    });
  await desktop.input({
    action: { action: 'click', x: 12, y: 20 },
    frame: { width: 1280, height: 800 },
  });
  assert.deepEqual(calls[1].args, [
    'mousemove',
    '--sync',
    '12',
    '20',
    'click',
    '--repeat',
    '1',
    '--delay',
    '120',
    '1',
  ]);
  assert.equal(calls[1].opts.env.DISPLAY, ':21');
  await assert.rejects(
    desktop.input({ action: { action: 'click', x: 1, y: 1 }, frame: { width: 800, height: 600 } }),
    /geometry changed/,
  );
  await assert.rejects(
    desktop.input({
      action: { action: 'click', x: -1, y: 1 },
      frame: { width: 1280, height: 800 },
    }),
    /Coordinates/,
  );
  assert.equal(calls.filter(c => c.args[0] === 'mousemove').length, 1);
});
test('Unicode text goes to stdin, cancellation does not pretend all characters were typed', async () => {
  let received = '',
    args,
    child;
  const abort = new AbortController();
  const promise = x11SessionText('שלום🙂', {
    env,
    signal: abort.signal,
    spawnImpl: (_file, a) => {
      args = a;
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdin.on('data', b => (received += b));
      child.kill = () => queueMicrotask(() => child.emit('close', null));
      return child;
    },
  });
  abort.abort();
  const result = await promise;
  assert.equal(received, 'שלום🙂');
  assert.ok(!args.includes('שלום🙂'));
  assert.equal(result.partialInputPossible, true);
  assert.equal(result.submitted, undefined);
  assert.throws(
    () => x11SessionText('text', { env, signal: AbortSignal.abort() }),
    /before dispatch/,
  );
});
