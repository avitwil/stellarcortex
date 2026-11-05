import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LibvirtDesktopBroker } from '../src/desktop-libvirt-broker.mjs';
import { DesktopEffectJournal } from '../src/desktop-effect-journal.mjs';
import { guestEnvelope, callRegisteredGuest } from '../src/desktop-guest-channel.mjs';
import { connectSessionConsole } from '../src/desktop-session-console.mjs';
import { desktopScope } from '../src/desktop-provider-session.mjs';
const record = botId => ({
  accountId: 'owner',
  environmentId: 'env',
  computerId: 'computer',
  botId,
  sessionId: 'session-' + botId,
  vmId: '01',
  generation: 'one',
  uid: botId === 'a' ? 1101 : 1102,
  cid: 151,
  domain: 'scx-desktop-01',
  uuid: '11111111-1111-1111-1111-111111111111',
});
test('session input, capture and release never use the VM-wide QMP console', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-session-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = record('a'),
    b = record('b'),
    commands = [],
    calls = [];
  let finish;
  const broker = new LibvirtDesktopBroker({
    registry: { get: (_account, bot) => (bot === 'a' ? a : b) },
    approved: true,
    effects: new DesktopEffectJournal(path.join(dir, 'effects.json')),
    run: async args => {
      commands.push(args);
      return { stdout: a.uuid };
    },
    callGuest: async (r, input) => {
      calls.push({ bot: r.botId, method: input.method });
      if (input.requestId === 'first-input') return new Promise(resolve => (finish = resolve));
      return { ok: true };
    },
  });
  const first = broker.input({
    scope: a,
    requestId: 'first-input',
    action: { action: 'key', key: 'Enter' },
    frame: { width: 800, height: 600 },
  });
  const deadline = Date.now() + 5000;
  let failure;
  first.catch(error => {
    failure = error;
  });
  while (!finish && !failure && Date.now() < deadline)
    await new Promise(resolve => setImmediate(resolve));
  if (failure) throw failure;
  assert.ok(finish, 'first input never reached the guest');
  await broker.input({
    scope: b,
    requestId: 'second-input',
    action: { action: 'key', key: 'Enter' },
    frame: { width: 800, height: 600 },
  });
  await assert.rejects(
    broker.input({
      scope: a,
      requestId: 'same-session',
      action: { action: 'key', key: 'Enter' },
      frame: { width: 800, height: 600 },
    }),
    /running operation/,
  );
  await broker.capture(b);
  await broker.release({ scope: b, requestId: 'release-b' });
  finish({ ok: true });
  await first;
  assert.deepEqual(
    calls.map(c => c.method),
    ['desktop.input', 'desktop.input', 'desktop.snapshot', 'desktop.releaseInputs'],
  );
  assert.ok(commands.every(c => c[0] === 'domuuid'));
  assert.throws(
    () => broker.change({ scope: a, action: 'shutdown', requestId: 'stop-all' }),
    /environment-level/,
  );
});
test('guest requests and replies bind the full session identity', async () => {
  const r = record('a'),
    input = { scope: r, requestId: 'session-request', method: 'desktop.snapshot' };
  assert.equal(guestEnvelope(r, input).sessionId, r.sessionId);
  assert.throws(() => guestEnvelope(r, { ...input, scope: { ...r, botId: 'b' } }), /identity/);
  const reply = { ...guestEnvelope(r, input), result: { ok: true }, sessionId: 'other-session' };
  await assert.rejects(
    callRegisteredGuest(r, input, {
      spawnImpl: (_file, args) => {
        assert.equal(args[4], '701');
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        child.stdin.on('finish', () => {
          child.stdout.write(JSON.stringify(reply));
          queueMicrotask(() => child.emit('exit', 0));
        });
        return child;
      },
    }),
    /identity/,
  );
});
test('display connector validates identity before forwarding RFB bytes', async () => {
  const r = record('a');
  let payload = '',
    child;
  const stream = connectSessionConsole(r, {
    spawnImpl: (_file, args) => {
      assert.equal(args[2], '151');
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      child.stdin.on('data', bytes => {
        payload += bytes;
      });
      return child;
    },
  });
  const connected = new Promise(resolve => stream.once('connect', resolve)),
    chunks = [];
  stream.on('data', b => chunks.push(b));
  child.stdout.write(JSON.stringify({ ready: true, scope: desktopScope(r) }) + '\nRFB 003.008\n');
  await connected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(payload).channel, 'display');
  assert.equal(Buffer.concat(chunks).toString(), 'RFB 003.008\n');
  stream.destroy();
});
import { validateDesktopRegistrations } from '../src/desktop-session-registration.mjs';
test('shared VM registry cannot coexist with its unprivileged legacy transport or duplicate users', () => {
  const a = record('a'),
    b = record('b');
  assert.equal(validateDesktopRegistrations([a, b]).length, 2);
  const old = { accountId: 'owner', botId: 'old', vmId: '01', generation: 'one' };
  assert.throws(() => validateDesktopRegistrations([a, old]), /legacy unprivileged/);
  assert.throws(
    () => validateDesktopRegistrations([a, { ...old, generation: 'older' }]),
    /legacy unprivileged/,
  );
  assert.throws(
    () => validateDesktopRegistrations([a, { ...b, environmentId: 'other' }]),
    /One environment/,
  );
  assert.throws(
    () => validateDesktopRegistrations([a, { ...b, uid: a.uid }]),
    /distinct Unix users/,
  );
});

test('retired legacy uncertain work is preserved without dispatching its identity into a new session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-retired-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = record('a'),
    effects = new DesktopEffectJournal(path.join(dir, 'effects.json'));
  const legacy = { accountId: r.accountId, botId: r.botId, vmId: r.vmId, generation: r.generation };
  effects.records['old-uncertain'] = {
    scope: legacy,
    state: 'uncertain',
    kind: 'guest',
    method: 'desktop.type',
  };
  effects.save();
  const before = JSON.stringify(effects.records['old-uncertain']);
  const calls = [];
  const broker = new LibvirtDesktopBroker({
    registry: { get: () => r },
    approved: true,
    effects,
    run: async () => ({ stdout: r.uuid }),
    callGuest: async (record, input) => {
      guestEnvelope(record, input);
      calls.push(input);
      return { ok: true };
    },
  });
  await broker.guest({
    scope: r,
    requestId: 'fresh-session-work',
    method: 'shell.run',
    args: { command: '/usr/bin/true' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'shell.run');
  assert.equal(JSON.stringify(effects.records['old-uncertain']), before);
});
