import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  computerEmptyState,
  computerSetupText,
  desktopConnectionText,
  desktopFailureText,
} from '../public/computer-status.js';
import { RemoteDesktopView } from '../public/remote-desktop.js';
import { compact } from './helpers/source-text.mjs';

const en = (_he, english) => english,
  he = hebrew => hebrew;
test('a bot with no computer gets one empty state on the desktop, and keeps its browser view', () => {
  const empty = computerEmptyState({ computer: 'none', provider: false, mode: 'desktop', tr: en });
  assert.equal(empty.title, 'This bot has no computer');
  assert.match(empty.text, /Settings > Computer/);
  assert.match(
    computerEmptyState({ computer: 'none', provider: true, mode: 'desktop', tr: he }).title,
    /אין מחשב/,
  );
  assert.equal(
    computerEmptyState({ computer: 'none', provider: false, mode: 'browser', tr: en }),
    null,
  );
});
test('a virtual computer that does not exist says so in both views, and a real computer shows its panel', () => {
  for (const mode of ['desktop', 'browser'])
    assert.match(
      computerEmptyState({ computer: 'vm', provider: false, mode, tr: en }).text,
      /none is configured/,
    );
  assert.equal(
    computerEmptyState({ computer: 'host', provider: false, mode: 'desktop', tr: en }),
    null,
  );
  assert.equal(
    computerEmptyState({ computer: 'vm', provider: true, mode: 'desktop', tr: en }),
    null,
  );
});
test('the tab never promises a shared computer, and only the connecting panel can say Connecting', async () => {
  const app = compact(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
  assert.equal(app.includes('The shared computer screen'), false);
  assert.match(
    app,
    /const empty=computerEmptyState\([^]*?if\(empty\)\{[^]*?return;?\}\$\('#detail-body'\)\.innerHTML=`<div id="computer-workspace"><div class="computer-header">/,
  );
  const branch = app.slice(app.indexOf('if(empty){'), app.indexOf('<div id="computer-workspace">'));
  assert.equal(branch.includes('id="takeover"'), false);
  assert.equal(branch.includes('id="computer-screen"'), false);
});
test('computer setup shows a real status in the owner language', () => {
  assert.match(computerSetupText({ state: 'allocation-available' }, en), /Preparing/);
  assert.match(
    computerSetupText({ state: 'setup-required', message: 'raw' }, he),
    /אין מחשב וירטואלי/,
  );
  assert.match(computerSetupText({ state: 'access-disabled' }, en), /Settings > Computer/);
  assert.doesNotMatch(
    computerSetupText({ state: 'needs-attention', message: 'Guest setup failed' }, en),
    /Guest setup failed/,
  );
  assert.match(computerSetupText({ state: 'session-limit' }, he), /אין שולחן עבודה/);
  assert.match(
    computerSetupText({ state: 'session-limit' }, en),
    /no desktop.*chat works.*moved off.*keeps its place/,
  );
  assert.match(
    computerSetupText({ state: 'blocked', message: 'Start it first' }, en),
    /not ready yet/,
  );
  assert.equal(desktopConnectionText('disconnected', en), 'Disconnected. You can reconnect.');
  assert.equal(
    desktopFailureText('shut off', 'Run this', he),
    'המחשב הווירטואלי לא פועל. Run this',
  );
  assert.equal(desktopFailureText('running', 'Other', he), 'Other');
});
test("tests that start the server never read this host's desktop configuration", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'desktop-provider.json'), 'not json');
  const started = promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        STELLARCORTEX_DESKTOP_CONFIG_DIR: dir,
        STELLARCORTEX_DATA_DIR: path.join(dir, 'data'),
        PORT: '0',
        STELLARCORTEX_BIND: '127.0.0.2',
      },
      timeout: 20000,
    },
  );
  await assert.rejects(
    started,
    /trusted-owned|JSON/,
    'the server read the folder it was told to read',
  );
  for (const name of ['software-updates', 'container-bind', 'computer-mode']) {
    const text = await readFile(new URL(`./${name}.test.mjs`, import.meta.url), 'utf8');
    if (/\b(fork|execFile|spawn)\(/.test(text) && /(src.*server\.mjs|launch\.mjs)/.test(text))
      assert.match(text, /STELLARCORTEX_DESKTOP_CONFIG_DIR/, name);
  }
});
test('a stopped computer ends the connecting state, so the owner can reconnect', async () => {
  const states = [];
  const view = new RemoteDesktopView({
    element: {},
    botId: 'a',
    RFB: class {},
    origin: 'https://example.invalid',
    api: async () => {
      throw new Error('The computer is not running.');
    },
    onState: value => states.push(value),
  });
  await assert.rejects(view.connect('view'), /not running/);
  assert.deepEqual(states, ['connecting', 'disconnected']);
});
