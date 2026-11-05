import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopWorkspace, normalizeKey, linuxKeySequence } from '../src/desktop.mjs';

class FakeDesktop {
  constructor() {
    this.calls = [];
    this.screen = { x: -1920, y: 0, width: 3840, height: 1080 };
    this.active = 0;
    this.peak = 0;
    this.closed = false;
  }
  async request(a) {
    this.calls.push(a);
    this.active++;
    this.peak = Math.max(this.active, this.peak);
    await new Promise(r => setTimeout(r, 2));
    this.active--;
    return {
      available: true,
      mode: 'x11-desktop',
      width: 1600,
      height: 450,
      screen: { ...this.screen },
      ...(a.action === 'snapshot'
        ? { image: 'fake-test-only-image', mimeType: 'image/jpeg' }
        : { ok: true }),
    };
  }
  async close() {
    this.closed = true;
  }
}
const setup = () => {
  const transport = new FakeDesktop();
  return { transport, desktop: new DesktopWorkspace('.', { platform: 'linux', transport }) };
};
test('Linux keyboard chords do not inject an implicit Shift for uppercase shortcut letters', () => {
  assert.equal(linuxKeySequence('Control+L'), 'ctrl+l');
  assert.equal(linuxKeySequence(normalizeKey('Ctrl+A')), 'ctrl+a');
  assert.equal(linuxKeySequence('Control+l'), 'ctrl+l');
  assert.equal(linuxKeySequence('Control+Shift+L'), 'ctrl+shift+l');
  assert.equal(linuxKeySequence('Shift+A'), 'shift+a');
  assert.equal(linuxKeySequence('Alt+F4'), 'alt+F4');
  assert.equal(linuxKeySequence('Meta+R'), 'super+r');
  assert.equal(linuxKeySequence('L'), 'L');
  assert.equal(linuxKeySequence('l'), 'l');
});

test('desktop run lock and human takeover exclude other bots and require explicit manual takeover', async () => {
  const { desktop } = setup();
  desktop.acquire('a', 'run-a');
  assert.throws(() => desktop.acquire('b', 'run-b'), /in use/);
  await assert.rejects(desktop.action('b', { action: 'key', key: 'Enter' }), /in use/);
  desktop.setTakeover('b', true);
  await assert.rejects(desktop.action('a', { action: 'key', key: 'Enter' }), /user has/);
  await assert.rejects(desktop.action('a', { action: 'key', key: 'Enter' }, true), /Take control/);
  await desktop.action('b', { action: 'key', key: 'Enter' }, true);
  desktop.setTakeover('b', false);
  desktop.release('run-a');
  desktop.acquire('b', 'run-b');
  assert.equal((await desktop.status()).ownerBotId, 'b');
  await desktop.close();
});
test('desktop maps screenshot coordinates to native multi-monitor geometry and rejects stale frames', async () => {
  const { desktop, transport } = setup();
  const frame = await desktop.snapshot('a');
  await desktop.action('a', { action: 'click', x: 800, y: 225, frameId: frame.frameId });
  const click = transport.calls.find(x => x.action === 'click');
  assert.equal(click.x, 0);
  assert.equal(click.y, 540);
  await assert.rejects(
    desktop.action('a', { action: 'click', x: 1, y: 1, frameId: frame.frameId }),
    /stale/,
  );
  const next = await desktop.snapshot('a');
  transport.screen.width = 1920;
  await assert.rejects(
    desktop.action('a', { action: 'click', x: 1, y: 1, frameId: next.frameId }),
    /geometry changed/,
  );
  assert.equal(transport.calls.filter(x => x.action === 'click').length, 1);
  await desktop.close();
});
test('desktop validates keys and coordinates before sending native input', async () => {
  const { desktop, transport } = setup();
  assert.deepEqual(normalizeKey('Ctrl+A'), ['Control', 'A']);
  assert.deepEqual(normalizeKey('Win+R'), ['Meta', 'R']);
  assert.throws(() => normalizeKey('Enter+Delete'));
  assert.throws(() => normalizeKey('Control+$(evil)'));
  await desktop.snapshot('a');
  await assert.rejects(desktop.action('a', { action: 'click', x: -1, y: 2 }), /outside/);
  await assert.rejects(desktop.action('a', { action: 'type', text: 'x'.repeat(4001) }), /4000/);
  await assert.rejects(desktop.action('a', { action: 'scroll', amount: NaN }), /nonzero/);
  assert.equal(
    transport.calls.filter(x => ['click', 'key', 'type', 'scroll'].includes(x.action)).length,
    0,
  );
  await desktop.close();
});
test('desktop serializes concurrent worker requests and disables queued input immediately', async () => {
  const { desktop, transport } = setup();
  await Promise.all([desktop.snapshot('a'), desktop.snapshot('b'), desktop.status()]);
  assert.equal(transport.peak, 1);
  const pending = desktop.action('a', { action: 'key', key: 'Enter' });
  const closing = desktop.close();
  await assert.rejects(pending, /shut down/);
  await closing;
  assert.equal(transport.calls.filter(x => x.action === 'key').length, 0);
  await desktop.close();
});
test('passive UI refresh preserves a model frame, while any desktop input expires every bot frame', async () => {
  const { desktop, transport } = setup();
  const observed = await desktop.snapshot('a');
  await desktop.snapshot('a');
  const other = await desktop.snapshot('b');
  await desktop.action('a', { action: 'click', x: 100, y: 100, frameId: observed.frameId });
  await assert.rejects(
    desktop.action('b', { action: 'click', x: 100, y: 100, frameId: other.frameId }),
    /stale/,
  );
  assert.equal(transport.calls.filter(x => x.action === 'click').length, 1);
  await desktop.close();
});
