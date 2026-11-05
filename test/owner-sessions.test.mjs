import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { OwnerSessions } from '../src/owner-sessions.mjs';
import { createApp } from '../src/server.mjs';
import { installationKey, rotateKey } from '../src/store.mjs';

class Runtime extends EventEmitter {
  async stop() {}
  async request() {
    throw new Error('No model calls expected');
  }
}
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function withServer(dir, use) {
  const app = await createApp({
    dataDir: dir,
    port: 0,
    runtime: new Runtime(),
    claudeRuntime: new Runtime(),
    startEngine: false,
  });
  try {
    return await use(`http://127.0.0.1:${app.port}`);
  } finally {
    await app.close();
  }
}
const headers = cookie => ({ 'X-StellarCortex-Client': '1', Cookie: cookie });
const signIn = async (base, key) =>
  (
    await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'X-StellarCortex-Client': '1' },
      body: JSON.stringify({ key }),
    })
  ).headers
    .get('set-cookie')
    .split(';')[0];
const signedIn = async (base, cookie) =>
  (await fetch(base + '/api/state', { headers: headers(cookie) })).status === 200;

test('a restart keeps the sign-in, as after an update', async t => {
  const dir = temp(t),
    key = installationKey(dir),
    cookie = await withServer(dir, async base => {
      const value = await signIn(base, key);
      assert.equal(await signedIn(base, value), true);
      return value;
    });
  assert.equal(await withServer(dir, base => signedIn(base, cookie)), true);
});
test('a logout stays a logout after a restart', async t => {
  const dir = temp(t),
    key = installationKey(dir),
    cookie = await withServer(dir, async base => {
      const value = await signIn(base, key);
      await fetch(base + '/api/logout', { method: 'POST', headers: headers(value) });
      return value;
    });
  assert.equal(await withServer(dir, base => signedIn(base, cookie)), false);
});
test('a logout that cannot be saved still holds after a restart', t => {
  const dir = temp(t),
    sessions = new OwnerSessions(dir, 'key');
  sessions.set('kept', Date.now() + 60000);
  sessions.set('ended', Date.now() + 60000);
  sessions.save = () => false;
  assert.equal(sessions.delete('ended'), true);
  const next = new OwnerSessions(dir, 'key');
  assert.equal(next.get('ended'), undefined);
  assert.equal(next.get('kept'), undefined);
});
test('a logout that cannot be made to hold says so', async t => {
  const dir = temp(t),
    lines = [],
    original = console.error;
  console.error = line => lines.push(line);
  t.after(() => {
    console.error = original;
  });
  const key = installationKey(dir);
  await withServer(dir, async base => {
    const cookie = await signIn(base, key),
      file = path.join(dir, 'sessions.json');
    // A folder with something in it can be neither replaced nor removed.
    fs.rmSync(file);
    fs.mkdirSync(path.join(file, 'blocked'), { recursive: true });
    const response = await fetch(base + '/api/logout', {
      method: 'POST',
      headers: headers(cookie),
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Change the access key/);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(await signedIn(base, cookie), false);
    fs.rmSync(file, { recursive: true });
  });
  assert.equal(lines.length, 2);
});
test('a new access key ends every sign-in', async t => {
  const dir = temp(t),
    cookie = await withServer(dir, base => signIn(base, installationKey(dir)));
  rotateKey(dir);
  assert.equal(await withServer(dir, base => signedIn(base, cookie)), false);
});
test('the file holds no token, drops expired sign-ins and survives damage', t => {
  const dir = temp(t),
    file = path.join(dir, 'sessions.json'),
    sessions = new OwnerSessions(dir, 'key');
  sessions.set('live-token', Date.now() + 60000);
  sessions.set('old-token', Date.now() - 1);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes('live-token'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const next = new OwnerSessions(dir, 'key');
  assert.ok(next.get('live-token'));
  assert.equal(next.get('old-token'), undefined);
  assert.equal(next.get(undefined), undefined);
  assert.equal(new OwnerSessions(dir, 'other key').get('live-token'), undefined);
  fs.writeFileSync(file, 'not json');
  assert.equal(new OwnerSessions(dir, 'key').get('live-token'), undefined);
});
