import plain from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { noRealSudo, sudoGuard } from './helpers/no-sudo.mjs';

const test = (name, body) => plain(name, { skip: noRealSudo }, body);

const source = fs.readFileSync(new URL('../scripts/stcortex', import.meta.url), 'utf8');
// The host tools as stubs. Each keeps its state in a file, and every call lands in calls.txt.
function host(
  t,
  {
    active = 'no',
    enabled = 'no',
    linger = 'yes',
    computer = 'ready',
    boot = 'false',
    ...stubs
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-stcortex-')),
    bin = path.join(dir, 'bin'),
    home = path.join(dir, 'home'),
    socket = path.join(dir, 'broker.sock').replace(/\\/g, '/'),
    write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/systemd/user/stellarcortex.service'), '');
  write('active', active);
  write('enabled', enabled);
  write('computer', computer);
  write('boot', boot);
  write(
    'script',
    source
      .replace('/run/stellarcortex-desktop-broker/broker.sock', socket)
      .replace(
        '/etc/stellarcortex/desktop-broker.json',
        path.join(dir, 'installed').replace(/\\/g, '/'),
      ),
  );
  if (computer) write('installed', '');
  const tools = {
    systemctl: `case "$2" in
  is-active) [ "$(cat active)" = yes ];;
  is-enabled) [ "$(cat enabled)" = yes ];;
  start) printf yes > active;;
  stop) printf no > active;;
  enable) printf yes > enabled;;
  disable) printf no > enabled;;
esac`,
    curl: `case "$*" in
  *computer-stop*) printf stopped > computer; echo '{"state":"ready"}';;
  *'"retry":true'*) printf ready > computer; echo '{"state":"starting"}';;
  *'boot-policy'*'"enabled":true'*|*'"enabled":true'*'boot-policy'*) printf true > boot; echo '{"enabled":true}';;
  *'boot-policy'*'"enabled":false'*|*'"enabled":false'*'boot-policy'*) printf false > boot; echo '{"enabled":false}';;
  *) echo "{\\"state\\":\\"$(cat computer)\\"}";;
esac`,
    loginctl: `echo ${linger}`,
    sudo: 'exit 0',
    sleep: 'exit 0',
    ...stubs,
  };
  for (const [name, body] of Object.entries(tools))
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> calls.txt\n${body}\n`, {
      mode: 0o755,
    });
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  return {
    home,
    read,
    run: (args, env = {}) => {
      const done = spawnSync('bash', ['script', ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          HOME: home,
          ...sudoGuard(bin),
          ...env,
        },
      });
      return { ...done, output: done.stdout + done.stderr };
    },
    calls: () => (fs.existsSync(path.join(dir, 'calls.txt')) ? read('calls.txt') : ''),
  };
}
test('only the four flags work, and anything else gets one usage line', t => {
  const { run, calls } = host(t);
  for (const args of [[], ['--status'], ['--bad'], ['-x'], ['start'], ['--start', '--stop']]) {
    const done = run(args);
    assert.equal(done.status, 2, String(args));
    assert.equal(done.output, 'Usage: stcortex --start | --stop | --enable | --disable\n');
  }
  assert.equal(calls(), '');
});
test('a user with no install is told so, on every flag', t => {
  const { run, home } = host(t);
  fs.rmSync(path.join(home, '.config'), { recursive: true });
  for (const flag of ['--start', '--stop', '--enable', '--disable']) {
    const done = run([flag]);
    assert.equal(done.status, 1);
    assert.match(done.output, /not installed for this user/);
  }
});
test('root is refused, because the service belongs to the user', t => {
  const { run } = host(t, { id: 'echo 0' });
  const done = run(['--start']);
  assert.equal(done.status, 1);
  assert.match(done.output, /not as root/);
});
test('start brings the tool and a stopped computer back, and leaves the boot setting', t => {
  const { run, read, calls } = host(t, { computer: 'stopped' });
  const done = run(['--start']);
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /StellarCortex started\.\nThe virtual computer started\./);
  assert.equal(read('active'), 'yes');
  assert.equal(read('computer'), 'ready');
  assert.equal(read('enabled'), 'no');
  assert.doesNotMatch(calls(), /systemctl --user (enable|disable)|sudo|loginctl/);
});
test('start says so when everything is already on, and never rebuilds a failed computer', t => {
  const on = host(t, { active: 'yes' });
  assert.match(on.run(['--start']).output, /already running/);
  assert.doesNotMatch(on.calls(), /systemctl --user start|retry/);
  for (const computer of ['failed', 'not-started']) {
    const left = host(t, { active: 'yes', computer });
    const done = left.run(['--start']);
    assert.equal(done.status, 0);
    assert.match(done.output, /not ready\. See Settings > Computer/);
    assert.doesNotMatch(done.output, /already running/);
    assert.doesNotMatch(left.calls(), /retry/);
  }
});
test('start fails plainly when the service or the computer does not start', t => {
  const service = host(t, {
    systemctl: 'case "$2" in is-active) exit 1;; start) exit 1;; esac',
  });
  const stopped = service.run(['--start']);
  assert.equal(stopped.status, 1);
  assert.match(stopped.output, /did not start.*journalctl/);
  const computer = host(t, {
    computer: 'stopped',
    curl: `echo '{"state":"stopped","code":"start-failed"}'`,
  });
  const off = computer.run(['--start']);
  assert.equal(off.status, 1);
  assert.match(off.output, /computer did not start/);
});
test('stop stops the tool first, shuts the computer down, and leaves the boot setting', t => {
  const { run, read, calls } = host(t, { active: 'yes', enabled: 'yes' });
  const done = run(['--stop']);
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /Bots and data are kept/);
  assert.match(done.output, /The virtual computer is off\./);
  assert.equal(read('active'), 'no');
  assert.equal(read('computer'), 'stopped');
  assert.equal(read('enabled'), 'yes', 'it still comes up after a reboot');
  assert.ok(calls().indexOf('systemctl --user stop') < calls().indexOf('computer-stop'));
  assert.doesNotMatch(calls(), /systemctl --user (enable|disable)/);
});
test('stop asks a guest that is still booting again, until it listens', t => {
  const booting = host(t, {
    active: 'yes',
    curl: `case "$*" in
  *computer-stop*) n=$(cat asked 2>/dev/null || echo 0); n=$((n + 1)); echo $n > asked
    [ $n -lt 3 ] || printf stopped > computer; echo '{"state":"ready"}';;
  *) echo "{\\"state\\":\\"$(cat computer)\\"}";;
esac`,
  });
  const done = booting.run(['--stop']);
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /The virtual computer is off\./);
  assert.equal(booting.read('asked').trim(), '3');
});
test('a broker that is down gives one plain line, with none of the raw curl error', t => {
  const curl = 'echo "curl: (7) Failed to connect" >&2; exit 7';
  for (const flag of ['--start', '--stop', '--disable', '--enable']) {
    const done = host(t, { curl }).run([flag]);
    assert.equal(done.status, 1, flag);
    assert.doesNotMatch(done.output, /curl:/, flag);
    assert.match(done.output, /stcortex: /, flag);
  }
});
test('stop says so when everything is off', t => {
  const { run, calls } = host(t, { computer: 'stopped' });
  assert.match(run(['--stop']).output, /already stopped/);
  assert.doesNotMatch(calls(), /computer-stop/);
});
test('stop and disable change nothing while the computer is being prepared', t => {
  for (const flag of ['--stop', '--disable']) {
    const { run, read } = host(t, { active: 'yes', enabled: 'yes', computer: 'building' });
    const done = run([flag]);
    assert.equal(done.status, 1);
    assert.match(done.output, /nothing was changed/);
    assert.equal(read('active'), 'yes');
    assert.equal(read('enabled'), 'yes');
  }
});
test('stop reports a computer that does not go off or cannot be reached', t => {
  const slow = host(t, {
    active: 'yes',
    curl: `echo '{"state":"ready"}'`,
  });
  const late = slow.run(['--stop']);
  assert.equal(late.status, 1);
  assert.match(late.output, /did not shut down within 2 minutes.*run this again/);
  const gone = host(t, { active: 'yes', curl: 'exit 7' });
  const lost = gone.run(['--stop']);
  assert.equal(lost.status, 1);
  assert.match(lost.output, /may still be on/);
  assert.equal(gone.read('active'), 'no', 'the tool still stops');
});
test('a host with no computer only starts and stops the tool', t => {
  const { run, read, calls } = host(t, { computer: '' });
  assert.equal(run(['--start']).status, 0);
  assert.equal(read('active'), 'yes');
  assert.equal(run(['--stop']).status, 0);
  assert.equal(read('active'), 'no');
  assert.doesNotMatch(calls(), /curl/);
});
test('enable starts it now, sets the boot start, and needs no login after a reboot', t => {
  const { run, read, calls } = host(t, { linger: 'no', computer: 'stopped' });
  const done = run(['--enable']);
  assert.equal(done.status, 0, done.output);
  assert.match(done.output, /needs root once, so sudo/);
  assert.match(calls(), /sudo loginctl enable-linger /);
  assert.equal(read('enabled'), 'yes');
  assert.equal(read('active'), 'yes');
  assert.equal(read('computer'), 'ready');
});
test('enable needs no sudo when the login step is done, and says what is already set', t => {
  const { run, calls } = host(t, { active: 'yes', enabled: 'yes' });
  const done = run(['--enable']);
  assert.equal(done.status, 0);
  assert.match(done.output, /already set to start at boot/);
  assert.match(done.output, /already running/);
  assert.doesNotMatch(calls(), /sudo/);
});
test('enable stops with the command to run when sudo cannot do it', t => {
  const { run, read } = host(t, { linger: 'no', sudo: 'exit 1' });
  const done = run(['--enable']);
  assert.equal(done.status, 1);
  assert.match(done.output, /Run: sudo loginctl enable-linger /);
  assert.equal(read('enabled'), 'no');
  assert.equal(read('active'), 'no');
});
test('disable stops both now and turns the Settings boot switch off', t => {
  const { run, read, calls } = host(t, { active: 'yes', enabled: 'yes', boot: 'true' });
  const done = run(['--disable']);
  assert.equal(done.status, 0, done.output);
  assert.equal(read('enabled'), 'no');
  assert.equal(read('active'), 'no');
  assert.equal(read('computer'), 'stopped');
  assert.equal(read('boot'), 'false');
  assert.doesNotMatch(calls(), /linger|sudo/);
});
test('disable says what is already set', t => {
  const { run, read } = host(t, { computer: 'stopped' });
  const done = run(['--disable']);
  assert.equal(done.status, 0);
  assert.match(done.output, /already set not to start at boot/);
  assert.match(done.output, /already stopped/);
  assert.equal(read('boot'), 'false');
});
test('disable changes nothing when the boot switch cannot be set', t => {
  for (const curl of [
    `case "$*" in *boot-policy*) exit 7;; *) echo '{"state":"ready"}';; esac`,
    `case "$*" in *boot-policy*) echo '{"enabled":true}';; *) echo '{"state":"ready"}';; esac`,
  ]) {
    const { run, read } = host(t, { active: 'yes', enabled: 'yes', curl });
    const done = run(['--disable']);
    assert.equal(done.status, 1);
    assert.match(done.output, /nothing else was changed/);
    assert.equal(read('active'), 'yes');
    assert.equal(read('enabled'), 'yes');
  }
});
test('with the broker down, boot cannot be changed, and no flag pretends it was', t => {
  const down = { active: 'yes', enabled: 'yes', curl: 'exit 7' };
  const off = host(t, down);
  const done = off.run(['--disable']);
  assert.equal(done.status, 1);
  assert.match(done.output, /could not cancel.*nothing else was changed.*systemctl status/);
  assert.equal(off.read('active'), 'yes');
  assert.equal(off.read('enabled'), 'yes');
  const on = host(t, { curl: 'exit 7' });
  assert.equal(on.run(['--enable']).status, 1);
  assert.equal(on.read('active'), 'no');
  assert.equal(host(t, down).run(['--start']).status, 1);
  assert.match(host(t, down).run(['--stop']).output, /may still be on/);
});
test('enable turns the Settings boot switch on, or stops before starting anything', t => {
  const on = host(t, { computer: 'stopped' });
  assert.equal(on.run(['--enable']).status, 0);
  assert.equal(on.read('boot'), 'true');
  const stuck = host(t, { curl: `case "$*" in *boot-policy*) exit 7;; esac` });
  const done = stuck.run(['--enable']);
  assert.equal(done.status, 1);
  assert.match(done.output, /could not set the virtual computer/);
  assert.equal(stuck.read('enabled'), 'no');
  assert.equal(stuck.read('active'), 'no');
});
test('start and stop never touch the boot switch', t => {
  for (const flag of ['--start', '--stop']) {
    const { run, read, calls } = host(t, { computer: 'stopped', boot: 'true' });
    assert.equal(run([flag]).status, 0);
    assert.equal(read('boot'), 'true');
    assert.doesNotMatch(calls(), /boot-policy/);
  }
});
test('a host with no computer has no boot switch to set', t => {
  const { run, read, calls } = host(t, { computer: '' });
  assert.equal(run(['--enable']).status, 0);
  assert.equal(run(['--disable']).status, 0);
  assert.equal(read('enabled'), 'no');
  assert.doesNotMatch(calls(), /curl/);
});
test('the command works with no session variables and never touches the access key', t => {
  const { run } = host(t, { active: 'yes' });
  assert.equal(run(['--start'], { XDG_RUNTIME_DIR: '' }).status, 0);
  assert.doesNotMatch(source, /access-key|#key=/);
  assert.doesNotMatch(source, /[א-ת]/);
});
plain('the install and an update put the command where every shell finds it', () => {
  const install = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8'),
    setup = fs.readFileSync(
      new URL('../deployment/ubuntu-desktop/host-setup.py', import.meta.url),
      'utf8',
    ),
    link = fs.readFileSync(new URL('../scripts/first-link.mjs', import.meta.url), 'utf8');
  assert.match(install, /sudo install -m 755 scripts\/stcortex \/usr\/local\/bin\/stcortex/);
  assert.match(install, /install -D -m 755 scripts\/stcortex "\$HOME\/\.local\/bin\/stcortex"/);
  assert.match(setup, /install -m 755 "\$live\/scripts\/stcortex" \/usr\/local\/bin\/stcortex/);
  assert.match(link, /stcortex --start/);
});
test('if sudo is refused the install still leaves the command in the user folder', t => {
  const text = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8'),
    block = text.slice(
      text.indexOf("  echo 'Adding the stcortex command"),
      text.indexOf('  node scripts/install-computer.mjs'),
    ),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-stcortex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts/stcortex'), 'x');
  fs.writeFileSync(path.join(dir, 'bin/sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const done = spawnSync('bash', ['-c', 'set -euo pipefail\n' + block + '\necho END'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      ...sudoGuard(path.join(dir, 'bin')),
    },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /END/);
  assert.ok(fs.existsSync(path.join(dir, '.local/bin/stcortex')));
});
plain('the READMEs explain the four flags', () => {
  for (const file of ['README.md', 'README.he.md']) {
    const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const flag of ['--start', '--stop', '--enable', '--disable'])
      assert.ok(text.includes('stcortex ' + flag), file + flag);
  }
});
