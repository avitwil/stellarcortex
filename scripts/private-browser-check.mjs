import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { launchPrivateBrowser } from '../src/private-browser.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-private-test-'));
fs.chmodSync(root, 0o700);
let context;
try {
  context = await launchPrivateBrowser(chromium, {
    executablePath: chromium.executablePath(),
    profile: path.join(root, 'profile'),
    runtime: root,
    headless: true,
  });
  const a = context.pages()[0],
    b = await context.newPage();
  await a.setContent('<title>one</title>');
  await b.setContent('<title>two</title>');
  await a.bringToFront();
  assert.equal(await a.evaluate(() => document.visibilityState), 'visible');
  assert.equal(await b.evaluate(() => document.visibilityState), 'hidden');
  await b.bringToFront();
  assert.equal(await a.evaluate(() => document.visibilityState), 'hidden');
  assert.equal(await b.evaluate(() => document.visibilityState), 'visible');
  const socket = path.join(
    root,
    fs.readdirSync(root).find(x => x.startsWith('scx-cdp-')),
    'browser.sock',
  );
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  await context.close();
  context = null;
  assert.equal(
    fs.readdirSync(root).some(x => x.startsWith('scx-cdp-')),
    false,
  );
  console.log('Private Unix transport, true tab visibility, mode0600, clean shutdown: passed');
} finally {
  await context?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
