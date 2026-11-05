import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { createApp } from '../src/server.mjs';
import {
  computerSnapshot,
  hostCapability,
  resolveComputer,
  setComputerMode,
} from '../src/computer-mode.mjs';
import { compact } from './helpers/source-text.mjs';

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-computer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}
class Runtime extends EventEmitter {
  constructor() {
    super();
    this.ready = true;
  }
  async start() {}
  async stop() {}
  async request() {
    return {};
  }
}

test('a bot has no computer by default, or a virtual one where the install grants that', () => {
  assert.equal(resolveComputer({}), 'none');
  assert.equal(resolveComputer({}, { defaultVm: true }), 'vm');
  assert.equal(resolveComputer({ computer: 'none' }, { defaultVm: true }), 'none');
  assert.equal(resolveComputer({ computer: 'host' }), 'host');
});
test('host capability reports the screen each platform really has', () => {
  const linux = (env, exists = () => false) => hostCapability({ platform: 'linux', env, exists });
  assert.deepEqual(hostCapability({ platform: 'win32', env: {}, exists: () => false }), {
    platform: 'win32',
    state: 'unsupported',
    screen: false,
  });
  assert.equal(linux({ DISPLAY: ':0' }).screen, true);
  for (const [env, state] of [
    [{ DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }, 'wayland'],
    [{ WAYLAND_DISPLAY: 'wayland-0' }, 'wayland'],
    [{}, 'no-display'],
    [{ WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' }, 'wsl'],
  ]) {
    const result = linux(env);
    assert.equal(result.state, state);
    assert.equal(result.screen, false);
  }
  assert.equal(linux({ DISPLAY: ':0' }, file => file === '/.dockerenv').state, 'container');
});
test('changing a mode validates its input, confirms host control and waits for work to finish', t => {
  const s = store(t),
    bot = s.data.bots[0],
    capability = { vm: false };
  assert.throws(
    () => setComputerMode(s, { botId: bot.id, mode: 'root' }, capability),
    /Unknown computer mode/,
  );
  assert.throws(
    () => setComputerMode(s, { botId: bot.id, mode: 'none', extra: 1 }, capability),
    /Unknown computer settings field/,
  );
  assert.throws(
    () => setComputerMode(s, { botId: bot.id, mode: 'vm' }, capability),
    /not configured/,
  );
  assert.throws(
    () => setComputerMode(s, { botId: bot.id, mode: 'host' }, capability),
    /Explicit confirmation/,
  );
  assert.equal(bot.computer, undefined);
  s.data.jobs.push({ botId: bot.id, status: 'queued' });
  assert.throws(
    () => setComputerMode(s, { botId: bot.id, mode: 'host', confirmHost: true }, capability),
    /Wait for this bot/,
  );
  s.data.jobs.length = 0;
  assert.equal(
    setComputerMode(s, { botId: bot.id, mode: 'host', confirmHost: true }, capability).bots[0]
      .computer,
    'host',
  );
  assert.equal(new Store(s.dir).data.bots[0].computer, 'host');
  assert.equal(
    setComputerMode(s, { botId: bot.id, mode: 'vm' }, { vm: true }).bots[0].computer,
    'vm',
  );
});
test('a bot, a template or an import cannot set a computer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-computer-')),
    s = new Store(dir),
    engine = new Engine(s, new Runtime(), { close: async () => {} });
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bot = s.data.bots[0],
    job = {
      id: 'job',
      botId: bot.id,
      chatId: s.data.chats[0].id,
      status: 'running',
      provider: 'codex',
    };
  const created = JSON.parse(
    (
      await engine.tool(job, 'stellarcortex_team', {
        action: 'create',
        name: 'Made by bot',
        computer: 'host',
      })
    )[0].text,
  );
  assert.equal(s.bot(created.bot.id).computer, undefined);
  await engine
    .tool(job, 'stellarcortex_team', {
      action: 'update',
      botId: created.bot.id,
      computer: 'host',
      title: 'x',
    })
    .catch(() => {});
  assert.equal(s.bot(created.bot.id).computer, undefined);
  assert.equal(s.createBot({ name: 'Imported', computer: 'host' }).bot.computer, undefined);
  s.updateBot(bot.id, { computer: 'host', title: 'y' });
  assert.equal(bot.computer, undefined);
  setComputerMode(s, { botId: bot.id, mode: 'host', confirmHost: true }, {});
  assert.equal('computer' in s.botTemplate(bot.id).bot, false);
});
test('the settings route needs a session and the same-site header', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-computer-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      runtime: new Runtime(),
      claudeRuntime: new Runtime(),
      startEngine: false,
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`,
    client = { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
    bot = app.store.data.bots[0],
    url = base + '/api/computer-modes';
  assert.equal((await fetch(url)).status, 401);
  const headers = {
    ...client,
    Cookie: (
      await fetch(base + '/api/session', {
        method: 'POST',
        headers: client,
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0],
  };
  assert.equal(
    (await fetch(url, { method: 'PATCH', headers: { Cookie: headers.Cookie }, body: '{}' })).status,
    403,
  );
  const read = await (await fetch(url, { headers })).json();
  assert.equal(read.vm.available, false);
  assert.equal(read.bots[0].computer, 'none');
  assert.match(read.warning, /server’s OS user/);
  assert.equal(
    (await (await fetch(base + '/api/state', { headers })).json()).computerDefault,
    'none',
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ botId: bot.id, mode: 'host' }),
      })
    ).status,
    400,
  );
  const saved = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ botId: bot.id, mode: 'host', confirmHost: true }),
  });
  assert.equal(saved.status, 200);
  assert.equal(bot.computer, 'host');
  assert.equal(
    (
      await fetch(`${base}/api/bots/${bot.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ computer: 'none' }),
      })
    ).status,
    200,
  );
  assert.equal(bot.computer, 'host');
});
test('the snapshot leaves out deleted bots', t => {
  const s = store(t),
    made = s.createBot({ name: 'Gone' }).bot;
  made.deletedAt = 'now';
  assert.equal(
    computerSnapshot(s).bots.some(bot => bot.id === made.id),
    false,
  );
});
test('the old access switch becomes the mode and is gone from the store', t => {
  const s = store(t),
    [off, on, set] = [
      s.data.bots[0],
      s.createBot({ name: 'On' }).bot,
      s.createBot({ name: 'Set' }).bot,
    ];
  off.computerAccess = false;
  on.computerAccess = true;
  set.computerAccess = false;
  set.computer = 'host';
  s.save();
  const loaded = new Store(s.dir),
    modes = [off, on, set].map(bot => loaded.bot(bot.id));
  assert.deepEqual(
    modes.map(bot => bot.computer),
    ['none', 'vm', 'host'],
  );
  assert.equal(
    modes.some(bot => 'computerAccess' in bot),
    false,
  );
});
// -B keeps __pycache__ out of the tree, because the bundle refuses to pack it.
const runPython = (code, ...args) =>
  execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-I', '-B', '-c', code, ...args], {
    encoding: 'utf8',
    timeout: 20000,
  });
test('a bundle installs the unit the broker starts and writes the data folder into the manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-bundle-')),
    source = path.join(root, 'source'),
    out = path.join(root, 'bundle');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['src', 'scripts', 'deployment/ubuntu-desktop']) {
    fs.mkdirSync(path.join(source, name), { recursive: true });
    fs.writeFileSync(path.join(source, name, 'fixture.txt'), 'code');
  }
  const iso = path.join(root, 'image.iso');
  fs.writeFileSync(iso, 'image');
  for (const name of ['package.json', 'package-lock.json'])
    fs.writeFileSync(path.join(source, name), '{}');
  runPython(
    `import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('host',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.check_source=lambda *a:None
m.render(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),4242,'a'*64,'stellarcortex.service','/srv/app/data',pathlib.Path(sys.argv[4]))`,
    fileURLToPath(new URL('../deployment/ubuntu-desktop/host-setup.py', import.meta.url)),
    source,
    out,
    iso,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(out, 'desktop-provider.json'), 'utf8')).dataDir,
    '/srv/app/data',
  );
  const unit = fs.readFileSync(path.join(out, 'stellarcortex-session-provision@.service'), 'utf8');
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/python3 -I \/opt\/stellarcortex-desktop-broker\/deployment\/ubuntu-desktop\/session-provision\.py %i$/m,
  );
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/stellarcortex\/desktops \/etc\/stellarcortex$/m);
  assert.doesNotMatch(unit, /\/home\/|\/srv\//);
  assert.match(
    compact(
      fs.readFileSync(new URL('../src/desktop-session-onboarding.mjs', import.meta.url), 'utf8'),
    ),
    /'stellarcortex-session-provision@'\+bot\+'\.service'/,
  );
  assert.match(
    fs.readFileSync(path.join(out, 'install-approved.sh'), 'utf8'),
    /install -m 644 \.\/\*\.service \/etc\/systemd\/system\//,
  );
  // A unit must not depend on a folder that only the bundle creates.
  for (const [name, folder] of [
    ['computer-build@', 'provisioning'],
    ['session-provision@', 'sessions'],
    ['session-remove@', 'sessions'],
  ])
    assert.match(
      fs.readFileSync(path.join(out, `stellarcortex-${name}.service`), 'utf8'),
      new RegExp(`^StateDirectory=stellarcortex/desktops/${folder}$`, 'm'),
    );
  assert.match(
    fs.readFileSync(path.join(out, 'stellarcortex-desktop-broker.service'), 'utf8'),
    /^StateDirectory=stellarcortex\/desktops\/broker$/m,
  );
  assert.match(
    fs.readFileSync(path.join(out, 'stellarcortex-computer-build@.service'), 'utf8'),
    /^RuntimeDirectory=stellarcortex-desktops$/m,
  );
});
test('the first computer becomes the environment, bots get it unless the owner says no, and a later one does not take over', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const python = `import base64,importlib.util,json,pathlib,sys,types
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
locks=[];sys.modules['fcntl']=types.SimpleNamespace(LOCK_EX=2,flock=lambda file,mode:locks.append([pathlib.Path(file.name).name,mode]))
sys.modules['pwd']=types.ModuleType('pwd')
m=load('installer',sys.argv[1]);provision=load('provision',sys.argv[2]);boot=load('boot',sys.argv[4]);root=pathlib.Path(sys.argv[3])
broker,provider=root/'broker.json',root/'provider.json';m.BROKER,m.PROVIDER=str(broker),str(provider);m.ROOT=root;(root/'provisioning').mkdir()
old={'accountId':'owner','botId':'old-bot','vmId':'05','uuid':'33333333-3333-3333-3333-333333333333','domain':'scx-desktop-05'}
broker.write_text(json.dumps({'approved':True,'desktops':[old]}));provider.write_text(json.dumps({'enabled':True,'records':[old]}))
plan=lambda vm,uid:{'accountId':'owner','botId':'first','vmId':vm,'uuid':uid}
def register(p):
 m.qga=lambda p,c:{'exited':True,'exitcode':0,'out-data':base64.b64encode(json.dumps(m.record(p)).encode()).decode()}
 m.subprocess=types.SimpleNamespace(run=lambda *a,**k:types.SimpleNamespace(stdout=json.dumps({'result':{'available':True},'generation':p['uuid']})),CalledProcessError=Exception,TimeoutExpired=Exception)
 return m.publish_result(p,1)
first=plan('02','11111111-1111-1111-1111-111111111111');results=[register(first),register(first)]
b=json.loads(broker.read_text());v=json.loads(provider.read_text())
base=provision.base_record(b,b['sessionProvisioning'],v['environmentComputer'])
start=boot.startup_actions({**b,'bootApproved':True},lambda name:({'scx-desktop-02':first['uuid']}.get(name,old['uuid']),'shut off'))
try:register({**plan('03','22222222-2222-2222-2222-222222222222'),'botId':'second'});second='registered'
except RuntimeError as error:second=str(error)
print(json.dumps({'second':second,'results':results,'broker':b,'provider':v,'base':base,'start':start,'locks':locks,'after':json.loads(broker.read_text()),'afterProvider':json.loads(provider.read_text())}))`;
  const file = name =>
    fileURLToPath(new URL(`../deployment/ubuntu-desktop/${name}`, import.meta.url));
  const { second, results, broker, provider, base, start, locks, after, afterProvider } =
    JSON.parse(
      runPython(python, file('installer.py'), file('session-provision.py'), dir, file('boot.py')),
    );
  const ids = { accountId: 'owner', environmentId: 'scx-desktop-02', computerId: 'scx-desktop-02' };
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(broker.desktops, []);
  assert.deepEqual(provider.records, []);
  assert.deepEqual(
    broker.preservedComputers.map(row => row.vmId),
    ['05', '02'],
    'an older computer is kept, and its bots move to sessions',
  );
  assert.deepEqual(provider.environmentComputer, { ...ids, defaultAccess: true, overrides: {} });
  assert.equal(broker.sessionProvisioning.approved, true);
  assert.equal(broker.sessionProvisioning.environmentId, ids.environmentId);
  assert.equal(base.domain, 'scx-desktop-02');
  assert.equal(base.cid, 152);
  assert.deepEqual(after.sessionProvisioning, broker.sessionProvisioning);
  assert.deepEqual(after.desktops, []);
  assert.match(second, /remove-computer/);
  assert.deepEqual(afterProvider.environmentComputer, provider.environmentComputer);
  assert.match(
    compact(fs.readFileSync(file('guest/install-sessions.py'), 'utf8')),
    /if incremental and registryfile\.exists\(\)else\[\]/,
  );
  assert.deepEqual(start, ['scx-desktop-05', 'scx-desktop-02']);
  assert.deepEqual(
    broker.preservedComputers.map(row => row.domain),
    ['scx-desktop-05', 'scx-desktop-02'],
  );
  assert.deepEqual(after.preservedComputers, broker.preservedComputers);
  assert.deepEqual(locks[0], ['.environment.lock', 2]);
  assert.equal(locks.length, 3);
});
test('every place that meets a stopped computer sends the owner to Start in Settings', async () => {
  const { STOPPED_COMPUTER } = await import('../src/desktop-provider-session.mjs'),
    read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'),
    step = 'Press Start in Settings > Computer';
  assert.match(STOPPED_COMPUTER, /Settings > Computer/);
  assert.ok(STOPPED_COMPUTER.includes(step));
  for (const name of [
    'src/desktop-broker-server.mjs',
    'src/desktop-display-auth.mjs',
    'src/desktop-provider-routes.mjs',
  ]) {
    assert.doesNotMatch(read(name), /Desktop is not running/, name);
    assert.match(read(name), /Error\(STOPPED_COMPUTER\)/, name);
  }
  assert.ok(
    compact(read('deployment/ubuntu-desktop/session-provision.py')).includes(
      compact(STOPPED_COMPUTER),
    ),
  );
  assert.match(read('public/computer-settings.js'), /tr\('הפעלה', 'Start'\)/);
  for (const name of ['deployment/ubuntu-desktop/README.md']) {
    assert.ok(read(name).includes('boot.py --now'), name);
    assert.match(read(name), /virsh start/, name);
  }
  assert.match(compact(read('deployment/ubuntu-desktop/host-setup.py')), /'bootApproved':True/);
});
test('a bot session needs screen software before its user exists and a live screen before it is registered', () => {
  const file = name =>
    fileURLToPath(new URL(`../deployment/ubuntu-desktop/${name}`, import.meta.url));
  const python = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('ready',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def attempt(fn):
 try:fn();return 'ok'
 except SystemExit as error:return str(error)
present=set();installed=[]
def install(packages):
 installed.extend(packages);present.update(m.SCREEN)
first=attempt(lambda:m.ensure_screen_software(present.__contains__,install))
broken=attempt(lambda:m.ensure_screen_software(set().__contains__,lambda packages:None))
answers=iter([True,False,True,True,True]);seen=[]
def ready():
 seen.append(1);return next(answers)
flapping=attempt(lambda:m.wait_for_screen(ready,sleep=lambda s:None))
dead=attempt(lambda:m.wait_for_screen(lambda:False,sleep=lambda s:None))
print(json.dumps([first,installed,broken,flapping,len(seen),dead]))`;
  const [first, installed, broken, flapping, checks, dead] = JSON.parse(
    runPython(python, file('guest/session_ready.py')),
  );
  assert.equal(first, 'ok');
  for (const name of [
    'tigervnc-standalone-server',
    'xfce4',
    'xauth',
    'dbus-x11',
    'dbus-user-session',
    'xdotool',
    'imagemagick',
    'fonts-culmus',
  ])
    assert.ok(installed.includes(name), name);
  assert.match(broken, /Screen software missing/);
  assert.equal(flapping, 'ok');
  assert.equal(checks, 5);
  assert.match(dead, /not registered/);
  const script = compact(fs.readFileSync(file('guest/install-sessions.py'), 'utf8')),
    position = text => {
      const at = script.indexOf(text);
      assert.notEqual(at, -1, text);
      return at;
    };
  assert.ok(position('ensure_screen_software(') < position("run('/usr/sbin/groupadd'"));
  assert.ok(position("'start','stellarcortex-session.target'") < position('wait_for_screen('));
  assert.ok(
    position('wait_for_screen(') < position("write('/etc/stellarcortex/session-registry.json'"),
  );
  const check = script.slice(
    position('wait_for_screen('),
    script.indexOf('\n', position('wait_for_screen(')),
  );
  assert.ok(check.includes('vnc.sock'));
  assert.ok(check.includes("for part in['display','desktop','browser','worker']"));
  const firstBoot = fs.readFileSync(file('guest/firstboot.sh'), 'utf8');
  assert.doesNotMatch(
    firstBoot,
    /apt-get/,
    'the screen packages come with the installation, in its one apt pass',
  );
  assert.match(firstBoot, /npm ci --omit=optional/);
  assert.match(
    compact(fs.readFileSync(file('session-provision.py'), 'utf8')),
    /install-sessions\.py '\+guestplan,1500\)/,
  );
});
test('the bundle finds the data folder from the app service, then the default under its home', () => {
  const python = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('host',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
files={'/etc/app.env':'# STELLARCORTEX_DATA_DIR=/old\\nSTELLARCORTEX_DATA_DIR="/srv/file"\\n'}
def read(name):
 if name not in files:raise FileNotFoundError(name)
 return files[name]
find=lambda text:m.app_data_dir(text,1000,home=lambda uid:'/home/owner',read=read)
print(json.dumps([find('Environment=PORT=4317 STELLARCORTEX_DATA_DIR=/srv/app/data\\n'),find('ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node scripts/managed-launch.mjs --manager-dir /srv/m --data-dir /srv/d ; }\\n'),find('Environment=PORT=4317\\n'),find('Environment=STELLARCORTEX_DATA_DIR=/srv/app/data\\nEnvironmentFiles=/etc/app.env (ignore_errors=no)\\n'),find('EnvironmentFiles=/etc/absent.env (ignore_errors=yes)\\n')]))`;
  assert.deepEqual(
    JSON.parse(
      runPython(
        python,
        fileURLToPath(new URL('../deployment/ubuntu-desktop/host-setup.py', import.meta.url)),
      ),
    ),
    [
      '/srv/app/data',
      '/srv/d',
      '/home/owner/.stellarcortex',
      '/srv/file',
      '/home/owner/.stellarcortex',
    ],
  );
});
test('provisioning reads bots from the configured data folder and refuses to guess one', () => {
  const file = fileURLToPath(
    new URL('../deployment/ubuntu-desktop/session-provision.py', import.meta.url),
  );
  const python = `import importlib.util,json,sys,types
sys.modules['fcntl']=types.ModuleType('fcntl')
spec=importlib.util.spec_from_file_location('provision',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def refused(value):
 try:m.state_file(value)
 except RuntimeError as error:return str(error)
print(json.dumps([m.state_file({'dataDir':'/srv/app/data'}).as_posix(),refused({}),refused({'dataDir':'relative/data'})]))`;
  const [state, missing, relative] = JSON.parse(runPython(python, file));
  assert.equal(state, '/srv/app/data/state.json');
  assert.match(missing, /dataDir/);
  assert.match(relative, /dataDir/);
  const script = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(script, /stellarcortex\/data/);
  assert.match(script, /json\.loads\(state_file\(provider\)\.read_text\(\)\)/);
  assert.match(
    compact(
      fs.readFileSync(
        new URL('../deployment/ubuntu-desktop/host-setup.py', import.meta.url),
        'utf8',
      ),
    ),
    /'dataDir':data_dir/,
  );
});
test('provisioning decides access the same way as the app', () => {
  const script = compact(
    fs.readFileSync(
      new URL('../deployment/ubuntu-desktop/session-provision.py', import.meta.url),
      'utf8',
    ),
  );
  assert.doesNotMatch(script, /computerAccess/);
  assert.match(
    script,
    /computer=candidate\.get\('computer'\)allowed=env\.get\('overrides',\{\}\)\.get\(bot,computer=='vm' if computer else env\['defaultAccess'\]\)/,
  );
});
