import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
import { desktopEngineExecution } from '../src/desktop-engine-adapter.mjs';
import { loadDesktopProvider } from '../src/desktop-provider-config.mjs';
const scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'generation-one' },
  isolation = {
    enabled: true,
    providerIsolation: { codex: true },
    codexExecutable: '/verified/codex',
    claudeExecutable: '/verified/claude',
  };
test('engine adapter routes browser and files to registered VM and shares human priority with QMP', async () => {
  const calls = [],
    broker = {
      status: async () => ({ state: 'running' }),
      guest: async input => {
        calls.push(input);
        return {};
      },
      capture: async () => ({ width: 100, height: 100, image: 'fixture' }),
      input: async input => {
        calls.push(input);
        return {};
      },
      release: async () => ({ released: true }),
    };
  const provider = new DesktopProviderRuntime({
    records: [scope, { ...scope, botId: 'second', vmId: '02' }],
    broker,
    enabled: true,
  });
  const engine = desktopEngineExecution(provider, { accountId: 'owner', isolation });
  assert.equal(engine.codexExecutable, isolation.codexExecutable);
  assert.equal(engine.claudeExecutable, isolation.claudeExecutable);
  assert.equal(engine.admissionPaused, false);
  await engine.health('bot');
  await engine.file('bot', { action: 'read', path: 'example.txt' });
  assert.equal(calls.at(-1).scope.vmId, '01');
  const lease = await provider.coordinator.claim(scope, 'human');
  await assert.rejects(
    engine.browser.action('bot', { action: 'click', selector: 'button' }),
    /Human/,
  );
  await engine.browser.action('second', { action: 'read' });
  assert.equal(calls.at(-1).scope.vmId, '02');
  await assert.rejects(
    engine.file('missing', { action: 'read', path: 'x' }),
    /fallback is disabled/,
  );
  await provider.coordinator.release(scope, lease);
  const frame = await engine.desktop.snapshot('bot');
  await assert.rejects(
    engine.desktop.action('bot', { action: 'click', x: 1, y: 1, frameId: 'old' }),
    /fresh/,
  );
  await engine.desktop.action('bot', { action: 'click', x: 1, y: 1, frameId: frame.frameId });
  assert.equal(calls.at(-1).action.action, 'click');
  await assert.rejects(engine.browser.setTakeover('bot', true), /lease/);
  await assert.rejects(engine.reconcile(), /durable/);
  await provider.close();
});
test('an enabled manifest without the isolation file starts the app with no virtual computers, and a bad manifest still stops it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-no-isolation-')),
    file = path.join(dir, 'provider.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) =>
    target === file
      ? { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100600 }
      : lstat(target, ...rest),
  );
  const said = t.mock.method(console, 'error', () => {}),
    manifest = {
      enabled: true,
      provider: 'qemu-kvm-ubuntu-desktop',
      brokerSocket: '/run/stellarcortex-desktop-broker/broker.sock',
      records: [],
    };
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(
    loadDesktopProvider({ file, dataDir: dir, isolation: null, brokerFactory: () => ({}) }),
    null,
  );
  assert.match(said.mock.calls[0].arguments[0], /desktop-isolation\.json/);
  fs.writeFileSync(file, JSON.stringify({ ...manifest, brokerSocket: '/tmp/untrusted.sock' }));
  assert.throws(
    () => loadDesktopProvider({ file, dataDir: dir, isolation: null, brokerFactory: () => ({}) }),
    /refusing fallback/,
  );
});
test('the running app picks up the environment policy when the first computer registers', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-policy-')),
    file = path.join(dir, 'provider.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) =>
    target === file
      ? { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100600 }
      : lstat(target, ...rest),
  );
  const manifest = {
    enabled: true,
    provider: 'qemu-kvm-ubuntu-desktop',
    brokerSocket: '/run/stellarcortex-desktop-broker/broker.sock',
    records: [],
  };
  fs.writeFileSync(file, JSON.stringify(manifest));
  const { desktopProvider } = loadDesktopProvider({
    file,
    dataDir: dir,
    isolation,
    brokerFactory: () => ({}),
  });
  assert.equal(desktopProvider.environmentPolicy, null);
  const environmentComputer = {
    accountId: 'owner',
    environmentId: 'scx-desktop-02',
    computerId: 'scx-desktop-02',
    defaultAccess: false,
    overrides: {},
  };
  fs.writeFileSync(file, JSON.stringify({ ...manifest, environmentComputer }));
  desktopProvider.reload();
  assert.equal(desktopProvider.environmentPolicy.environmentId, 'scx-desktop-02');
  assert.equal(desktopProvider.environmentPolicy.defaultAccess, false);
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...manifest,
      environmentComputer: { ...environmentComputer, defaultAccess: 'yes' },
    }),
  );
  assert.equal(desktopProvider.environmentPolicy.defaultAccess, false);
  const owner = createHash('sha256')
      .update('android-owner-v1:' + fs.readFileSync(path.join(dir, 'access-key'), 'utf8').trim())
      .digest('hex'),
    row = {
      accountId: owner,
      botId: 'old-bot',
      vmId: '05',
      generation: 'one',
      uuid: '33333333-3333-3333-3333-333333333333',
      domain: 'scx-desktop-05',
      cid: 155,
    };
  fs.writeFileSync(file, JSON.stringify({ ...manifest, records: [row] }));
  desktopProvider.reload();
  assert.equal(
    desktopProvider.environmentPolicy,
    null,
    'a removed computer stops being the environment',
  );
  assert.ok(desktopProvider.registry.get(owner, 'old-bot'));
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...manifest,
      environmentComputer: {
        ...environmentComputer,
        computerId: 'scx-desktop-03',
        environmentId: 'scx-desktop-03',
      },
    }),
  );
  desktopProvider.reload();
  assert.equal(
    desktopProvider.registry.get(owner, 'old-bot'),
    undefined,
    'a record the file no longer has must not stay',
  );
  assert.equal(
    desktopProvider.environmentPolicy.computerId,
    'scx-desktop-03',
    'a new computer replaces the old policy without a restart',
  );
});
test('the access key is never empty, and a second starter keeps the first key', async t => {
  const { installationKey } = await import('../src/store.mjs'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-key-')),
    file = path.join(dir, 'access-key');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, '  \n');
  assert.throws(() => installationKey(dir), /access key file is empty/);
  fs.writeFileSync(file, 'first');
  const check = t.mock.method(fs, 'existsSync', () => false);
  assert.equal(installationKey(dir), 'first');
  check.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
  assert.deepEqual(fs.readdirSync(dir), ['access-key']);
});
test('an enabled manifest works on a fresh data folder, and the app then uses the same key', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-desktop-fresh-')),
    dataDir = path.join(root, 'not-yet', 'data'),
    file = path.join(root, 'provider.json');
  let app;
  t.after(async () => {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(
    file,
    JSON.stringify({
      enabled: true,
      provider: 'qemu-kvm-ubuntu-desktop',
      brokerSocket: '/run/stellarcortex-desktop-broker/broker.sock',
      records: [],
    }),
  );
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) =>
    target === file
      ? { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100600 }
      : lstat(target, ...rest),
  );
  const loaded = loadDesktopProvider({ file, dataDir, isolation, brokerFactory: () => ({}) });
  assert.ok(loaded.desktopProvider);
  await loaded.desktopProvider.close();
  const key = fs.readFileSync(path.join(dataDir, 'access-key'), 'utf8');
  assert.match(key, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(dataDir, 'access-key')).mode & 0o777, 0o600);
  const runtime = () =>
    Object.assign(new EventEmitter(), {
      ready: true,
      async start() {},
      async stop() {},
      respond() {},
      reject() {},
      async request() {
        return {};
      },
    });
  app = await createApp({
    dataDir,
    port: 0,
    runtime: runtime(),
    claudeRuntime: runtime(),
    startEngine: false,
  });
  assert.equal(app.accessKey, key);
});
test('production manifest is opt-in, account bound and refuses invalid activation without fallback', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-desktop-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider.json'),
    key = 'synthetic-test-key',
    accountId = createHash('sha256')
      .update('android-owner-v1:' + key)
      .digest('hex');
  fs.writeFileSync(path.join(dir, 'access-key'), key, { mode: 0o600 });
  const options = {
    file,
    dataDir: dir,
    isolation,
    trustedUid: process.getuid(),
    brokerFactory: () => ({}),
  };
  assert.equal(loadDesktopProvider(options), null);
  const cfg = {
    enabled: true,
    provider: 'qemu-kvm-ubuntu-desktop',
    brokerSocket: '/run/stellarcortex-desktop-broker/broker.sock',
    records: [{ ...scope, accountId }],
  };
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  const loaded = loadDesktopProvider(options);
  assert.equal(loaded.desktopProvider.enabled, true);
  assert.equal(loaded.guestExecution.boundary, 'qemu-kvm-ubuntu-desktop');
  assert.equal(loaded.guestExecution.admissionPaused, false);
  fs.writeFileSync(file, JSON.stringify({ ...cfg, records: [scope] }));
  assert.throws(() => loadDesktopProvider(options), /another application account/);
  fs.writeFileSync(file, JSON.stringify({ ...cfg, brokerSocket: '/tmp/untrusted.sock' }));
  assert.throws(() => loadDesktopProvider(options), /refusing fallback/);
  fs.writeFileSync(file, JSON.stringify(cfg));
  fs.chmodSync(file, 0o666);
  assert.throws(() => loadDesktopProvider(options), /agent-writable/);
});
test('task cancellation reaches native typing through the same scoped broker', async () => {
  let finish, started, dispatched;
  const began = new Promise(r => (started = r)),
    broker = {
      capture: async () => ({ width: 10, height: 10 }),
      guest: async input => {
        dispatched = input;
        started();
        return new Promise(r => (finish = r));
      },
      cancel: async input => {
        assert.equal(input.targetRequestId, dispatched.requestId);
        finish({ submitted: 1, stopped: 'cancelled-or-locked' });
        return { requested: true };
      },
      release: async () => ({ released: true }),
    };
  const p = new DesktopProviderRuntime({ records: [scope], broker, enabled: true }),
    execution = desktopEngineExecution(p, { accountId: 'owner', isolation }),
    frame = await execution.desktop.snapshot('bot'),
    controller = new AbortController();
  const action = execution.desktop.action(
    'bot',
    { action: 'type', text: 'שלום', frameId: frame.frameId },
    false,
    { signal: controller.signal },
  );
  await began;
  controller.abort();
  assert.equal((await action).stopped, 'cancelled-or-locked');
  assert.equal(dispatched.method, 'desktop.type');
  assert.equal(dispatched.args.text, 'שלום');
  await p.close();
});
