import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { kitBehind, pruneUpdates, updateKit } from '../src/managed-updates.mjs';
import { mountSoftwareUpdates } from '../public/software-settings.js';
import { KitUpdate } from '../src/desktop-kit-update.mjs';
import {
  createDesktopBrokerServer,
  createDesktopBrokerClient,
} from '../src/desktop-broker-server.mjs';
import { runKitUpdate } from '../scripts/kit-update.mjs';
import { updateCause, updateStage } from '../public/update-causes.js';
import { fakeSite, releaseKey, releaseManifest, signedSite } from './helpers/signed-release.mjs';
import { compact } from './helpers/source-text.mjs';

const key = releaseKey(),
  now = Date.parse('2026-11-05T00:00:00Z'),
  read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const he = a => a,
  en = (a, b) => b;
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};

function kitArchive(t, version = '0.2.0', pkgVersion = version) {
  const dir = temp(t),
    top = path.join(dir, 'top');
  fs.mkdirSync(top);
  fs.writeFileSync(
    path.join(top, 'package.json'),
    JSON.stringify({ name: 'stellarcortex', version: pkgVersion }),
  );
  fs.writeFileSync(path.join(top, 'update-keys.json'), JSON.stringify({ keys: [key.pinned] }));
  execFileSync('tar', ['-czf', 'a.tgz', 'top'], { cwd: dir });
  return fs.readFileSync(path.join(dir, 'a.tgz'));
}
function kitHost(
  t,
  {
    installed = '0.1.0',
    archive = kitArchive(t),
    signer = key,
    upgrade = () => {},
    mutate = value => value,
  } = {},
) {
  const root = temp(t),
    etc = temp(t),
    ran = [];
  fs.writeFileSync(path.join(etc, 'kit-version'), installed + '\n');
  fs.writeFileSync(path.join(etc, 'update-keys.json'), JSON.stringify({ keys: [key.pinned] }));
  fs.writeFileSync(
    path.join(etc, 'kit-update.json'),
    JSON.stringify({
      appUid: 1000,
      appService: 'stellarcortex.service',
      flag: '--firewall-reviewed',
    }),
  );
  const entry = releaseManifest('0.2.0', archive),
    site = signedSite(signer, entry, { [entry.file]: mutate(archive) });
  const exec = async (bin, args, cwd) => {
    ran.push([path.basename(bin), ...args]);
    if (bin === 'tar') execFileSync('tar', args, { cwd });
    if (bin === 'python3') {
      const bundle = args[args.indexOf('--output') + 1];
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, 'APPROVAL-SHA256'), 'h'.repeat(64) + '\n');
    }
    if (path.basename(bin) === 'upgrade-approved.sh') await upgrade();
  };
  return {
    root,
    etc,
    ran,
    run: () =>
      runKitUpdate({
        version: '0.2.0',
        root,
        etc,
        fetchImpl: fakeSite(site),
        exec,
        clock: () => now,
      }),
    status: () => JSON.parse(fs.readFileSync(path.join(root, 'kit-update/status.json'), 'utf8')),
  };
}
test('the root step verifies with its own keys, upgrades, then records the version and the new keys', async t => {
  const host = kitHost(t),
    result = await host.run();
  assert.equal(result.state, 'done', result.error);
  assert.deepEqual(
    host.ran.map(item => item[0]),
    ['tar', 'chmod', 'python3', 'upgrade-approved.sh'],
  );
  assert.deepEqual(host.ran[3].slice(1), ['h'.repeat(64), '--firewall-reviewed']);
  assert.equal(fs.readFileSync(path.join(host.etc, 'kit-version'), 'utf8').trim(), '0.2.0');
  assert.ok(fs.existsSync(path.join(host.root, 'kit/package.json')));
  assert.equal(host.status().state, 'done');
});
test('the root step refuses a tampered tarball, a wrong key and another version, and runs nothing as root', async t => {
  for (const [options, cause] of [
    [{ mutate: value => Buffer.concat([value, Buffer.from('x')]) }, /signed/],
    [{ signer: releaseKey() }, /does not trust/],
    [{ archive: kitArchive(t, '0.2.0', '0.0.1') }, /signed for/],
  ]) {
    const host = kitHost(t, options),
      result = await host.run();
    assert.equal(result.state, 'failed');
    assert.match(result.error, cause);
    assert.ok(!host.ran.some(item => ['python3', 'upgrade-approved.sh'].includes(item[0])));
    assert.equal(fs.readFileSync(path.join(host.etc, 'kit-version'), 'utf8').trim(), '0.1.0');
  }
});
test('asking the root step for an old or current version does nothing', async t => {
  for (const installed of ['0.2.0', '0.3.0']) {
    const host = kitHost(t, { installed });
    assert.equal((await host.run()).state, 'done');
    assert.deepEqual(host.ran, []);
    assert.equal(fs.readFileSync(path.join(host.etc, 'kit-version'), 'utf8').trim(), installed);
  }
});
test('a failed upgrade reports its cause and keeps the recorded version', async t => {
  const host = kitHost(t, {
      upgrade: () => {
        throw new Error('A computer is being prepared. Run this again when it finishes.');
      },
    }),
    result = await host.run();
  assert.equal(result.state, 'failed');
  assert.match(result.error, /being prepared/);
  assert.equal(fs.readFileSync(path.join(host.etc, 'kit-version'), 'utf8').trim(), '0.1.0');
  assert.equal(fs.existsSync(path.join(host.root, 'kit')), false);
});
test('the broker takes only a valid version, and starts only the fixed service', t => {
  const calls = [],
    child = new EventEmitter(),
    kit = new KitUpdate({
      file: path.join(temp(t), 'none.json'),
      run: (bin, args) => {
        calls.push([bin, ...args]);
        return child;
      },
    });
  assert.deepEqual(kit.start('0.2.0'), { state: 'started', version: '0.2.0' });
  assert.deepEqual(calls, [
    ['/usr/bin/systemctl', 'start', '--no-block', 'stellarcortex-kit-update@0.2.0.service'],
  ]);
  for (const bad of ['0.2.0; reboot', '../x', '', '0.2.0.service', 'a'])
    assert.throws(() => kit.start(bad), /Invalid update version/);
  assert.equal(calls.length, 1);
  assert.deepEqual(kit.status(), { state: 'idle' });
});
test('the broker route accepts a version and nothing else', async t => {
  if (process.platform === 'win32') return t.skip('Unix socket');
  const socketPath = path.join(temp(t), 'b.sock'),
    asked = [],
    server = createDesktopBrokerServer({
      broker: {
        kitUpdate: version => {
          asked.push(version);
          return { state: 'idle' };
        },
      },
    });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => server.close());
  const client = createDesktopBrokerClient(socketPath);
  assert.deepEqual(await client.kitUpdate(), { state: 'idle' });
  await client.kitUpdate('0.2.0');
  assert.deepEqual(asked, [undefined, '0.2.0']);
});
test('the supervisor waits for this attempt, survives a broker restart, and passes on a failure', async () => {
  const broker = states => {
    let i = 0;
    const asked = [];
    return {
      asked,
      kitUpdate: async version => {
        if (version) {
          asked.push(version);
          return { state: 'started' };
        }
        const next = states[Math.min(i++, states.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  const old = { state: 'failed', version: '0.2.0', startedAt: 'old', error: 'earlier failure' },
    run = { state: 'running', version: '0.2.0', startedAt: 'new' },
    sleep = async () => {};
  const good = broker([
    old,
    old,
    new Error('broker restarting'),
    run,
    { state: 'done', version: '0.2.0', startedAt: 'new' },
  ]);
  assert.equal((await updateKit({ version: '0.2.0', broker: good, sleep })).state, 'done');
  assert.deepEqual(good.asked, ['0.2.0']);
  await assert.rejects(
    updateKit({
      version: '0.2.0',
      broker: broker([
        old,
        { state: 'failed', version: '0.2.0', startedAt: 'new', error: 'bad hash' },
      ]),
      sleep,
    }),
    /bad hash/,
  );
  let time = 0;
  await assert.rejects(
    updateKit({
      version: '0.2.0',
      broker: broker([old, run]),
      sleep: async () => {
        time += 2000;
      },
      clock: () => time,
      timeoutMs: 10000,
    }),
    /timed out/,
  );
});
test('the root step runs only on a host that has one and is behind', t => {
  const file = path.join(temp(t), 'kit-version');
  assert.equal(kitBehind('0.3.0', file), false, 'no computer on this host');
  fs.writeFileSync(file, '0.2.0\n');
  assert.equal(kitBehind('0.3.0', file), true);
  assert.equal(kitBehind('0.2.0', file), false);
});
test('the install and the upgrade carry what the root step needs, and a failed upgrade restores', () => {
  const install = read('deployment/ubuntu-desktop/host-install.sh'),
    setup = read('deployment/ubuntu-desktop/host-setup.py');
  assert.match(install, /package-lock\.json update-keys\.json \| tar/);
  for (const name of [
    '/etc/stellarcortex/update-keys.json',
    '/etc/stellarcortex/kit-version',
    '/etc/stellarcortex/kit-update.json',
  ])
    assert.ok(install.includes(name));
  assert.match(setup, /stellarcortex-kit-update@\.service/);
  assert.ok(
    setup.indexOf("trap 'restore; exit 1' ERR") <
      setup.indexOf('systemctl stop stellarcortex-desktop-broker.service\nrm -rf "$live"; mv'),
  );
  assert.match(setup, /runners\.tar\.gz" -C RUNNERS/);
  const unit = read('deployment/ubuntu-desktop/kit-update@.service');
  assert.match(unit, /scripts\/kit-update\.mjs %i/);
  assert.match(unit, /User=root/);
  assert.doesNotMatch(
    read('scripts/kit-update.mjs'),
    /process\.env/,
    'the root step reads nothing from the environment',
  );
});
test('Settings has one button, and the cause reads in both languages', () => {
  const panel = compact(read('public/software-settings.js'));
  assert.match(panel, /ready\?`<button class="primary" data-update-apply/);
  assert.match(panel, /tr\('עדכן עכשיו','Update now'\)/);
  assert.match(panel, /tr\('בדוק עדכונים','Check for updates'\)/);
  assert.match(panel, /updateStage\(info\?\.progress,tr\)/);
  assert.match(panel, /finally\(\(\)=>runCheck\(\)\)/);
  assert.match(
    updateCause('The release file does not match its signed hash, so it was refused.', en),
    /security check/,
  );
  assert.match(
    updateCause('The release file does not match its signed hash, so it was refused.', he),
    /בדיקת האבטחה/,
  );
  assert.match(updateCause('New release failed before readiness', en), /health check/);
  assert.match(
    updateCause('The update check failed (HTTP 503). Try again later.', en),
    /update server/,
  );
  assert.match(
    updateCause('Too many update checks for now (rate limit). Try again in 7 minutes.', he),
    /בעוד 7 דקות/,
  );
  assert.match(updateCause('No release is published yet.', he), /לא פורסמה/);
  assert.match(updateCause('Something new', en), /The update failed: Something new/);
  assert.equal(updateStage('system', en), 'Updating the virtual computer…');
  assert.equal(updateStage('downloading', he), 'מוריד את הגרסה…');
  for (const file of ['README.md', 'README.he.md']) {
    const text = read(file);
    assert.doesNotMatch(text, /npm ci --no-audit/, 'manual steps live in docs/RECOVERY.md');
    assert.match(text, /docs\/RECOVERY\.md/);
  }
  assert.match(read('docs/RECOVERY.md'), /npm ci --no-audit/);
});
test('the launcher and the service both start the supervisor', () => {
  assert.match(
    compact(read('scripts/launch.mjs')),
    /path\.join\(root,'scripts','managed-launch\.mjs'\)/,
  );
  assert.match(compact(read('scripts/linux-service.mjs')), /'scripts','managed-launch\.mjs'/);
});
test('the root step replaces the version file atomically and keeps only recent bundles and backups', async t => {
  const host = kitHost(t),
    versionFile = path.join(host.etc, 'kit-version'),
    link = versionFile + '.link';
  fs.linkSync(versionFile, link);
  const dated = (file, age) => {
    fs.mkdirSync(file, { recursive: true });
    fs.utimesSync(file, new Date(now - age), new Date(now - age));
  };
  for (const age of [3, 4, 5]) dated(path.join(host.root, 'bundle-0.1.0-' + age), age * 1000);
  for (const age of [1, 2, 3, 4, 5])
    dated(path.join(host.root, 'desktops/backups', 'b' + age), age * 1000);
  assert.equal((await host.run()).state, 'done');
  assert.equal(
    fs.readFileSync(link, 'utf8').trim(),
    '0.1.0',
    'an in-place write changes the old file',
  );
  assert.equal(fs.readFileSync(versionFile, 'utf8').trim(), '0.2.0');
  assert.equal(fs.readdirSync(host.root).filter(name => name.startsWith('bundle-')).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(host.root, 'desktops/backups')).sort(), [
    'b1',
    'b2',
    'b3',
  ]);
});
test('after an update only recent releases and backups stay, with the running one and failed ones kept', t => {
  const manager = temp(t),
    dated = (folder, name, age) => {
      const file = path.join(manager, folder, name);
      fs.mkdirSync(file, { recursive: true });
      fs.utimesSync(file, new Date(now - age * 1000), new Date(now - age * 1000));
      return file;
    };
  const running = dated('releases', 'running', 9);
  for (const age of [1, 2, 3, 4]) dated('releases', 'r' + age, age);
  for (const age of [1, 2, 3, 4]) dated('backups', 'b' + age, age);
  dated('backups', 'failed-a', 9);
  dated('backups', 'interrupted-a', 9);
  pruneUpdates(manager, running);
  assert.deepEqual(fs.readdirSync(path.join(manager, 'releases')).sort(), [
    'r1',
    'r2',
    'r3',
    'running',
  ]);
  assert.deepEqual(fs.readdirSync(path.join(manager, 'backups')).sort(), [
    'b1',
    'b2',
    'b3',
    'failed-a',
    'interrupted-a',
  ]);
});
test('a check that found no release shows the reason as a status, and a rate limit as an alert', async t => {
  const shown = [],
    nodes = {},
    container = {
      isConnected: true,
      innerHTML: '',
      append(item) {
        shown.push(item);
      },
      querySelector(selector) {
        return this.innerHTML.includes(selector.slice(1, -1)) ? (nodes[selector] ||= {}) : null;
      },
    };
  globalThis.document = {
    createElement: () => ({
      setAttribute(name, value) {
        this[name] = value;
      },
    }),
  };
  t.after(() => delete globalThis.document);
  let checkError = 'No release is published yet.';
  const status = () => ({ installed: { version: '0.1.0' }, canApply: true, checkError }),
    settle = () => new Promise(resolve => setTimeout(resolve, 5));
  mountSoftwareUpdates(container, {
    api: async () => status(),
    tr: he,
    esc: String,
  });
  await settle();
  let last = shown.at(-1);
  assert.equal(last.textContent, 'עדיין לא פורסמה גרסה.');
  assert.equal(last.role, 'status');
  assert.equal(last.className, 'notice');
  assert.ok(container.innerHTML.includes('data-update-check'));
  checkError = 'Too many update checks for now (rate limit). Try again in 12 minutes.';
  nodes['[data-update-check]'].onclick();
  await settle();
  last = shown.at(-1);
  assert.match(last.textContent, /12/);
  assert.equal(last.role, 'alert');
  assert.equal(last.className, 'notice error');
});
test('every result of a check shows in the pane, and a check in progress says so', async t => {
  globalThis.document = {
    createElement: () => ({
      setAttribute(name, value) {
        this[name] = value;
      },
    }),
  };
  t.after(() => delete globalThis.document);
  const installed = { version: '0.1.0' },
    newer = { offered: { version: '0.2.0' }, comparison: 'newer-version' };
  for (const [result, shown] of [
    [{ checkError: 'No release is published yet.' }, 'No release is published yet.'],
    [{ checkError: 'Could not reach the update server.' }, 'Could not reach the update server.'],
    [{ offered: { version: '0.1.0' }, comparison: 'same-version' }, 'up to date'],
    [newer, 'A newer signed version is available.'],
  ]) {
    const nodes = {},
      extra = [],
      container = {
        isConnected: true,
        html: '',
        get innerHTML() {
          return this.html;
        },
        // A render replaces the pane, so what was appended before it is gone.
        set innerHTML(value) {
          this.html = value;
          extra.length = 0;
        },
        append: item => extra.push(item.textContent),
        querySelector(selector) {
          return this.innerHTML.includes(selector.slice(1, -1)) ? (nodes[selector] ||= {}) : null;
        },
      };
    let answer;
    const api = route =>
        route === '/api/software-update'
          ? Promise.resolve({ installed, canApply: true })
          : new Promise(resolve => {
              answer = () => resolve({ installed, canApply: true, ...result });
            }),
      settle = () => new Promise(resolve => setTimeout(resolve, 5)),
      text = () => container.innerHTML + extra.join(' ');
    mountSoftwareUpdates(container, { api, tr: en, esc: String });
    await settle();
    assert.ok(container.innerHTML.includes('Checking…'), shown);
    answer();
    await settle();
    assert.ok(text().includes(shown), shown);
    assert.ok(!container.innerHTML.includes('Checking…'), shown);
    if (!nodes['[data-update-check]']) continue;
    assert.match(text(), /Last checked: /);
    // The result stays through the next check, so the pane never goes quiet.
    nodes['[data-update-check]'].onclick();
    assert.ok(container.innerHTML.includes('Checking…'), shown);
    assert.ok(container.innerHTML.includes('data-update-check'), shown);
    assert.ok(text().includes(shown), shown);
    answer();
    await settle();
    assert.ok(text().includes(shown), shown);
  }
});
test('a failed check shows Check for updates, not an old Update now, and a good one brings it back', async t => {
  const nodes = {},
    container = {
      isConnected: true,
      innerHTML: '',
      append() {},
      querySelector(selector) {
        return this.innerHTML.includes(selector.slice(1, -1)) ? (nodes[selector] ||= {}) : null;
      },
    };
  globalThis.document = { createElement: () => ({ setAttribute() {} }) };
  t.after(() => delete globalThis.document);
  const status = {
    installed: { version: '0.1.0' },
    canApply: true,
    offered: { version: '0.2.0' },
    comparison: 'newer-version',
    lastUpdate: null,
  };
  let online = false;
  const api = async route => {
    if (route === '/api/software-update') return status;
    if (!online) throw new Error('Could not reach the update server.');
    return status;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  mountSoftwareUpdates(container, { api, tr: en, esc: String });
  await settle();
  assert.ok(container.innerHTML.includes('data-update-check'));
  assert.ok(container.innerHTML.includes('Check for updates'));
  assert.ok(!container.innerHTML.includes('data-update-apply'));
  assert.ok(!container.innerHTML.includes('Latest version'));
  online = true;
  nodes['[data-update-check]'].onclick();
  await settle();
  assert.ok(container.innerHTML.includes('data-update-apply'));
  assert.ok(container.innerHTML.includes('Update now'));
  assert.ok(!container.innerHTML.includes('data-update-check'));
});
test('a cleanup error after a good update is logged, and the update still counts as done', async t => {
  const rm = fs.rmSync,
    logged = [];
  t.mock.method(console, 'error', text => logged.push(text));
  t.mock.method(fs, 'rmSync', (file, options) => {
    if (/bundle-0\.1\.0|old-release|old-backup/.test(String(file))) throw new Error('denied');
    return rm(file, options);
  });
  const host = kitHost(t);
  for (const age of [3, 4, 5]) fs.mkdirSync(path.join(host.root, 'bundle-0.1.0-' + age));
  const result = await host.run();
  assert.equal(result.state, 'done', result.error);
  assert.equal(host.status().state, 'done');
  assert.equal(fs.readFileSync(path.join(host.etc, 'kit-version'), 'utf8').trim(), '0.2.0');
  assert.ok(fs.existsSync(path.join(host.root, 'kit/package.json')));
  const manager = temp(t);
  for (const name of ['1', '2', '3', 'old-release'])
    fs.mkdirSync(path.join(manager, 'releases', name), { recursive: true });
  for (const name of ['1', '2', '3', 'old-backup'])
    fs.mkdirSync(path.join(manager, 'backups', name), { recursive: true });
  const dated = new Date(now - 60000);
  fs.utimesSync(path.join(manager, 'releases/old-release'), dated, dated);
  fs.utimesSync(path.join(manager, 'backups/old-backup'), dated, dated);
  assert.doesNotThrow(() => pruneUpdates(manager, path.join(manager, 'releases/1')));
  assert.ok(logged.some(text => /Could not remove .*old-release: denied/.test(text)));
  assert.ok(logged.some(text => /Could not remove .*old-backup: denied/.test(text)));
});
