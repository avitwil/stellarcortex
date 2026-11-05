import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serviceUnit, settingsConf, installedSettings } from '../scripts/linux-service.mjs';
import { compact } from './helpers/source-text.mjs';
const line = (unit, key) => unit.split('\n').find(text => text.startsWith(key + '='));
test('each line of the unit follows the syntax of its own setting, and a path with spaces works', () => {
  const unit = serviceUnit({ root: '/home/a user/100%/$x"y', node: '/opt/my node/$bin/node' });
  assert.equal(
    line(unit, 'WorkingDirectory'),
    'WorkingDirectory=/home/a user/100%%/$x"y',
    'a path setting takes raw text: a quote would be part of the path',
  );
  assert.equal(
    line(unit, 'ExecStart'),
    String.raw`ExecStart="/opt/my node/$bin/node" "/home/a user/100%%/$$x\"y/scripts/managed-launch.mjs"`,
  );
  assert.equal(
    line(serviceUnit({ root: '/home/me/app', node: '/usr/bin/node' }), 'WorkingDirectory'),
    'WorkingDirectory=/home/me/app',
  );
});
test('a value that a unit file cannot hold stops the install', () => {
  for (const root of ['/a\nExecStartPre=/bin/evil', '/a ', '/a\\'])
    assert.throws(() => serviceUnit({ root, node: '/usr/bin/node' }), /cannot hold/);
});
test('systemd itself accepts the unit, where it is available', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'server.mjs'), '');
  const file = path.join(dir, 'stellarcortex.service');
  fs.writeFileSync(file, serviceUnit({ root: dir }));
  const run = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
  if (run.error?.code === 'ENOENT') return t.skip('systemd-analyze is not here');
  assert.doesNotMatch(
    run.stdout + run.stderr,
    /bad unit file setting|not absolute|Invalid|Failed to parse|Unknown key/i,
  );
});
test('settings given to the install reach the service, stay for a later run, and a tailnet link needs only its URL', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = installedSettings({
    home,
    env: {
      STELLARCORTEX_DATA_DIR: '/srv/my data',
      STELLARCORTEX_BIND: '192.0.2.7',
      STELLARCORTEX_TAILNET_UI_URL: 'https://box.example.ts.net/',
    },
  });
  assert.equal(first.data, '/srv/my data');
  assert.equal(first.STELLARCORTEX_UI_SOCKET, path.join('/srv/my data', 'tailscale-ui.sock'));
  const conf = settingsConf(first);
  assert.match(
    conf,
    /^\[Service\]\nEnvironment="STELLARCORTEX_DATA_DIR=\/srv\/my data"\nEnvironment="STELLARCORTEX_BIND=192\.0\.2\.7"\n/,
  );
  assert.doesNotMatch(conf, /data=|port=/, 'only real settings go to the service');
  const file = path.join(
    home,
    '.config',
    'systemd',
    'user',
    'stellarcortex.service.d',
    'install.conf',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, conf);
  const later = installedSettings({ home, env: { PORT: '4400' } });
  assert.equal(later.data, '/srv/my data', 'a run with no settings keeps them');
  assert.equal(later.STELLARCORTEX_BIND, '192.0.2.7');
  assert.equal(later.port, '4400');
  assert.equal(
    installedSettings({ home: path.join(home, 'none'), env: {} }).data,
    path.join(home, 'none', '.stellarcortex'),
  );
  assert.match(settingsConf({ STELLARCORTEX_PUBLIC_URL: 'https://a.example/100%' }), /100%%/);
});
test('no unit in the kit has a quoted path setting, and the host reads the settings file', () => {
  const folder = new URL('../deployment/ubuntu-desktop/', import.meta.url),
    files = [
      ...fs
        .readdirSync(folder)
        .filter(name => name.endsWith('.service'))
        .map(name => new URL(name, folder)),
      new URL('guest/firstboot.service', folder),
    ];
  assert.ok(files.length > 6);
  for (const file of files)
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /^(WorkingDirectory|RootDirectory|ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|EnvironmentFile|PIDFile)=[-+]?["']/m,
      String(file),
    );
  assert.doesNotMatch(
    compact(fs.readFileSync(new URL('guest/install-sessions.py', folder), 'utf8')),
    /WorkingDirectory=["'\\]*"/,
  );
  assert.match(
    compact(fs.readFileSync(new URL('host-setup.py', folder), 'utf8')),
    /service\+'\.d\/\*\.conf'/,
  );
});
test('the install prints the access key only to a terminal, never to its output', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-link-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'access-key'), 'secret-key-value\n');
  const run = spawnSync(
    process.execPath,
    [
      new URL('../scripts/first-link.mjs', import.meta.url).pathname.replace(
        /^\/([A-Za-z]:)/,
        '$1',
      ),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, STELLARCORTEX_DATA_DIR: data },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /secret-key-value/);
});
// npm leaves out an optional package that fails to download, and says nothing.
function installWithNpm(t, npm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-install-')),
    bin = path.join(dir, 'bin');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'node_modules/playwright'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/playwright/cli.js'), '');
  fs.copyFileSync(new URL('../install.sh', import.meta.url), path.join(dir, 'install.sh'));
  for (const [name, body] of [
    ['uname', 'echo Linux'],
    ['npm', 'echo npm >> npm-calls.txt\n' + npm],
  ])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = spawnSync('bash', ['install.sh'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  });
  return {
    run,
    npmRuns: fs.readFileSync(path.join(dir, 'npm-calls.txt'), 'utf8').trim().split('\n').length,
  };
}
test('install.sh installs again when the Codex program is missing', t => {
  const { run, npmRuns } = installWithNpm(
    t,
    `[ -e once ] && { mkdir -p node_modules/@openai/codex/bin; : > node_modules/@openai/codex/bin/codex.js; }\n: > once`,
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(npmRuns, 2);
});
test('install.sh says so and stops when the Codex program still does not run', t => {
  const { run, npmRuns } = installWithNpm(t, 'exit 0');
  assert.equal(run.status, 1);
  assert.match(run.stdout, /The Codex program did not install/);
  assert.equal(npmRuns, 2);
});
test('install.sh stops with a clear message on anything but Linux', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-platform-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8'),
    check = text.slice(
      text.indexOf('if [[ "$(uname -s)"'),
      text.indexOf('if [[ "${1:-}" == \'--desktop-host-bundle\''),
    );
  const run = name => {
    fs.writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\necho ' + name + '\n', { mode: 0o755 });
    return spawnSync('bash', ['-c', 'PATH="$PWD:$PATH"\n' + check + '\nexit 0'], {
      cwd: dir,
      encoding: 'utf8',
    });
  };
  for (const name of ['MINGW64_NT-10.0', 'Darwin']) {
    const stopped = run(name);
    assert.equal(stopped.status, 1);
    assert.match(
      stopped.stdout,
      new RegExp('Linux only.*' + name + '.*Windows version is planned'),
    );
  }
  assert.equal(run('Linux').status, 0);
  assert.ok(text.indexOf('uname -s') < text.indexOf('npm ci'));
});
test('the documents say Linux is supported and Windows is planned', () => {
  for (const [file, text] of [
    ['README.md', /Version 0\.1 supports Linux only, and a Windows version is planned/],
    ['README.he.md', /גרסה 0\.1 תומכת ב־Linux בלבד, וגרסה ל־Windows מתוכננת/],
    ['docs/DEPLOYMENT.md', /Version 0\.1 supports Linux only/],
  ])
    assert.match(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), text);
  for (const file of ['README.md', 'README.he.md'])
    assert.match(
      fs
        .readFileSync(new URL('../' + file, import.meta.url), 'utf8')
        .split('\n')
        .slice(0, 12)
        .join('\n'),
      /https:\/\/stellarcortex\.avitwil\.io/,
    );
});
test('the install restarts the app itself, also on a later run with new settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'),
    log = path.join(dir, 'calls.txt');
  for (const folder of [bin, 'scripts', 'node_modules/playwright'])
    fs.mkdirSync(path.join(folder === bin ? '' : dir, folder), { recursive: true });
  fs.copyFileSync(new URL('../install.sh', import.meta.url), path.join(dir, 'install.sh'));
  for (const file of ['linux-service', 'install-computer', 'first-link'])
    fs.writeFileSync(
      path.join(dir, 'scripts', file + '.mjs'),
      `process.getBuiltinModule('fs').appendFileSync(process.env.CALLS, '${file}\\n');`,
    );
  fs.writeFileSync(path.join(dir, 'node_modules/playwright/cli.js'), '');
  fs.mkdirSync(path.join(dir, 'node_modules/@openai/codex/bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/@openai/codex/bin/codex.js'), '');
  for (const [name, body] of [
    ['uname', 'echo Linux'],
    ['npm', 'exit 0'],
    ['systemctl', 'echo "systemctl $*" >> "$CALLS"'],
  ])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = spawnSync('bash', ['install.sh', '--service'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, CALLS: log, PATH: bin + path.delimiter + process.env.PATH },
  });
  assert.equal(run.status, 0, run.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.includes('systemctl --user restart stellarcortex.service'), calls.join());
  assert.ok(
    calls.indexOf('systemctl --user restart stellarcortex.service') <
      calls.indexOf('install-computer'),
  );
});
test('the computer install does not ask the owner to restart what it restarts itself', () => {
  const text = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
  assert.match(
    text('deployment/ubuntu-desktop/host-install.sh'),
    /STELLARCORTEX_APP_RESTARTS=1 "\$bundle\/install-approved\.sh"/,
  );
  const setup = text('deployment/ubuntu-desktop/host-setup.py'),
    install = setup.slice(setup.indexOf('Host prepared'), setup.indexOf('upgrade = ('));
  assert.match(install, /\$\{STELLARCORTEX_APP_RESTARTS:-\}" \] \|\| printf 'Restart the app/);
  assert.match(
    text('scripts/install-computer.mjs'),
    /'--user', 'restart', 'stellarcortex\.service'/,
  );
});
