import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionOnboarding } from '../src/desktop-session-onboarding.mjs';
test('automatic session setup is account/environment scoped and invokes only the fixed unit', () => {
  let calls = [];
  const config = {
    sessionProvisioning: { approved: true, accountId: 'owner', environmentId: 'env' },
    desktops: [],
  };
  const s = new SessionOnboarding({
    load: () => config,
    directory: '/nonexistent-session-fixture',
    run: (file, args) => {
      calls.push({ file, args });
      return new EventEmitter();
    },
  });
  assert.throws(() => s.ensure('other', 'env', 'bot', true), /not approved/);
  assert.throws(() => s.ensure('owner', 'other', 'bot', true), /not approved/);
  assert.throws(() => s.ensure('owner', 'env', '../root', true), /identity/);
  assert.equal(calls.length, 0);
  s.ensure('owner', 'env', 'bot', true);
  s.ensure('owner', 'env', 'bot', true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'start',
    '--no-block',
    'stellarcortex-session-provision@bot.service',
  ]);
});
test('a bot past the limit does not start a root unit on every tool call', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-onboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0,
    time = 1000;
  const s = new SessionOnboarding({
    directory,
    now: () => time,
    load: () => ({
      sessionProvisioning: { approved: true, accountId: 'owner', environmentId: 'env' },
      desktops: [],
    }),
    run: () => {
      calls++;
      return new EventEmitter();
    },
  });
  fs.writeFileSync(directory + '/bot.json', JSON.stringify({ state: 'session-limit' }));
  s.ensure('owner', 'env', 'bot', true);
  s.pending.clear();
  assert.equal(s.ensure('owner', 'env', 'bot', true).state, 'session-limit');
  assert.equal(calls, 1);
  time += 60000;
  s.ensure('owner', 'env', 'bot', true);
  assert.equal(calls, 2);
});
test('interrupted session setup is never retried automatically', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-onboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const s = new SessionOnboarding({
    directory,
    load: () => ({
      sessionProvisioning: { approved: true, accountId: 'owner', environmentId: 'env' },
      desktops: [],
    }),
    run: () => {
      calls++;
    },
  });
  for (const state of ['applying', 'needs-attention', 'ready']) {
    fs.writeFileSync(directory + '/bot.json', JSON.stringify({ state }));
    assert.equal(s.ensure('owner', 'env', 'bot', true).state, state);
  }
  assert.equal(calls, 0);
});
test('a session that could not start tells the owner why, and only an explicit check tries again', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-onboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const s = new SessionOnboarding({
    directory,
    load: () => ({
      sessionProvisioning: { approved: true, accountId: 'owner', environmentId: 'env' },
      desktops: [],
    }),
    run: () => {
      calls++;
      return new EventEmitter();
    },
  });
  for (const state of ['blocked', 'session-limit']) {
    fs.writeFileSync(directory + '/bot.json', JSON.stringify({ state, message: 'why' }));
    assert.equal(s.ensure('owner', 'env', 'bot', false).message, 'why');
    assert.equal(calls, 0);
    s.pending.clear();
    assert.equal(s.ensure('owner', 'env', 'bot', true).active, true);
    assert.equal(calls, 1);
    calls = 0;
  }
});
