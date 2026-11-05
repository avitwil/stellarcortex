// Isolated browser verification: no real provider, credentials or update process.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';
import { SoftwareUpdates } from '../src/software-updates.mjs';
import { fakeSite, releaseKey, signedSite } from '../test/helpers/signed-release.mjs';

class Runtime extends EventEmitter {
  async stop() {}
  async request(method) {
    if (method === 'model/list') return { data: [{ model: 'fixture-model', isDefault: true }] };
    if (method === 'config/read') return { config: { model: 'fixture-model' } };
    throw new Error('UI fixture has no model connection');
  }
}
const root = path.resolve('.test-data');
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'software-ui-'));
let committed = 0;
const old = 'a'.repeat(40);
const key = releaseKey(),
  updates = new SoftwareUpdates({
    installed: { version: '0.1.0', commit: old, modified: false },
    manager: { prepare: async () => {}, commit: () => committed++ },
    keys: [key.pinned],
    fetchImpl: fakeSite(signedSite(key)),
  });
const app = await createApp({
  dataDir: dir,
  port: 0,
  startEngine: false,
  runtime: new Runtime(),
  claudeRuntime: new Runtime(),
  softwareUpdates: updates,
});
app.store.data.settings.language = 'en';
const bot = app.store.createBot({ name: 'Permission test bot', provider: 'claude' }).bot;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } }),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.port}/#key=${app.accessKey}`);
  await page.locator('#account').click();
  await page.locator('[data-account-action="settings"]').click();
  await page.locator('#claude-default-mode').waitFor();
  const botForm = page.locator(`[data-permission-bot="${bot.id}"]`);
  await botForm.locator('select').selectOption('free');
  page.once('dialog', dialog => dialog.dismiss());
  await botForm.locator('button').click();
  assert.equal(bot.claudePermissionMode, undefined);
  await botForm.locator('select').selectOption('automatic');
  await botForm.locator('button').click();
  await page.getByText('Setting saved', { exact: true }).waitFor();
  assert.equal(bot.claudePermissionMode, 'automatic');
  await page.locator('#claude-permission-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'software-permissions-en.png') });
  await page.locator('[data-settings-pane="updates"]').click();
  await page.getByText('A newer signed version is available.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-update-apply]').isEnabled(), true);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-update-apply]').click();
  assert.equal(committed, 0);
  await page.screenshot({ path: path.join(root, 'software-updates-en.png') });
  await page.locator('[data-settings-pane="general"]').click();
  await page.locator('#settings-form select[name="language"]').selectOption('he');
  await page.locator('#settings-form button.primary').click();
  await page.waitForFunction(
    () => document.querySelector('#modal-body')?.getAttribute('dir') === 'rtl',
  );
  await page.locator('#claude-default-mode').waitFor();
  await page.locator('#claude-permission-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'software-permissions-he.png') });
  await page.locator('[data-settings-pane="updates"]').click();
  await page.getByText('יש גרסה חדשה וחתומה.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'software-updates-he.png') });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-update-apply]').click();
  await page.getByText('מעדכן…').first().waitFor();
  assert.equal(committed, 1);
  assert.equal(await page.locator('[data-update-apply]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'English/Hebrew UI, RTL, permission persistence, dangerous cancellation and confirmed mock update passed. Screenshots: .test-data/software-*.png',
  );
} finally {
  await browser.close();
  await app.close();
  assert.equal(path.dirname(dir), root);
  fs.rmSync(dir, { recursive: true, force: true });
}
