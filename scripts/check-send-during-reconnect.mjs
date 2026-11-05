// Isolated browser check: a message the server accepted stays visible while the connection is down. No model is called.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';

class Runtime extends EventEmitter {
  async stop() {}
  async request() {
    throw new Error('No model calls allowed in this fixture');
  }
}
const root = path.resolve('.test-data');
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'send-'));
const app = await createApp({
  dataDir: dir,
  port: 0,
  startEngine: false,
  runtime: new Runtime(),
  claudeRuntime: new Runtime(),
});
app.store.data.settings.language = 'en';
const { chat } = app.store.createBot({ name: 'Reconnect fixture' });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => localStorage.setItem('stellarcortex-chat', id), chat.id);
  await page.goto(`http://127.0.0.1:${app.port}/#key=${app.accessKey}`);
  await page.locator('#prompt').waitFor();
  // The stream and every refresh fail from here on, as when a proxy drops the connection right after the send.
  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/state', route => route.abort());
  const text = 'Sent while the connection drops';
  await page.locator('#prompt').fill(text);
  await page.locator('#send').click();
  await page.locator('.conversation').getByText(text).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(
    await page.locator('#toast').isHidden(),
    true,
    'an accepted message is not reported as failed',
  );
  await page.unroute('**/api/state');
  await page.reload();
  await page.locator('.conversation').getByText(text).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.conversation').getByText(text).count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    'A sent message stays visible with the stream and refresh down, and shows once after reconnecting.',
  );
} finally {
  await browser.close();
  await app.close();
  assert.equal(path.dirname(dir), root);
  fs.rmSync(dir, { recursive: true, force: true });
}
