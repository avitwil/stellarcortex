import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { launchPrivateBrowser } from '../src/private-browser.mjs';
test('private CDP bridge uses pipes and Unix permissions, never a TCP listener or focus defaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-cdp-test-'));
  let args, ws;
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new PassThrough(), new PassThrough()];
  child.kill = () => child.emit('exit', 0);
  child.stdio[3].on('data', data => {
    assert.equal(data.at(-1), 0);
    const request = JSON.parse(data.subarray(0, -1));
    child.stdio[4].write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\0');
  });
  const context = {};
  try {
    const c = await launchPrivateBrowser(
      {
        connectOverCDP: async (endpoint, options) => {
          assert.ok(endpoint.startsWith('ws+unix://'));
          assert.equal(options.noDefaults, true);
          ws = new WebSocket(endpoint);
          await once(ws, 'open');
          const reply = once(ws, 'message');
          ws.send(JSON.stringify({ id: 1, method: 'Test.ping' }));
          assert.equal(JSON.parse((await reply)[0]).result.ok, true);
          return {
            contexts: () => [context],
            newBrowserCDPSession: async () => ({ send: async () => child.emit('exit', 0) }),
            close: async () => {},
          };
        },
      },
      {
        runtime: root,
        profile: path.join(root, 'profile'),
        executablePath: '/known/chromium',
        spawnBrowser: (_exe, a) => {
          args = a;
          return child;
        },
      },
    );
    assert.ok(args.includes('--remote-debugging-pipe'));
    assert.equal(
      args.some(a => a.startsWith('--remote-debugging-port') || a === '--no-sandbox'),
      false,
    );
    const dir = fs.readdirSync(root).find(x => x.startsWith('scx-cdp-'));
    assert.equal(fs.statSync(path.join(root, dir, 'browser.sock')).mode & 0o777, 0o600);
    await c.close();
    assert.equal(fs.readdirSync(root).length, 0);
  } finally {
    ws?.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('rejects shared or symlinked runtime before spawning browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-cdp-invalid-'));
  try {
    fs.chmodSync(root, 0o755);
    await assert.rejects(launchPrivateBrowser({}, { runtime: root }), /Private owned/);
    fs.chmodSync(root, 0o700);
    fs.symlinkSync(root, root + '-link');
    await assert.rejects(launchPrivateBrowser({}, { runtime: root + '-link' }), /Private owned/);
  } finally {
    fs.rmSync(root + '-link', { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
