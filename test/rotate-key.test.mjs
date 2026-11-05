import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { rotate } from '../scripts/rotate-key.mjs';
import { createApp } from '../src/server.mjs';
import { installationKey, ownerAccount, rotateKey } from '../src/store.mjs';

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-rotate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
class Runtime extends EventEmitter {
  async stop() {}
}
test('a new key keeps the owner identity that the computers are registered to', t => {
  const dir = temp(t),
    first = installationKey(dir),
    account = createHash('sha256')
      .update('android-owner-v1:' + first)
      .digest('hex');
  assert.equal(ownerAccount(dir), account);
  rotateKey(dir);
  const second = installationKey(dir);
  assert.notEqual(second, first);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.equal(ownerAccount(dir), account);
  rotateKey(dir);
  assert.notEqual(installationKey(dir), second);
  assert.equal(ownerAccount(dir), account);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['access-key', 'owner-account']);
  if (process.platform !== 'win32')
    for (const name of ['access-key', 'owner-account'])
      assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
});
test('the running service restarts, and the new key is never printed', t => {
  const dir = temp(t),
    calls = [],
    lines = [],
    old = installationKey(dir);
  rotate({
    data: dir,
    log: line => lines.push(line),
    run: (_, args) => {
      calls.push(args.at(-2));
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, ['--quiet', 'restart']);
  const printed = lines.join('\n');
  assert.ok(!printed.includes(installationKey(dir)));
  assert.ok(!printed.includes(old));
  assert.match(printed, /old key and every sign-in have stopped working/);
});
test('without a running service it says the old key still works, and a failed restart stops', t => {
  const dir = temp(t),
    lines = [];
  installationKey(dir);
  rotate({ data: dir, log: line => lines.push(line), run: () => ({ status: null }) });
  assert.match(lines.at(-1), /old key still works/);
  let calls = 0;
  assert.throws(
    () => rotate({ data: dir, log() {}, run: () => ({ status: calls++ ? 1 : 0 }) }),
    /Could not restart/,
  );
  assert.throws(() => rotate({ data: path.join(dir, 'none') }), /No access key/);
});
test('after a restart the old key is refused and the new one signs in', async t => {
  const dir = temp(t),
    old = installationKey(dir);
  rotateKey(dir);
  const app = await createApp({
    dataDir: dir,
    port: 0,
    runtime: new Runtime(),
    claudeRuntime: new Runtime(),
    startEngine: false,
  });
  const signIn = key =>
    fetch(`http://127.0.0.1:${app.port}/api/session`, {
      method: 'POST',
      headers: { 'X-StellarCortex-Client': '1' },
      body: JSON.stringify({ key }),
    });
  try {
    assert.equal((await signIn(old)).status, 401);
    assert.equal((await signIn(installationKey(dir))).status, 200);
  } finally {
    await app.close();
  }
});
