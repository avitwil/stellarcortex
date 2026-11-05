import { checkDesktopLayout } from './check-desktop-layout.mjs';
import { fixtureConsole } from '../test/helpers/desktop-rfb-fixture.mjs';
// Integration check with an explicitly synthetic RFB console, never a VM claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
class Offline extends EventEmitter {
  ready = false;
  async start() {}
  stop() {}
  async request() {
    return { account: null, data: [] };
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-novnc-browser-'));
let accountId, botId;
const provider = {
  enabled: true,
  coordinator: new DesktopSessionCoordinator({ releaseInputs: async () => {} }),
  lookup: (account, bot) =>
    account === accountId && bot === botId
      ? { vmId: 'fixture-vm', generation: 'fixture-one', state: 'running' }
      : null,
  connectConsole: async () => fixtureConsole(),
};
const app = await createApp({
  dataDir: dir,
  port: 0,
  host: '127.0.0.1',
  startEngine: false,
  runtime: new Offline(),
  claudeRuntime: new Offline(),
  desktopProvider: provider,
});
accountId = createHash('sha256')
  .update('android-owner-v1:' + app.accessKey)
  .digest('hex');
botId = app.store.data.bots[0].id;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.port}/#key=${app.accessKey}`);
  await page.locator('#app').waitFor();
  await page.evaluate(async bot => {
    const { mountRemoteDesktop } = await import('/remote-desktop-provider.js');
    const element = document.createElement('div');
    document.body.replaceChildren(element);
    window.fixtureView = await mountRemoteDesktop({
      element,
      botId: bot,
      api: async (url, data) => {
        const response = await fetch(url, {
          method: data ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
          ...(data ? { body: JSON.stringify(data) } : {}),
        });
        const value = await response.json();
        if (!response.ok) throw Error(value.error);
        return value;
      },
    });
  }, botId);
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      if (!c) return false;
      const p = c.getContext('2d').getImageData(0, 0, 1, 1).data;
      return p[1] === 170;
    },
    {},
    { timeout: 10000 },
  );
  await checkDesktopLayout(page);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      actualChromium: true,
      actualNoVNC: '1.6.0',
      actualAuthenticatedAppRoutes: true,
      actualWebSocket: true,
      renderedFixtureFramebuffer: true,
      realVM: false,
      hostServicesStarted: false,
    }),
  );
  await page.evaluate(() => window.fixtureView.unmount());
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
