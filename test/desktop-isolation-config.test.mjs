import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { loadDesktopIsolation } from '../src/desktop-isolation-config.mjs';
test('fresh computer isolation does not depend on old VM configuration and never guesses native capabilities', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-runtime-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'isolation.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      providers: { 'openai-api': { enabled: true }, codex: { enabled: false } },
    }),
    { mode: 0o600 },
  );
  const value = await loadDesktopIsolation({ file, trustedUid: process.getuid() });
  assert.equal(value.enabled, true);
  assert.equal(value.providerIsolation['openai-api'], true);
  assert.equal(value.providerIsolation.codex, false);
  assert.equal(value.codexExecutable, null);
});
test('native runtime tampering and writable policy fail closed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-runtime-pin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'isolation.json'),
    executable = path.join(dir, 'runner');
  fs.writeFileSync(executable, 'original', { mode: 0o700 });
  const cfg = {
    version: 1,
    providers: {
      claude: {
        enabled: true,
        executable,
        sha256: createHash('sha256').update('original').digest('hex'),
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  assert.equal(
    (await loadDesktopIsolation({ file, trustedUid: process.getuid() })).providerIsolation.claude,
    true,
  );
  fs.writeFileSync(executable, 'changed');
  const changed = await loadDesktopIsolation({ file, trustedUid: process.getuid() });
  assert.equal(changed.providerIsolation.claude, false);
  assert.match(changed.problems.claude, /changed since it was pinned/);
  fs.chmodSync(file, 0o666);
  await assert.rejects(loadDesktopIsolation({ file, trustedUid: process.getuid() }), /Trusted/);
});
test('a runner that fails its pin is off with the steps to fix it, and the app still starts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-runtime-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});
  const file = path.join(dir, 'isolation.json'),
    claude = '/runners/claude',
    codex = '/runners/codex',
    gone = '/runners/gone',
    sha = text => createHash('sha256').update(text).digest('hex');
  t.mock.method(fs, 'createReadStream', target => Readable.from([path.basename(target)]));
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => {
    if (target === gone) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return [file, claude, codex].includes(target)
      ? { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100755 }
      : lstat(target, ...rest);
  });
  const load = providers => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, providers }));
    return loadDesktopIsolation({ file, trustedUid: 0 });
  };
  const good = { enabled: true, executable: claude, sha256: sha('claude') };
  // The pin alone is enough: a user service has no drop-in that could set CLAUDE_BIN.
  const pinned = await load({ claude: good });
  assert.equal(pinned.providerIsolation.claude, true);
  assert.equal(pinned.claudeExecutable, claude);
  assert.deepEqual(pinned.problems, {});
  const wrong = await load({ claude: { ...good, sha256: 'a'.repeat(64) } });
  assert.equal(wrong.providerIsolation.claude, false);
  assert.equal(wrong.claudeExecutable, null, 'no unverified program runs');
  assert.match(wrong.problems.claude, /upgrade-approved\.sh.*computer tools stay off/);
  assert.match((await load({ claude: { ...good, executable: gone } })).problems.claude, /missing/);
  const old = await load({
    codex: { enabled: true, executable: codex, sha256: sha('codex'), policySha256: 'b'.repeat(64) },
  });
  assert.equal(old.providerIsolation.codex, false);
  assert.equal(old.codexExecutable, null, 'no unverified program runs');
  assert.match(old.problems.codex, /new Codex tool policy/);
  await assert.rejects(load({ claude: { enabled: true } }), /Pinned native runtime required/);
});
test('the bot gets the reason, not a bare refusal', async () => {
  const { GuestExecution } = await import('../src/guest-execution.mjs'),
    execution = new GuestExecution({}, { enabled: true, providerIsolation: { codex: false } });
  assert.throws(() => execution.assertReady('codex'), /not verified/);
  execution.problems = { codex: 'Run upgrade-approved.sh' };
  assert.throws(() => execution.assertReady('codex'), /upgrade-approved/);
});
