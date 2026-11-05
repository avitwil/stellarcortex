import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { ComputerBuild } from '../src/desktop-computer-build.mjs';
import {
  DesktopProviderRuntime,
  SESSION_RETRY_MS,
  computerStatusText,
} from '../src/desktop-provider-runtime.mjs';
import { desktopEngineExecution } from '../src/desktop-engine-adapter.mjs';
import { createDesktopBrokerServer } from '../src/desktop-broker-server.mjs';
import { SessionOnboarding } from '../src/desktop-session-onboarding.mjs';
import { resolveComputer } from '../src/computer-mode.mjs';
import { computerBlocker, hostBasics, rootResult } from '../scripts/install-computer.mjs';
import { createApp } from '../src/server.mjs';
import {
  computerBuildText,
  computerFailureText,
  computerInstallText,
  computerSetupText,
} from '../public/computer-status.js';
import { compact } from './helpers/source-text.mjs';
const he = hebrew => hebrew,
  en = (_h, english) => english;
function build(t, state, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'build.json'),
    calls = [];
  if (state) fs.writeFileSync(file, JSON.stringify(state));
  return {
    file,
    calls,
    build: new ComputerBuild({
      file,
      bootId: () => 'boot',
      alive: () => true,
      run: (bin, args) => {
        calls.push([bin, ...args]);
        const child = new EventEmitter();
        return child;
      },
      ...options,
    }),
  };
}
test('the build reports its stage and progress, and a dead one is a failure with a Retry', t => {
  assert.deepEqual(
    build(t, { stage: 'download', percent: 40, bootId: 'boot', pid: 1 }).build.status(),
    { state: 'building', stage: 'download', step: 1, steps: 4, percent: 40 },
  );
  assert.deepEqual(build(t, { stage: 'install', bootId: 'boot', pid: 1 }).build.status(), {
    state: 'building',
    stage: 'install',
    step: 3,
    steps: 4,
    percent: null,
  });
  assert.deepEqual(build(t, { stage: 'ready' }).build.status(), { state: 'ready' });
  assert.deepEqual(build(t, null).build.status(), { state: 'not-started' });
  assert.deepEqual(build(t, { stage: 'failed', code: 'disk', message: 'raw' }).build.status(), {
    state: 'failed',
    code: 'disk',
    message: 'raw',
  });
  assert.equal(
    build(t, { stage: 'install', bootId: 'old', pid: 1 }).build.status().code,
    'interrupted',
    'the host rebooted during the build',
  );
  assert.equal(
    build(t, { stage: 'install', bootId: 'boot', pid: 1 }, { alive: () => false }).build.status()
      .code,
    'interrupted',
  );
});
test('Retry starts only the fixed unit, once, and never while a build runs', t => {
  const failed = build(t, { stage: 'failed', code: 'other' });
  assert.equal(failed.build.retry().state, 'building');
  failed.build.retry();
  assert.equal(failed.calls.length, 1);
  assert.deepEqual(failed.calls[0], [
    '/usr/bin/systemctl',
    'start',
    '--no-block',
    'stellarcortex-computer-build@retry.service',
  ]);
  const running = build(t, { stage: 'install', bootId: 'boot', pid: 1 });
  running.build.retry();
  assert.equal(running.calls.length, 0);
  const ready = build(t, { stage: 'ready' });
  ready.build.retry();
  assert.equal(ready.calls.length, 0);
});
const scope = { accountId: 'owner', botId: 'bot', vmId: '02', generation: 'one' };
function provider({ environment = false, records = [], bots = [{ id: 'bot' }], broker = {} } = {}) {
  const calls = [],
    runtime = new DesktopProviderRuntime({
      enabled: true,
      records,
      broker: {
        computerBuild: async () => ({
          state: 'building',
          stage: 'install',
          step: 3,
          steps: 4,
          percent: null,
        }),
        sessionSetup: async (...args) => {
          calls.push(['setup', ...args]);
          return { state: 'allocation-available' };
        },
        sessionRemove: async (...args) => {
          calls.push(['remove', ...args]);
          return { state: 'removing' };
        },
        ...broker,
      },
      environmentPolicy: environment
        ? { accountId: 'owner', environmentId: 'env', computerId: 'env', defaultAccess: true }
        : null,
    });
  runtime.accountId = 'owner';
  runtime.store = { data: { bots } };
  return { runtime, calls };
}
test('a bot set to the computer never starts a build: it only hears how the build is going', async () => {
  const { runtime, calls } = provider(),
    status = await runtime.onboarding('owner', 'bot', true);
  assert.equal(status.state, 'building');
  assert.equal(calls.length, 0);
  assert.equal(runtime.broker.onboarding, undefined);
  assert.match(computerStatusText(status), /installing Ubuntu, step 3 of 4/);
  const execution = desktopEngineExecution(runtime, {
    accountId: 'owner',
    isolation: { enabled: true, providerIsolation: { codex: true } },
  });
  await assert.rejects(execution.health('bot'), error => {
    assert.doesNotMatch(error.message, /being prepared/);
    assert.match(error.message, /being built/);
    return true;
  });
});
test('an unreachable broker is a status, not an error in the chat or the Settings page', async () => {
  const { runtime } = provider({
    broker: {
      computerBuild: async () => {
        throw Error('connect ENOENT');
      },
    },
  });
  assert.equal((await runtime.onboarding('owner', 'bot', true)).state, 'unreachable');
});
test('a new bot gets a session on a ready computer, with no choice in Settings', async () => {
  const { runtime, calls } = provider({
    environment: true,
    bots: [{ id: 'bot' }, { id: 'off', computer: 'none' }, { id: 'mine', computer: 'host' }],
  });
  await runtime.syncSessions(bot => resolveComputer(bot, { defaultVm: true }) === 'vm');
  assert.deepEqual(calls, [['setup', 'owner', 'env', 'bot', true]]);
});
test('a bot made during the build gets its session by itself once the computer is ready', async () => {
  const f = provider();
  await f.runtime.syncSessions(() => true);
  assert.equal(f.calls.length, 0, 'nothing to ask yet, and no install');
  f.runtime.environmentPolicy = {
    accountId: 'owner',
    environmentId: 'env',
    computerId: 'env',
    defaultAccess: true,
  };
  await f.runtime.syncSessions(() => true);
  assert.equal(f.calls[0][0], 'setup');
});
test('deleting a bot removes its session, and a deleted bot never gets one', async () => {
  const { runtime, calls } = provider({
    environment: true,
    bots: [
      { id: 'bot', deletedAt: 'now' },
      { id: 'gone', deletedAt: 'now' },
    ],
  });
  runtime.records.set('owner\0bot', { ...scope, sessionId: 'desktop-1' });
  await runtime.syncSessions(() => true);
  assert.deepEqual(calls, [
    ['remove', 'owner', 'env', 'bot'],
    ['remove', 'owner', 'env', 'gone'],
  ]);
});
test('a stuck broker holds up only the session sync, one pass at a time', async () => {
  let release;
  const { runtime, calls } = provider({
      environment: true,
      broker: {
        sessionSetup: (...args) => {
          calls.push(args);
          return new Promise(resolve => {
            release = resolve;
          });
        },
      },
    }),
    first = runtime.syncSessions(() => true);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.syncSessions(() => true);
  assert.equal(calls.length, 1);
  release({});
  await first;
});
test('the default follows the host: a computer if there is one, none if not, and the owner’s choice stays', () => {
  assert.equal(resolveComputer({}, { defaultVm: true }), 'vm');
  assert.equal(resolveComputer({}, { defaultVm: false }), 'none');
  assert.equal(resolveComputer({ computer: 'none' }, { defaultVm: true }), 'none');
  assert.equal(resolveComputer({ computer: 'host' }, { defaultVm: true }), 'host');
});
test('a session that cannot start yet is asked for now and then, not every 15 seconds', async () => {
  const { runtime, calls } = provider({
    environment: true,
    bots: [{ id: 'bot' }, { id: 'gone', deletedAt: 'now' }],
  });
  runtime.records.set('owner\0gone', { ...scope, botId: 'gone', sessionId: 'desktop-1' });
  await runtime.syncSessions(() => true, 1000);
  assert.equal(calls.length, 2);
  await runtime.syncSessions(() => true, 1000 + 15000);
  assert.equal(calls.length, 2, 'the computer is off, so no root unit starts again yet');
  await runtime.syncSessions(() => true, 1000 + SESSION_RETRY_MS);
  assert.equal(calls.length, 4);
});
test('a deleted bot with only a half-made desktop is cleaned up too, and then left alone', async () => {
  let state = 'removing';
  const { runtime, calls } = provider({
    environment: true,
    bots: [{ id: 'bot', deletedAt: 'now' }],
    broker: {
      sessionRemove: async (...args) => {
        calls.push(args);
        return { state };
      },
    },
  });
  await runtime.syncSessions(() => true, 1000);
  assert.equal(calls.length, 1, 'it has no session, but may have a half-made one');
  state = 'removed';
  await runtime.syncSessions(() => true, 1000 + SESSION_RETRY_MS);
  assert.equal(calls.length, 2);
  await runtime.syncSessions(() => true, 1000 + SESSION_RETRY_MS * 2);
  assert.equal(calls.length, 2, 'nothing is left to remove');
});
test('removing a bot with nothing on the computer starts no root unit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-remove-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [],
    child = new EventEmitter(),
    sessions = new SessionOnboarding({
      directory: dir,
      load: () => ({
        sessionProvisioning: { approved: true, accountId: 'owner', environmentId: 'env' },
        desktops: [],
      }),
      run: (bin, args) => {
        calls.push(args);
        return child;
      },
    });
  assert.equal(sessions.remove('owner', 'env', 'bot').state, 'removed');
  assert.equal(calls.length, 0);
  fs.writeFileSync(path.join(dir, 'bot.json'), JSON.stringify({ state: 'needs-attention' }));
  assert.equal(
    sessions.remove('owner', 'env', 'bot').state,
    'removing',
    'a half-made session has only its result file',
  );
  assert.equal(calls.length, 1);
});
test('a host with no computer still gets what the app needs from root, or is told how', () => {
  const asked = [],
    done = hostBasics({
      root: '/app',
      user: 'me',
      node: '/bin/node',
      run: (bin, args) => {
        asked.push([bin, ...args]);
        return { status: 0 };
      },
    });
  assert.deepEqual(done, []);
  assert.deepEqual(asked, [
    ['sudo', 'loginctl', 'enable-linger', 'me'],
    [
      'sudo',
      '/bin/node',
      path.join('/app', 'node_modules/playwright/cli.js'),
      'install-deps',
      'chromium',
    ],
  ]);
  assert.deepEqual(
    hostBasics({ root: '/app', user: 'me', node: '/bin/node', run: () => ({ status: 1 }) }),
    [
      'sudo loginctl enable-linger me',
      'sudo /bin/node ' +
        path.join('/app', 'node_modules/playwright/cli.js') +
        ' install-deps chromium',
    ],
  );
});
test('every way through the install gets the browser libraries, and a failure names the command', () => {
  const script = compact(
      fs.readFileSync(new URL('../scripts/install-computer.mjs', import.meta.url), 'utf8'),
    ),
    root = fs.readFileSync(
      new URL('../deployment/ubuntu-desktop/host-install.sh', import.meta.url),
      'utf8',
    );
  assert.doesNotMatch(root, /\$kit\/node_modules/, 'the kit is copied without node_modules');
  assert.doesNotMatch(root, /install-deps[^\n]*\|\| true/, 'a failure must not be silent');
  assert.match(
    script,
    /basics=\(\)=>\{const left=hostBasics\(\{[^}]*\}\);if\(left\.length\)console\.log\('That did not finish/,
  );
  assert.match(
    script,
    /stop=code=>\{(?:(?!\}const )[^])*?basics\(\)\}/,
    'the path with no computer',
  );
  assert.match(
    script.slice(script.indexOf('if(code)return stop(code);')),
    /basics\(\)/,
    'the path with a computer',
  );
});
test('the firewall check runs with nft present, and sees ufw on any backend', t => {
  const text = fs.readFileSync(
      new URL('../deployment/ubuntu-desktop/host-install.sh', import.meta.url),
      'utf8',
    ),
    check = text.slice(text.indexOf('flag=\n'), text.indexOf('python3 -I -B'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-firewall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = (name, body) =>
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 }),
    run = () =>
      spawnSync('bash', ['-c', 'set -euo pipefail\nPATH="$PWD:$PATH"\n' + check + '\nexit 0'], {
        cwd: dir,
        encoding: 'utf8',
      }).status;
  stub(
    'apt-get',
    `printf '#!/bin/sh\\necho "chain input { type filter hook input priority 0; }"\\n' > nft; chmod +x nft`,
  );
  assert.equal(
    run(),
    3,
    'nft arrives with this step, so the ruleset is seen and the question asked, here with no answer',
  );
  stub('nft', 'exit 0');
  stub('ufw', 'echo "Status: active"');
  assert.equal(run(), 3, 'ufw on the legacy backend leaves no nft ruleset');
  stub('ufw', 'echo "Status: inactive"');
  assert.equal(run(), 0, 'a host with no firewall is not asked');
});
test('first boot goes on from the step that stopped, and its marker holds the cause', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-firstboot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = dir.replaceAll('\\', '/'),
    bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const text = fs
    .readFileSync(
      new URL('../deployment/ubuntu-desktop/guest/firstboot.sh', import.meta.url),
      'utf8',
    )
    .replaceAll('/var/lib/stellarcortex-firstboot-failed', at + '/failed')
    .replaceAll('/var/lib/stellarcortex-firstboot', at + '/state')
    .replace('cd /opt/stellarcortex-worker', 'cd ' + at);
  fs.writeFileSync(path.join(dir, 'firstboot.sh'), text);
  const stub = (name, body = '') =>
    fs.writeFileSync(
      path.join(bin, name),
      '#!/bin/sh\necho "' + name + ' $*" >> "' + at + '/calls"\n' + body + '\n',
      { mode: 0o755 },
    );
  stub('npm');
  stub('node');
  stub('runuser');
  stub('python3', 'cat > /dev/null');
  stub(
    'sh',
    'case "$*" in *fetch-chromium*) [ -e "' +
      at +
      '/down" ] && { echo "download failed: host unreachable"; exit 1; };; esac; exit 0',
  );
  const run = () =>
      spawnSync('bash', ['-c', 'PATH="$PWD/bin:$PATH" bash firstboot.sh'], {
        cwd: dir,
        encoding: 'utf8',
      }).status,
    calls = name =>
      fs
        .readFileSync(path.join(dir, 'calls'), 'utf8')
        .split('\n')
        .filter(line => line.startsWith(name)).length;
  fs.writeFileSync(path.join(dir, 'down'), '');
  assert.equal(run(), 1);
  assert.match(
    fs.readFileSync(path.join(dir, 'failed'), 'utf8'),
    /^browser: download failed: host unreachable/,
  );
  assert.equal(fs.readFileSync(path.join(dir, 'state', 'current'), 'utf8').trim(), 'browser');
  assert.equal(calls('npm'), 1);
  assert.equal(calls('runuser'), 0);
  fs.rmSync(path.join(dir, 'down'));
  fs.rmSync(path.join(dir, 'failed'));
  assert.equal(run(), 0);
  assert.equal(calls('npm'), 1, 'the finished step does not run again');
  assert.equal(calls('runuser'), 1);
  assert.equal(calls('python3'), 1);
  assert.equal(run(), 0);
  assert.equal(calls('runuser'), 1);
});
test('a bot past the limit is told it has no desktop, and nothing else stops', () => {
  assert.match(computerStatusText({ state: 'session-limit' }), /no desktop.*chat works/);
  assert.match(computerSetupText({ state: 'session-limit' }, he), /אין שולחן עבודה/);
});
test('a browser that fails its hash says so, and does not blame the network', () => {
  assert.match(
    computerFailureText('browser-hash', en),
    /does not match its pinned hash.*before you try again/,
  );
  assert.doesNotMatch(computerFailureText('browser-hash', en), /usually/);
  assert.match(computerFailureText('browser-hash', he), /גיבוב/);
});
test('a failure after sudo worked is not reported as a sudo problem', () => {
  const line = fs
    .readFileSync(new URL('../deployment/ubuntu-desktop/host-install.sh', import.meta.url), 'utf8')
    .match(/^trap .* ERR$/m)?.[0];
  assert.ok(line);
  const run = spawnSync('bash', ['-c', 'set -euo pipefail\n' + line + '\nfalse\nexit 0']);
  assert.equal(run.status, 5);
  assert.equal(rootResult(run.status), 'failed');
});
test('removing a session starts only the fixed unit for an approved environment', () => {
  const calls = [],
    child = new EventEmitter(),
    sessions = new SessionOnboarding({
      load: () => ({
        sessionProvisioning: { approved: true, accountId: 'owner', environmentId: 'env' },
        desktops: [{ accountId: 'owner', environmentId: 'env', botId: 'bot' }],
      }),
      run: (bin, args) => {
        calls.push(args);
        return child;
      },
    });
  assert.equal(sessions.remove('owner', 'env', 'bot').state, 'removing');
  sessions.remove('owner', 'env', 'bot');
  assert.deepEqual(calls, [['start', '--no-block', 'stellarcortex-session-remove@bot.service']]);
  assert.throws(() => sessions.remove('other', 'env', 'bot'), /not approved/);
  assert.throws(() => sessions.remove('owner', 'env', '../x'), /not approved/);
});
test('the broker takes only Retry on the build route, and has no way to install for a bot', async t => {
  if (process.platform === 'win32') return t.skip('Unix socket');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-route-')),
    socket = path.join(dir, 'b.sock'),
    asked = [],
    server = createDesktopBrokerServer({
      broker: {
        computerBuild: retry => {
          asked.push(retry);
          return { state: 'ready' };
        },
      },
    });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { createDesktopBrokerClient } = await import('../src/desktop-broker-server.mjs'),
    client = createDesktopBrokerClient(socket);
  assert.deepEqual(await client.computerBuild(), { state: 'ready' });
  await client.computerBuild(true);
  assert.deepEqual(asked, [false, true]);
  assert.equal(client.onboarding, undefined);
});
test('a host that cannot have a computer finishes without one and says why', () => {
  const host = {
    platform: 'linux',
    arch: 'x64',
    exists: () => true,
    memoryMiB: 16384,
    freeGiB: 200,
  };
  assert.equal(computerBlocker(host), null);
  assert.equal(computerBlocker({ ...host, platform: 'darwin' }), 'platform');
  assert.equal(computerBlocker({ ...host, arch: 'arm64' }), 'platform');
  assert.equal(computerBlocker({ ...host, exists: file => file !== '/dev/kvm' }), 'kvm');
  assert.equal(computerBlocker({ ...host, memoryMiB: 8192 }), 'memory');
  assert.equal(computerBlocker({ ...host, exists: file => file !== '/usr/bin/apt-get' }), 'apt');
  assert.equal(computerBlocker({ ...host, freeGiB: 50 }), 'disk');
  assert.equal(rootResult(0), null);
  assert.equal(rootResult(3), 'firewall');
  assert.equal(rootResult(4), 'node');
  assert.equal(rootResult(1), 'root');
  assert.equal(rootResult(null), 'root');
  assert.equal(rootResult(2), 'failed');
});
test('every build state and failure reads in the owner language, with no raw English', () => {
  const hebrew = /[א-ת]/;
  assert.match(
    computerBuildText({ stage: 'install', step: 3, steps: 4, percent: null }, he),
    hebrew,
  );
  assert.match(
    computerBuildText({ stage: 'download', step: 1, steps: 4, percent: 40 }, en),
    /Downloading Ubuntu 40% \(step 1 of 4\)/,
  );
  for (const code of [
    'memory',
    'disk',
    'kvm',
    'download',
    'signature',
    'iso',
    'browser-hash',
    'first-boot',
    'timeout',
    'interrupted',
    'other',
  ]) {
    assert.match(computerFailureText(code, he), hebrew, code);
    assert.match(computerSetupText({ state: 'failed', code, message: 'Raw detail' }, he), hebrew);
    assert.doesNotMatch(
      computerSetupText({ state: 'failed', code, message: 'Raw detail' }, en),
      /Raw detail/,
    );
  }
  for (const code of [
    'platform',
    'kvm',
    'memory',
    'disk',
    'apt',
    'root',
    'node',
    'firewall',
    undefined,
  ])
    assert.match(computerInstallText(code, he), hebrew, String(code));
  for (const state of [
    'not-started',
    'unreachable',
    'setup-required',
    'allocation-available',
    'needs-attention',
    'blocked',
    'session-limit',
    'access-disabled',
  ])
    assert.match(computerSetupText({ state, message: 'Raw detail' }, he), hebrew, state);
});
test('a task error says what to do in the owner language, and the raw text stays under details', async () => {
  const { chatErrorText } = await import('../public/chat-errors.js');
  for (const text of [
    'Connect your ChatGPT subscription in Settings. API-key billing is not used',
    'Connect your Claude subscription through the official Claude Code login',
    'Configure the OpenAI API connection and API key in Settings.',
    'Configure an existing local engine endpoint and model in Settings.',
    'Claude is unavailable: spawn ENOENT',
  ]) {
    const shown = chatErrorText(text, he);
    assert.match(shown.text, /[א-ת]/);
    assert.equal(shown.action, 'connect');
    assert.equal(shown.detail, null);
  }
  const other = chatErrorText('ECONNRESET at socket', he);
  assert.match(other.text, /[א-ת]/);
  assert.equal(other.detail, 'ECONNRESET at socket');
});
test('Settings hears the build from the app, or why this host has no computer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-build-http-')),
    calls = [],
    runtime = new EventEmitter();
  Object.assign(runtime, {
    ready: true,
    start: async () => {},
    stop: async () => {},
    request: async () => ({}),
  });
  const open = async options => {
    const app = await createApp({
        dataDir: dir,
        port: 0,
        startEngine: false,
        runtime,
        claudeRuntime: runtime,
        ...options,
      }),
      base = 'http://127.0.0.1:' + app.port,
      client = { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' },
      cookie = (
        await fetch(base + '/api/session', {
          method: 'POST',
          headers: client,
          body: JSON.stringify({ key: app.accessKey }),
        })
      ).headers
        .get('set-cookie')
        .split(';')[0];
    return {
      app,
      get: async (method = 'GET') =>
        (
          await fetch(base + '/api/computer-build', { method, headers: { ...client, cookie } })
        ).json(),
    };
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'computer-install.json'), JSON.stringify({ code: 'kvm' }));
  const bare = await open({});
  assert.deepEqual(await bare.get(), { available: false, code: 'kvm' });
  await bare.app.close();
  const provider = new DesktopProviderRuntime({
      enabled: true,
      records: [],
      broker: {
        computerBuild: async retry => {
          calls.push(retry);
          return { state: 'building', stage: 'install', step: 3, steps: 4, percent: null };
        },
      },
    }),
    built = await open({ desktopProvider: provider });
  assert.equal((await built.get()).stage, 'install');
  assert.equal((await built.get('POST')).available, true);
  assert.deepEqual(calls, [false, true]);
  await built.app.close();
});
test('a built computer that was stopped reads as off, Retry starts it, and a failed start says so', t => {
  let state = 'running',
    fail = false;
  const children = [],
    f = build(
      t,
      { stage: 'ready' },
      {
        computer: () => ({ uuid: 'u' }),
        domainState: () => {
          if (fail) throw new Error('libvirt is down');
          return state;
        },
        run: (bin, args) => {
          const child = new EventEmitter();
          f.calls.push([bin, ...args]);
          children.push(child);
          return child;
        },
      },
    );
  assert.deepEqual(f.build.status(), { state: 'ready' });
  assert.deepEqual(f.build.retry(), { state: 'ready' });
  assert.deepEqual(f.calls, [], 'a running computer is left alone');
  state = 'shut off';
  assert.deepEqual(f.build.status(), { state: 'stopped' });
  assert.deepEqual(f.build.retry(), { state: 'starting' });
  assert.deepEqual(f.calls, [
    ['/usr/bin/systemctl', 'start', 'stellarcortex-computer-start.service'],
  ]);
  assert.deepEqual(f.build.status(), { state: 'starting' });
  children[0].emit('exit', 1);
  assert.deepEqual(f.build.status(), { state: 'stopped', code: 'start-failed' });
  f.build.retry();
  state = 'running';
  children[1].emit('exit', 0);
  assert.deepEqual(f.build.status(), { state: 'ready' });
  fail = true;
  assert.equal(f.build.status().state, 'stopped', 'libvirt not answering is not running');
});
test('the bundle installs the start unit, which starts the computer past the reboot setting', () => {
  const text = name =>
    fs.readFileSync(new URL('../deployment/ubuntu-desktop/' + name, import.meta.url), 'utf8');
  assert.match(text('computer-start.service'), /boot\.py --now/);
  assert.match(text('host-setup.py'), /files\['stellarcortex-computer-start\.service'\]/);
});
test('Settings shows a stopped computer as off, with Start, and follows it back to running', async () => {
  const { mountComputerBuild, mountComputerModes } = await import('../public/computer-settings.js'),
    { computerStateLabel } = await import('../public/computer-status.js');
  const nodes = {},
    node = {
      isConnected: true,
      hidden: false,
      innerHTML: '',
      querySelector(selector) {
        return this.innerHTML.includes(selector.slice(1, -1)) ? (nodes[selector] ||= {}) : null;
      },
    },
    seen = [];
  let current = { available: true, state: 'stopped' },
    posted = 0;
  const api = async (_route, body) => {
    if (body) {
      posted++;
      current = { available: true, state: 'allocation-available' };
    }
    return current;
  };
  mountComputerBuild(node, { api, tr: en, esc: String, onState: build => seen.push(build.state) });
  await new Promise(setImmediate);
  assert.match(node.innerHTML, /The virtual computer is off/);
  assert.match(node.innerHTML, /data-computer-retry>Start</);
  nodes['[data-computer-retry]'].onclick();
  await new Promise(setImmediate);
  assert.equal(posted, 1);
  assert.equal(node.hidden, true);
  assert.deepEqual(seen, ['stopped', 'allocation-available']);
  assert.equal(computerStateLabel({ state: 'stopped' }, en), 'Off');
  assert.equal(computerStateLabel({ state: 'allocation-available' }, en), 'Running');
  assert.equal(computerStateLabel({ state: 'stopped' }, he), 'כבוי');
  const list = {
    isConnected: true,
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const modes = mountComputerModes(list, {
    api: async () => ({ bots: [], vm: { available: true }, host: { state: 'x11' } }),
    tr: en,
    esc: String,
  });
  await new Promise(setImmediate);
  modes.setBuild({ state: 'stopped' });
  assert.match(list.innerHTML, /Virtual computer: Off/);
  assert.doesNotMatch(list.innerHTML, /Available/);
});
