// Isolated app and synthetic approvals; no command or model is ever executed.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';
class Runtime extends EventEmitter {
  async stop() {}
  async request() {
    throw Error('No model calls allowed in this fixture');
  }
}
const root = path.resolve('.test-data');
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'tool-ui-'));
const app = await createApp({
  dataDir: dir,
  port: 0,
  startEngine: false,
  runtime: new Runtime(),
  claudeRuntime: new Runtime(),
});
const { bot, chat } = app.store.createBot({ name: 'Tool presentation fixture' });
app.store.data.settings.language = 'en';
const command =
  'printf "%s\\n" "שלום <script>test</script>"\n' + '# long command '.repeat(150) + ' END';
const detail = JSON.stringify({
  id: 'historical-id',
  type: 'commandExecution',
  tool: 'Bash',
  command,
  status: 'completed',
  aggregatedOutput: 'hello <b>world</b>',
  exitCode: 0,
});
app.store.message(chat.id, 'tool', command, {
  botId: bot.id,
  kind: 'commandExecution',
  status: 'completed',
  detail,
});
const original = app.store.data.messages.find(m => m.detail === detail);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(id => localStorage.setItem('stellarcortex-chat', id), chat.id);
  const url = `http://127.0.0.1:${app.port}/#key=${app.accessKey}`;
  await page.goto(url);
  await page.locator('.tool-entry summary').click();
  assert.equal(await page.locator('.tool-details pre').first().textContent(), command);
  assert.equal(await page.locator('.tool-details script').count(), 0);
  assert.ok((await page.locator('.tool-entry').innerText()).includes('Completed'));
  await page.screenshot({ path: path.join(root, 'tool-details-desktop.png') });
  for (const [i, action] of ['yes', 'no', 'cancel'].entries()) {
    const job = {
      id: `fixture-job-${i}`,
      botId: bot.id,
      chatId: chat.id,
      status: 'running',
      provider: 'codex',
    };
    app.store.data.jobs.push(job);
    app.engine.active.set(job.id, job);
    const result = app.engine.approval(job, 'item/commandExecution/requestApproval', {
      command,
      input: { command, description: 'Bash command' },
      cwd: '/tmp/fixture',
      reason: 'Review this exact command',
      privileged: false,
      permissions: { network: false },
    });
    await page.reload();
    await page.locator('[data-approval]').waitFor();
    assert.equal(await page.locator('.approval .tool-details pre').first().textContent(), command);
    assert.ok((await page.locator('.approval').innerText()).includes('/tmp/fixture'));
    if (i === 1) {
      app.store.data.settings.language = 'he';
      app.store.save();
      await page.reload();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-approval]').waitFor();
      assert.equal(await page.locator('.approval').getAttribute('dir'), 'rtl');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, 'tool-details-mobile-he.png') });
    }
    if (action === 'cancel') await page.locator('#stop-jobs').click();
    else await page.locator(`[data-answer][data-allow="${action}"]`).click();
    const answer = await result;
    assert.equal(answer.approve, action === 'yes');
    await page.locator('[data-approval]').waitFor({ state: 'detached' });
    app.engine.active.delete(job.id);
    job.status = 'completed';
    app.store.save();
  }
  app.store.message(chat.id, 'tool', 'new output', {
    botId: bot.id,
    kind: 'mcpToolCall',
    status: 'failed',
    detail: JSON.stringify({ tool: 'fixture', error: 'readable failure', output: ['safe output'] }),
  });
  await page.reload();
  assert.equal(await page.locator('.tool-entry').count(), 2);
  assert.equal(original.detail, detail);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: persisted/new records; full command and output; escaped HTML; real approval allow/deny/cancel endpoints; desktop and Hebrew mobile layout; no model/command execution.',
  );
} finally {
  await browser.close();
  await app.close();
}
