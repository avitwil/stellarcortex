import { checkDesktopLayout } from './check-desktop-layout.mjs';
// Read-only real guest display check. Uses isolated app data and no model tasks. Requires privileged private-socket access for this QA invocation.
import { createDesktopBrokerClient } from '../src/desktop-broker-server.mjs';
import { execFileSync } from 'node:child_process';
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
const domain = process.argv[2];
if (!domain)
  throw Error('Usage: node scripts/desktop-real-display-check.mjs <registered computer domain>');
const uuid = execFileSync('/usr/bin/virsh', ['domuuid', domain], { encoding: 'utf8' }).trim();
assert.equal(
  execFileSync('/usr/bin/virsh', ['domstate', domain], { encoding: 'utf8' }).trim(),
  'running',
);
const registered = JSON.parse(
  fs.readFileSync('/etc/stellarcortex/desktop-broker.json', 'utf8'),
).desktops.find(r => r.uuid === uuid);
assert.ok(registered);
const brokerClient = createDesktopBrokerClient('/run/stellarcortex-desktop-broker/broker.sock');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-novnc-browser-'));
let accountId, botId;
const provider = {
  enabled: true,
  coordinator: new DesktopSessionCoordinator({
    releaseInputs: async () => {
      throw Error('Read-only verification');
    },
  }),
  lookup: (account, bot) =>
    account === accountId && bot === botId
      ? { vmId: registered.vmId, generation: uuid, state: 'running' }
      : null,
  connectConsole: async () => brokerClient.connectConsole(registered),
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
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
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
  await page
    .waitForFunction(
      () => {
        const c = document.querySelector('canvas');
        if (!c) return false;
        if (c.width < 640 || c.height < 480) return false;
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data,
          colors = new Set();
        for (let i = 0; i < pixels.length; i += 400)
          colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
        return (
          colors.size > 8 && document.querySelector('[role=status]')?.dataset.state === 'observing'
        );
      },
      {},
      { timeout: 20000 },
    )
    .catch(async error => {
      await page.screenshot({ path: '/tmp/scx-real-display-failure.png' });
      console.log(
        JSON.stringify({ status: await page.locator('[role=status]').textContent(), errors }),
      );
      throw error;
    });
  await checkDesktopLayout(page);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/scx-real-ubuntu-novnc.png' });
  console.log(
    JSON.stringify({
      actualChromium: true,
      actualNoVNC: '1.6.0',
      actualAuthenticatedAppRoutes: true,
      actualWebSocket: true,
      realVM: true,
      domain,
      uuid,
      readOnly: true,
      throughRegisteredBroker: true,
      screenshot: '/tmp/scx-real-ubuntu-novnc.png',
      installedDesktopAcceptance: false,
    }),
  );
  await page.evaluate(() => window.fixtureView.unmount());
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
