import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoftwareUpdates, installedSoftware } from '../src/software-updates.mjs';
import net from 'node:net';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { updateTransaction, inside, fetchHealth, healthUrl } from '../src/managed-updates.mjs';
import { fakeSite, releaseKey, signedSite } from './helpers/signed-release.mjs';
import { compact } from './helpers/source-text.mjs';

const old = 'a'.repeat(40),
  next = 'b'.repeat(40);
test('the health probe reaches the address a managed server bound, which loopback does not', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-bind-')),
    server = new URL('../src/server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const child = fork(server, [], {
    env: {
      ...process.env,
      STELLARCORTEX_DESKTOP_CONFIG_DIR: dir,
      STELLARCORTEX_DATA_DIR: dir,
      STELLARCORTEX_MANAGED_UPDATES: '1',
      STELLARCORTEX_UPDATE_BOOT: '1',
      STELLARCORTEX_BIND: '127.0.0.2',
      PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise(resolve => child.once('exit', resolve)),
        timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.connected ? child.send({ type: 'shutdown' }) : child.kill('SIGKILL');
      await gone;
      clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'managed-ready') resolve(message);
    });
    child.once('exit', code => reject(new Error(`Server exited ${code}`)));
  });
  assert.equal(ready.host, '127.0.0.2');
  assert.equal((await fetchHealth(ready)).ok, true);
  await assert.rejects(
    fetch(`http://127.0.0.1:${ready.port}/health`, { signal: AbortSignal.timeout(5000) }),
  );
  assert.equal((await fetch(healthUrl(ready), { signal: AbortSignal.timeout(5000) })).status, 403);
  const launcher = compact(
    fs.readFileSync(new URL('../scripts/managed-launch.mjs', import.meta.url), 'utf8'),
  );
  assert.match(launcher, /health=await fetchHealth\(ready\)/);
  assert.doesNotMatch(launcher, /127\.0\.0\.1/);
});
test('the launcher finds a server bound to another address and does not start a second one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-launch-')),
    pidFile = path.join(dir, 'launcher.pid'),
    root = path.dirname(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    );
  const port = await new Promise(resolve => {
    const free = net.createServer().listen(0, '127.0.0.2', () => {
      const { port } = free.address();
      free.close(() => resolve(port));
    });
  });
  // No PATH and an empty home, so the server starts without finding a real provider CLI or login.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'),
    ),
    STELLARCORTEX_DESKTOP_CONFIG_DIR: dir,
    STELLARCORTEX_DATA_DIR: dir,
    STELLARCORTEX_BIND: '127.0.0.2',
    STELLARCORTEX_PUBLIC_URL: '',
    PORT: String(port),
    HOME: dir,
    USERPROFILE: dir,
  };
  t.after(async () => {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try {
        process.kill(pid);
        for (let tries = 0; tries < 50; tries++) {
          process.kill(pid, 0);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const launch = () =>
    promisify(execFile)(process.execPath, [path.join(root, 'scripts', 'launch.mjs'), '--no-open'], {
      cwd: root,
      env,
      timeout: 30000,
    });
  const { stdout } = await launch(),
    pid = fs.readFileSync(pidFile, 'utf8');
  assert.equal((await fetchHealth({ host: '127.0.0.2', port })).ok, true);
  assert.doesNotMatch(stdout, /127\.0\.0\.1/);
  assert.match(stdout, /STELLARCORTEX_PUBLIC_URL/);
  await launch();
  assert.equal(fs.readFileSync(pidFile, 'utf8'), pid);
});
test('the browser address is the one the app serves, and a specific bind has none without a public URL', async () => {
  const { appOrigin } = await import('../src/managed-updates.mjs'),
    origin = (bind, publicUrl = '') => appOrigin({ bind, publicUrl, port: 4317 });
  for (const bind of [undefined, '127.0.0.1', '0.0.0.0', '::'])
    assert.equal(origin(bind), 'http://127.0.0.1:4317');
  assert.equal(origin('::1'), 'http://[::1]:4317');
  assert.equal(origin('localhost'), 'http://localhost:4317');
  assert.equal(origin('192.0.2.7'), null);
  assert.equal(origin('127.0.0.2'), null);
  assert.equal(origin('192.0.2.7', 'https://bots.example.com/app'), 'https://bots.example.com');
});
test('the access key is opened only at an address the app serves', async t => {
  const { openApp } = await import('../scripts/open.mjs'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-open-')),
    opened = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'access-key'), 'a key\n');
  openApp(dir, null, url => opened.push(url));
  assert.deepEqual(opened, []);
  openApp(dir, 'https://bots.example.com', url => opened.push(url));
  assert.deepEqual(opened, ['https://bots.example.com/#key=a%20key']);
});
test('a wildcard bind is probed through loopback and an IPv6 address is bracketed', () => {
  assert.equal(healthUrl({ host: '192.0.2.7', port: 4317 }), 'http://192.0.2.7:4317/health');
  assert.equal(healthUrl({ host: '0.0.0.0', port: 4317 }), 'http://127.0.0.1:4317/health');
  assert.equal(healthUrl({ host: '::', port: 4317 }), 'http://[::1]:4317/health');
  assert.equal(healthUrl({ host: 'fd00::7', port: 4317 }), 'http://[fd00::7]:4317/health');
});
const key = releaseKey(),
  keys = [key.pinned];
function fixture({
  installed = { version: '0.1.0', commit: old, modified: false },
  manager = null,
  clock = () => 1000,
  fetchImpl = null,
} = {}) {
  const requests = [],
    service = new SoftwareUpdates({
      installed,
      manager,
      clock,
      keys,
      fetchImpl: fetchImpl || fakeSite(signedSite(key), requests),
    });
  return { service, requests };
}
test('the check reports a newer signed version, and repeated checks share one request', async () => {
  const { service, requests } = fixture();
  const [first, second] = await Promise.all([service.check(), service.check()]);
  assert.equal(first.comparison, 'newer-version');
  assert.equal(first.offered.version, '0.2.0');
  assert.equal(first.offered.notes.he, 'הערות');
  assert.equal(second.checkedAt, first.checkedAt);
  assert.deepEqual(requests.map(item => item.url.split('/').pop()).sort(), [
    'latest',
    'release.json',
    'release.json.sig',
  ]);
  assert.ok(requests.every(item => !item.options.headers.Authorization));
  await service.check();
  assert.equal(requests.length, 3);
});
test('the comparison follows versions, and local changes are named', async () => {
  assert.equal(
    (
      await fixture({
        installed: { version: '0.2.0', commit: null, modified: null },
      }).service.check()
    ).comparison,
    'same-version',
  );
  assert.equal(
    (
      await fixture({
        installed: { version: '0.3.0', commit: null, modified: null },
      }).service.check()
    ).comparison,
    'installed-ahead',
  );
  assert.equal(
    (
      await fixture({
        installed: { version: '0.1.0', commit: next, modified: true },
      }).service.check()
    ).comparison,
    'locally-modified',
  );
});
test('an unsigned, tampered or unreachable release never claims a version', async () => {
  const bad = fixture({ fetchImpl: async () => new Response('no', { status: 503 }) });
  await assert.rejects(bad.service.check(), /503/);
  assert.equal(bad.service.status().offered, undefined);
  const forged = fixture({ fetchImpl: fakeSite(signedSite(releaseKey())) });
  await assert.rejects(forged.service.check(), /does not trust/);
  assert.equal(forged.service.status().offered, undefined);
  const tampered = fixture({
    fetchImpl: fakeSite({ ...signedSite(key), 'release.json': Buffer.from('{}') }),
  });
  await assert.rejects(tampered.service.check(), /signature is not valid/);
  const size = fixture({
    fetchImpl: fakeSite({ ...signedSite(key), 'release.json': 'x'.repeat(1024 * 1024 + 1) }),
  });
  await assert.rejects(size.service.check(), /size limit/);
  await assert.rejects(
    new SoftwareUpdates({
      installed: { version: '0.1.0' },
      keys: [],
      fetchImpl: fakeSite(signedSite(key)),
    }).check(),
    /no pinned release key/,
  );
});
test('a same or older version cannot be applied', async () => {
  const manager = { prepare: () => assert.fail('must not stage'), commit() {} };
  for (const version of ['0.2.0', '0.3.0']) {
    const { service } = fixture({ manager, installed: { version, commit: null, modified: null } });
    await service.check();
    await assert.rejects(
      service.requestApply({ version: '0.2.0', confirm: true }),
      /Only a newer signed release/,
    );
  }
  const local = fixture({ manager, installed: { version: '0.1.0', commit: old, modified: true } });
  await local.service.check();
  await assert.rejects(
    local.service.requestApply({ version: '0.2.0', confirm: true }),
    /local changes/,
  );
  const { service } = fixture({ manager });
  await service.check();
  await assert.rejects(service.requestApply({ version: '0.9.0', confirm: true }), /again/);
  await assert.rejects(
    service.requestApply({ commit: next, confirm: true }),
    /Only a checked version/,
  );
});
test('managed update requires fresh confirmation, freezes duplicate apply and never retries failed preparation', async () => {
  let time = 1000,
    resolvePrepare,
    calls = 0,
    commits = 0;
  const manager = {
    prepare: () => {
      calls++;
      return new Promise(resolve => {
        resolvePrepare = resolve;
      });
    },
    commit: () => commits++,
  };
  const { service } = fixture({ manager, clock: () => time });
  await service.check();
  time += 300001;
  await assert.rejects(service.requestApply({ version: '0.2.0', confirm: true }), /again/);
  await service.check();
  const applying = service.requestApply({ version: '0.2.0', confirm: true });
  assert.equal(
    (await service.requestApply({ version: '0.2.0', confirm: true })).code,
    'update-active',
  );
  resolvePrepare();
  assert.equal((await applying).ok, true);
  assert.equal(calls, 1);
  service.commitPrepared();
  assert.equal(commits, 1);
  const failed = fixture({
    manager: {
      prepare: async () => {
        throw new Error('disk full');
      },
    },
  });
  await failed.service.check();
  await assert.rejects(
    failed.service.requestApply({ version: '0.2.0', confirm: true }),
    /disk full/,
  );
  assert.equal(failed.service.applying, false);
});
function diskFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-update-test-')),
    managerDir = path.join(base, 'manager'),
    dataDir = path.join(base, 'data');
  fs.mkdirSync(managerDir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ memory: ['keep'], settings: { language: 'he' } }),
  );
  fs.writeFileSync(path.join(dataDir, 'provider-credentials.enc'), 'fixture-encrypted-bytes');
  t.after(() => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert(path.basename(base).startsWith('stellar-update-test-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    managerDir,
    dataDir,
    previous: { root: 'previous', commit: old },
    candidate: { root: 'candidate', commit: next },
  };
}
test('transaction stages separate release, retains data and activates only after successful health check', async t => {
  const f = diskFixture(t),
    events = [];
  const result = await updateTransaction({
    ...f,
    stop: async () => events.push('stop'),
    probe: async r => events.push('probe:' + r.commit),
    activate: async () => events.push('activate'),
  });
  assert.equal(result.status, 'updated');
  assert.deepEqual(events, ['stop', 'probe:' + next, 'activate']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'state.json'))).memory, [
    'keep',
  ]);
  assert.equal(
    fs.readFileSync(path.join(f.dataDir, 'provider-credentials.enc'), 'utf8'),
    'fixture-encrypted-bytes',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.managerDir, 'current.json'))).commit, next);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.managerDir, 'transaction.json'))).phase,
    'committed',
  );
});
test('failed health check restores full data and previous release before enabling tasks', async t => {
  const f = diskFixture(t),
    events = [];
  const result = await updateTransaction({
    ...f,
    stop: async () => events.push('stop'),
    probe: async r => {
      events.push('probe:' + r.commit);
      if (r.commit === next) {
        fs.writeFileSync(path.join(f.dataDir, 'state.json'), 'bad migration');
        fs.writeFileSync(path.join(f.dataDir, 'provider-credentials.enc'), 'modified');
        throw new Error('health failed');
      }
    },
    activate: async () => events.push('activate'),
  });
  assert.equal(result.status, 'rolled-back');
  assert.equal(result.error, 'health failed');
  assert.deepEqual(events, ['stop', 'probe:' + next, 'stop', 'probe:' + old, 'activate']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'state.json'))).memory, [
    'keep',
  ]);
  assert.equal(
    fs.readFileSync(path.join(f.dataDir, 'provider-credentials.enc'), 'utf8'),
    'fixture-encrypted-bytes',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.managerDir, 'current.json'))).commit, old);
});
test('backup failure keeps original data; activation failure never rolls back potentially running work', async t => {
  const f = diskFixture(t),
    probed = [];
  assert.equal(
    (
      await updateTransaction({
        ...f,
        stop: async () => {},
        backup: () => {
          throw new Error('backup full');
        },
        probe: async r => probed.push(r.commit),
        activate: async () => {},
      })
    ).status,
    'rolled-back',
  );
  assert.deepEqual(probed, [old]);
  assert.equal(
    fs.readFileSync(path.join(f.dataDir, 'provider-credentials.enc'), 'utf8'),
    'fixture-encrypted-bytes',
  );
  await assert.rejects(
    updateTransaction({
      ...f,
      stop: async () => {},
      probe: async () => {},
      activate: async () => {
        throw new Error('activation failed');
      },
    }),
    /activation failed/,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.managerDir, 'current.json'))).commit, next);
  assert.equal(inside(f.managerDir, f.dataDir), false);
});
test('archive package reports installed version but unknown commit', t => {
  const f = diskFixture(t);
  fs.writeFileSync(path.join(f.dataDir, 'package.json'), '{"version":"0.1.0"}');
  assert.deepEqual(installedSoftware(f.dataDir), {
    version: '0.1.0',
    commit: null,
    modified: null,
  });
});
test('a failed check after a good one is reported, and the old offer can no longer be applied', async () => {
  let time = 1000,
    online = true;
  const site = fakeSite(signedSite(key)),
    manager = { prepare: () => assert.fail('must not stage'), commit() {} },
    service = new SoftwareUpdates({
      installed: { version: '0.1.0', commit: old, modified: false },
      manager,
      keys,
      clock: () => time,
      fetchImpl: (...args) =>
        online ? site(...args) : Promise.reject(new TypeError('fetch failed')),
    });
  assert.equal((await service.check()).checkError, null);
  online = false;
  time += 60000;
  await assert.rejects(service.check(), /Could not reach/);
  assert.match(service.status().checkError, /Could not reach/);
  await assert.rejects(
    service.requestApply({ version: '0.2.0', confirm: true }),
    /Check for updates again/,
  );
  online = true;
  time += 60000;
  assert.equal((await service.check()).checkError, null);
});
