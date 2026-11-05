import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteDesktopView } from '../public/remote-desktop.js';
class RFB extends EventTarget {
  static instances = [];
  constructor(element, url, options) {
    super();
    Object.assign(this, { element, url, options });
    RFB.instances.push(this);
  }
  disconnect() {
    this.dispatchEvent(new Event('disconnect'));
  }
}
test('view tickets use subprotocol, no query token; viewer remains read-only', async () => {
  RFB.instances = [];
  const v = new RemoteDesktopView({
    element: {},
    botId: 'a',
    RFB,
    origin: 'https://app.example',
    api: async () => ({ protocol: 'scx-display.fixture' }),
  });
  await v.connect();
  assert.equal(v.rfb.url, 'wss://app.example/api/desktops/a/display');
  assert.deepEqual(v.rfb.options.wsProtocols, ['scx-display.fixture']);
  assert.equal(v.rfb.viewOnly, true);
  assert.equal(v.rfb.resizeSession, false);
  v.disconnect();
});
test('late ownership grant after viewer removal is returned without connecting or input replay', async () => {
  RFB.instances = [];
  let resolve;
  const requests = [];
  const v = new RemoteDesktopView({
    element: {},
    botId: 'a',
    RFB,
    origin: 'https://app.example',
    api: async (path, data) => {
      requests.push(data);
      if (data.enabled === true) return new Promise(r => (resolve = r));
      return { ok: true };
    },
  });
  const pending = v.claim();
  v.disconnect();
  resolve({ epoch: 1, connectionId: 'fixture' });
  await pending;
  assert.equal(RFB.instances.length, 0);
  assert.equal(requests[1].enabled, false);
  assert.equal(v.lease, null);
});
