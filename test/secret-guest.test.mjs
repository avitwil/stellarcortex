import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DesktopEffectJournal } from '../src/desktop-effect-journal.mjs';
import { LibvirtDesktopBroker } from '../src/desktop-libvirt-broker.mjs';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
import { desktopEngineExecution } from '../src/desktop-engine-adapter.mjs';
import {
  callRegisteredGuest,
  guestEnvelope,
  passiveGuestMethod,
} from '../src/desktop-guest-channel.mjs';
import { GuestExecution } from '../src/guest-execution.mjs';
import { GuestWorker } from '../src/guest-worker.mjs';
import { VisibleBrowserWorkspace } from '../src/visible-browser.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

const CANARY = 'Cn4ry-Guest-5b7c1e90',
  secret = { username: 'owner', password: CANARY },
  target = {
    origin: 'https://site.example',
    host: 'site.example',
    submitHost: 'site.example',
    password: true,
    username: true,
  };
const scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'generation-one' },
  uuid = '11111111-1111-1111-1111-111111111111';
const hashes = value => [
  value,
  Buffer.from(value).toString('base64'),
  createHash('sha256').update(value).digest('hex'),
];
const clean = (text, label) => {
  for (const form of [...hashes(CANARY), ...hashes(JSON.stringify(secret))])
    assert.equal(text.includes(form), false, label);
};
function stack(t) {
  // Windows refuses fsync on a directory, which these journals do after each write.
  if (process.platform === 'win32') t.mock.method(fs, 'fsyncSync', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-guest-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const delivered = [],
    browser = {
      loginTarget: async () => target,
      deliverLogin: async (botId, facts, value) => {
        delivered.push({ botId, facts, value });
        return { status: 'submitted', passwordFieldStillShown: false };
      },
    };
  const ledgerFile = path.join(dir, 'guest.json'),
    auditFile = path.join(dir, 'audit.json'),
    worker = new GuestWorker({
      vmId: '01',
      generation: scope.generation,
      allowedBots: ['bot'],
      browser,
      workspace: dir,
      ledgerFile,
    });
  const broker = new LibvirtDesktopBroker({
    registry: { get: () => ({ ...scope, domain: 'scx-desktop-01', uuid, cid: 151 }) },
    approved: true,
    effects: new DesktopEffectJournal(auditFile),
    run: async () => ({ stdout: uuid }),
    callGuest: async (record, input) => {
      const reply = await worker.handle(JSON.parse(JSON.stringify(guestEnvelope(record, input))));
      if (reply.uncertain) throw new Error('uncertain');
      if (reply.error) throw new Error(reply.error);
      return reply.result;
    },
  });
  const provider = new DesktopProviderRuntime({ records: [scope], broker, enabled: true }),
    execution = desktopEngineExecution(provider, {
      accountId: 'owner',
      isolation: { enabled: true, providerIsolation: { 'openai-api': true } },
    });
  return { dir, delivered, ledgerFile, auditFile, worker, execution };
}
test('a password reaches the guest browser through the broker, and neither journal holds it or a hash of it', async t => {
  const f = stack(t);
  assert.deepEqual(await f.execution.browser.loginTarget('bot'), target);
  assert.deepEqual(await f.execution.browser.deliverLogin('bot', target, secret), {
    status: 'submitted',
    passwordFieldStillShown: false,
  });
  assert.deepEqual(f.delivered, [{ botId: 'bot', facts: target, value: secret }]);
  clean(fs.readFileSync(f.ledgerFile, 'utf8'), 'guest ledger');
  clean(fs.readFileSync(f.auditFile, 'utf8'), 'broker journal');
  await f.execution.browser.deliverLogin('bot', target, {
    username: 'owner',
    password: 'different',
  });
  assert.equal(
    new Set(
      Object.values(JSON.parse(fs.readFileSync(f.auditFile, 'utf8'))).map(record => record.digest),
    ).size,
    1,
    'the journal digest moved with the password',
  );
});
test('the ledger digest does not depend on the password, so it is no guessing oracle', async t => {
  const f = stack(t),
    request = transient => ({
      protocol: 'scx-guest-v1',
      vmId: '01',
      generation: scope.generation,
      botId: 'bot',
      requestId: 'login-request',
      method: 'browser.login',
      args: { target },
      transient,
    });
  await f.worker.handle(request(secret));
  const { transient, ...durable } = request(secret);
  assert.equal(
    JSON.parse(fs.readFileSync(f.ledgerFile, 'utf8'))['login-request'].digest,
    createHash('sha256').update(JSON.stringify(durable)).digest('hex'),
  );
  const replay = await f.worker.handle(request({ username: 'owner', password: 'other' }));
  assert.equal(replay.error, undefined);
  assert.equal(f.delivered.length, 1);
  assert.ok(transient);
});
test('the envelope carries the field only when set, and the helper gets it on stdin', async () => {
  const record = { ...scope, cid: 151 },
    input = { scope, requestId: 'login-request', method: 'browser.login', args: { target } };
  assert.equal('transient' in guestEnvelope(record, input), false);
  assert.deepEqual(guestEnvelope(record, { ...input, transient: secret }).transient, secret);
  assert.equal(passiveGuestMethod('browser.login.status'), true);
  assert.equal(passiveGuestMethod('browser.login'), false);
  let argv,
    stdin = '';
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', chunk => (stdin += chunk));
  child.kill = () => {};
  const reply = callRegisteredGuest(
    record,
    { ...input, transient: secret },
    {
      spawnImpl: (command, args) => {
        argv = args;
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({
              protocol: 'scx-guest-v1',
              vmId: '01',
              generation: scope.generation,
              requestId: 'login-request',
              result: { status: 'submitted' },
            }),
          );
          child.emit('exit', 0);
        });
        return child;
      },
    },
  );
  assert.deepEqual(await reply, { status: 'submitted' });
  assert.equal(JSON.stringify(argv).includes(CANARY), false);
  assert.ok(stdin.includes(CANARY));
});
test('a failure on the way to the guest is only a status', async () => {
  const guest = new GuestExecution(
    {
      call: async () => {
        throw new Error('transport lost near ' + CANARY);
      },
    },
    { enabled: true },
  );
  assert.deepEqual(await guest.browser.deliverLogin('bot', target, secret), {
    status: 'failed',
    passwordFieldStillShown: false,
  });
});
test('the session browser facade never turns a closed browser into a login', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-visible-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = new VisibleBrowserWorkspace(dir, {});
  assert.deepEqual(await browser.loginTarget('bot'), { status: 'no-field' });
  assert.deepEqual(await browser.deliverLogin('bot', target, secret), {
    status: 'failed',
    passwordFieldStillShown: false,
  });
});
test('a vm bot logs in through the guest and the app stores nothing of it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-guest-engine-')),
    store = new Store(dir),
    calls = [];
  const rpc = {
    generation: 'g',
    call: async (method, botId, args, requestId, transient) => {
      calls.push({ method, args, transient });
      return method === 'browser.login.status'
        ? target
        : { status: 'submitted', passwordFieldStillShown: false };
    },
  };
  const guest = new GuestExecution(rpc, { enabled: true, providerIsolation: { codex: true } }),
    runtime = new EventEmitter();
  runtime.stop = async () => {};
  const engine = new Engine(store, runtime, { close: async () => {} }, null, {
    guestExecution: guest,
    defaultVm: true,
  });
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const job = {
    id: 'job',
    botId: store.data.bots[0].id,
    chatId: store.data.chats[0].id,
    status: 'running',
    provider: 'codex',
  };
  store.data.jobs.push(job);
  engine.active.set(job.id, job);
  const result = engine.tool(job, 'stellarcortex_secret', { target: 'browser-login' });
  for (let i = 0; i < 200 && !store.data.approvals.length; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  engine.submitSecret(store.data.approvals[0].id, Buffer.from(`owner\0${CANARY}`));
  assert.equal(JSON.parse((await result)[0].text).status, 'submitted');
  assert.deepEqual(calls.at(-1), { method: 'browser.login', args: { target }, transient: secret });
  store.save();
  clean(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), 'state.json');
});
