import { DesktopEffectJournal } from '../src/desktop-effect-journal.mjs';
// Real app UI/HTTP/store and image redaction with a clearly synthetic guest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
import { fixtureConsole } from '../test/helpers/desktop-rfb-fixture.mjs';
import { readSkillFrames } from '../src/computer-demonstration.mjs';
class Offline extends EventEmitter {
  ready = false;
  async start() {}
  stop() {}
  async request() {
    return { account: null, data: [] };
  }
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-teaching-ui-'));
let releases = 0,
  captures = 0;
const effects = new DesktopEffectJournal(path.join(dataDir, 'fixture-audit.json'));
let reviews = 0;
const png = execFileSync('/usr/bin/convert', ['-size', '16x16', 'xc:yellow', 'png:-']).toString(
  'base64',
);
const provider = new DesktopProviderRuntime({
  records: [],
  enabled: true,
  approved: true,
  broker: {
    operations: async scope => ({ operations: effects.list(scope) }),
    review: async input => {
      assert.equal(input.confirm, true);
      assert.equal(input.expectedDigest, effects.scoped(input.targetRequestId, input.scope).digest);
      reviews++;
      return effects.review(input.targetRequestId, input);
    },
    status: async () => ({ state: 'running' }),
    connectConsole: async () => fixtureConsole(),
    release: async () => {
      releases++;
      return { released: true };
    },
    capture: async () => {
      captures++;
      return { image: png, mimeType: 'image/png', width: 16, height: 16 };
    },
  },
});
const app = await createApp({
  dataDir,
  port: 0,
  host: '127.0.0.1',
  startEngine: false,
  runtime: new Offline(),
  claudeRuntime: new Offline(),
  desktopProvider: provider,
});
const accountId = createHash('sha256')
    .update('android-owner-v1:' + app.accessKey)
    .digest('hex'),
  botId = app.store.data.bots[0].id;
provider.records.set(accountId + '\0' + botId, {
  accountId,
  botId,
  vmId: 'fixture',
  generation: 'one',
  state: 'unknown',
});
const scope = { accountId, botId, vmId: 'fixture', generation: 'one' };
await assert.rejects(
  effects.execute(
    { scope, requestId: 'fixture-uncertain', operation: { action: 'input' } },
    async () => {
      throw Error('Synthetic lost confirmation');
    },
  ),
);
app.store.data.settings.language = 'en';
app.store.save();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.port}/#key=${app.accessKey}`);
  await page.locator('#show-computer').click();
  await page.getByRole('button', { name: 'Use desktop', exact: true }).click();
  await page.getByText('controlling', { exact: true }).waitFor();
  assert.equal(captures, 0);
  const leaseBefore = provider.coordinator.observation(scope).epoch;
  await page.locator('[data-desktop-window]').click();
  await page.getByRole('button', { name: 'Teach from screen', exact: true }).click();
  await page.locator('dialog[open]').waitFor();
  assert.equal(await page.locator('.desktop-window-expanded dialog[open]').count(), 1);
  await page.locator('dialog[open]').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-desktop-fullscreen]').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.equal(provider.coordinator.observation(scope).epoch, leaseBefore);
  await page.getByRole('button', { name: 'Teach from screen', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.locator('[name=objective]').fill('Recognize the sample screen');
  await dialog.getByRole('button', { name: 'Capture now', exact: true }).click();
  await dialog.locator('[data-source]').waitFor({ state: 'visible' });
  assert.equal(captures, 1);
  await dialog.locator('[name=masks]').fill('0,0,8,8');
  await dialog.locator('[name=safe]').check();
  await dialog.getByRole('button', { name: 'Create review preview' }).click();
  await dialog.locator('[data-review]').waitFor({ state: 'visible' });
  await dialog.locator('[name=name]').fill('Reviewed sample');
  await dialog
    .locator('[name=instructions]')
    .fill(
      'Inspect the current screen and compare the visible region. Ask for an explicit task before acting.',
    );
  await dialog.locator('[name=reviewed]').check();
  await dialog.getByRole('button', { name: 'Save skill for this bot' }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-status]')?.textContent.includes('Skill saved'),
  );
  assert.equal(app.store.data.skills.length, 1);
  assert.equal(app.store.data.skills[0].botId, botId);
  assert.equal(readSkillFrames(app.store, app.store.data.skills[0]).length, 1);
  assert.equal(app.store.data.jobs.length, 0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-desktop-window]').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('.desktop-window-expanded').count(), 0);
  assert.equal(provider.coordinator.observation(scope).epoch, leaseBefore);
  await page.getByRole('button', { name: 'Return to agent', exact: true }).click();
  await page.getByText('observing', { exact: true }).waitFor();
  assert.equal(releases, 1);
  await page.getByRole('button', { name: 'Operations and review', exact: true }).click();
  const reviewDialog = page.locator('dialog[open]');
  await reviewDialog.getByText('input · uncertain · fixture-uncertain', { exact: true }).waitFor();
  await reviewDialog.getByRole('button', { name: 'Record review and abandon' }).click();
  assert.equal(reviews, 0);
  await reviewDialog
    .locator('textarea')
    .fill('Synthetic test only: owner reviewed and abandoned without replay.');
  await reviewDialog.locator('input[type=checkbox]').check();
  await reviewDialog.getByRole('button', { name: 'Record review and abandon' }).click();
  await reviewDialog
    .getByText('input · reviewed-abandoned · fixture-uncertain', { exact: true })
    .waitFor();
  assert.equal(reviews, 1);
  assert.equal(effects.records['fixture-uncertain'].state, 'reviewed-abandoned');
  await reviewDialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      actualAppPanel: true,
      actualHttp: true,
      actualImageRedaction: true,
      actualSkillStore: true,
      reviewRequired: true,
      controlReturn: true,
      windowAndFullscreenTeaching: true,
      leasePreservedAcrossLayouts: true,
      explicitOperationReviewUI: true,
      modelTasks: 0,
      realGuest: false,
    }),
  );
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
