import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ClaudeLogin, claudeLoginCommand, trustedSignInLink } from '../src/claude-login.mjs';
import { Claude } from '../src/claude.mjs';
import { TOOLS } from '../src/engine.mjs';
import { createApp } from '../src/server.mjs';

const linux = { platform: 'linux', container: false, root: '/srv/app', node: '/usr/bin/node' };
test('a Linux command carries the service home, its XDG folders and the Claude settings, and nothing else', () => {
  const env = {
    HOME: '/srv/home',
    XDG_CONFIG_HOME: '/srv/home/.config',
    XDG_DATA_HOME: '/srv/home/.local/share',
    XDG_STATE_HOME: '/srv/home/.local/state',
    XDG_CACHE_HOME: '/srv/home/.cache',
    CLAUDE_CONFIG_DIR: '/srv/claude',
    CLAUDE_BIN: '/opt/claude',
    ANTHROPIC_API_KEY: 'test-secret',
    PATH: '/bin',
  };
  assert.equal(
    claudeLoginCommand({ ...linux, env }),
    'env HOME=/srv/home XDG_CONFIG_HOME=/srv/home/.config XDG_DATA_HOME=/srv/home/.local/share XDG_STATE_HOME=/srv/home/.local/state XDG_CACHE_HOME=/srv/home/.cache CLAUDE_CONFIG_DIR=/srv/claude CLAUDE_BIN=/opt/claude /usr/bin/node /srv/app/scripts/claude-auth.mjs',
  );
  assert.equal(
    claudeLoginCommand({ ...linux, env: {} }),
    '/usr/bin/node /srv/app/scripts/claude-auth.mjs',
  );
});
test('paths with spaces or quotes stay one argument', () => {
  assert.equal(
    claudeLoginCommand({
      ...linux,
      root: '/srv/my app',
      node: '/opt/node js/node',
      env: { HOME: "/srv/owner's home" },
    }),
    `env HOME='/srv/owner'\\''s home' '/opt/node js/node' '/srv/my app/scripts/claude-auth.mjs'`,
  );
});
test('Windows gives a form both shells accept, and PowerShell when it must set a value', () => {
  const windows = {
    platform: 'win32',
    container: false,
    root: 'C:\\Program Files\\Stellar Cortex',
    node: 'C:\\Program Files\\nodejs\\node.exe',
  };
  assert.equal(
    claudeLoginCommand({ ...windows, env: { HOME: 'C:\\Users\\owner' } }),
    'node "C:\\Program Files\\Stellar Cortex\\scripts\\claude-auth.mjs"',
  );
  assert.equal(
    claudeLoginCommand({ ...windows, env: { CLAUDE_BIN: "C:\\Tools\\o'neil\\claude.exe" } }),
    "$env:CLAUDE_BIN='C:\\Tools\\o''neil\\claude.exe'; node 'C:\\Program Files\\Stellar Cortex\\scripts\\claude-auth.mjs'",
  );
});
test('in a container the command runs from the host through compose, with the container environment', () => {
  assert.equal(
    claudeLoginCommand({
      platform: 'linux',
      container: true,
      root: '/opt/stellarcortex',
      node: '/usr/local/bin/node',
      env: { HOME: '/home/node', CLAUDE_CONFIG_DIR: '/home/node/.claude' },
    }),
    'docker compose exec stellarcortex node /opt/stellarcortex/scripts/claude-auth.mjs',
  );
});
test('the real command runs from another folder and hands the service home to the script', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stellar login's ")),
    root = path.join(dir, 'my app'),
    home = path.join(dir, 'service home');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'claude-auth.mjs'),
    'console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME}));',
  );
  const windows = process.platform === 'win32',
    command = claudeLoginCommand({ root, container: false, env: windows ? {} : { HOME: home } });
  const result = JSON.parse(
    execSync(command, { cwd: os.tmpdir(), encoding: 'utf8', timeout: 20000 }),
  );
  assert.equal(path.resolve(result.cwd), path.resolve(fs.realpathSync(os.tmpdir())));
  if (!windows) assert.equal(result.home, home);
});
const until = async check => {
  for (let tries = 0; tries < 200; tries++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting');
};
const running = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function stub(t, { link = 'https://claude.com/cai/oauth/authorize?code=true&state=abc' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-claude-login-')),
    script = path.join(dir, 'claude.mjs'),
    record = path.join(dir, 'record.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),home:process.env.STUB_HOME,pid:process.pid}));
process.stdout.write('Opening browser to sign in\\n');process.stdout.write("If the browser didn't open, visit: ${link}\\nPaste code here if prompted > ");
const lines=readline.createInterface({input:process.stdin});lines.once('line',line=>{if(line==='good#state')process.exit(0);process.stderr.write('Login failed: Request failed with status code 400 for '+line+'\\n');process.exit(1);});
setInterval(()=>{},1000);`,
  );
  const runtime = new Claude({
    command: { bin: process.execPath, prefix: [script] },
    environment: { ...process.env, STUB_HOME: '/service/home' },
  });
  return { runtime, read: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}
test('only https links to Claude hosts are accepted', () => {
  assert.ok(trustedSignInLink('https://claude.com/cai/oauth/authorize?state=1'));
  assert.ok(trustedSignInLink('https://platform.claude.com/oauth'));
  for (const link of [
    'http://claude.com/',
    'https://claude.com.evil.test/',
    'https://evil.test/claude.com',
    'https://user@claude.com/',
    'https://claude.com:8443/',
    'javascript:alert(1)',
    'nonsense',
  ])
    assert.equal(trustedSignInLink(link), null, link);
});
test('a code reaches the official login, which runs with the service environment', async t => {
  const { runtime, read } = stub(t),
    login = new ClaudeLogin(() => runtime);
  t.after(() => login.cancel());
  const first = await login.start();
  assert.equal(first.state, 'waiting');
  assert.match(first.url, /^https:\/\/claude\.com\//);
  const again = await login.start();
  assert.equal(again.url, first.url);
  assert.deepEqual(read().args, ['auth', 'login']);
  assert.equal(read().home, '/service/home');
  assert.equal(login.submit('good#state').state, 'verifying');
  assert.throws(() => login.submit('good#state'), /No sign-in is waiting/);
  await until(() => login.last.state === 'connected');
  assert.deepEqual(login.status(), { state: 'connected' });
  assert.deepEqual(login.status(), { state: 'idle' }, 'a later disconnect must show Connect again');
});
test('a refused code gives a fixed reason and no CLI text or code', async t => {
  const { runtime } = stub(t),
    login = new ClaudeLogin(() => runtime);
  t.after(() => login.cancel());
  await login.start();
  login.submit('wrong-canary-code');
  await until(() => login.status().state === 'failed');
  assert.deepEqual(login.status(), { state: 'failed', reason: 'rejected' });
  assert.equal(JSON.stringify(login).includes('wrong-canary-code'), false);
});
test('a link to another host stops the login and never reaches the page', async t => {
  const { runtime, read } = stub(t, { link: 'https://claude.com.evil.test/oauth' }),
    login = new ClaudeLogin(() => runtime);
  assert.deepEqual(await login.start(), { state: 'failed', reason: 'unexpected-link' });
  await until(() => !running(read().pid));
});
test('cancel ends the process, one login runs at a time, and a new one can start', async t => {
  const { runtime, read } = stub(t),
    login = new ClaudeLogin(() => runtime);
  t.after(() => login.cancel());
  const [one, two] = await Promise.all([login.start(), login.start()]);
  assert.equal(one.url, two.url);
  const { pid } = read();
  assert.ok(running(pid));
  assert.deepEqual(await login.cancel(), { state: 'idle' });
  await until(() => !running(pid));
  assert.deepEqual(login.status(), { state: 'idle' });
  assert.equal((await login.start()).state, 'waiting');
  assert.notEqual(read().pid, pid);
});
test('a login that is never finished times out and its process ends', async t => {
  const { runtime, read } = stub(t),
    login = new ClaudeLogin(() => runtime, { timeoutMs: 300 });
  await login.start();
  const { pid } = read();
  await until(() => login.status().state === 'failed');
  assert.deepEqual(login.status(), { state: 'failed', reason: 'timeout' });
  await until(() => !running(pid));
});
test('a missing CLI and a bad code format are reported without starting anything else', async t => {
  const runtime = new Claude({
      command: { bin: path.join(os.tmpdir(), 'stellar-no-such-claude'), prefix: [] },
    }),
    login = new ClaudeLogin(() => runtime);
  assert.deepEqual(await login.start(), { state: 'failed', reason: 'missing' });
  const live = stub(t),
    waiting = new ClaudeLogin(() => live.runtime);
  t.after(() => waiting.cancel());
  await waiting.start();
  for (const code of ['two\nlines', 'with space', '', 42])
    assert.throws(() => waiting.submit(code), /sign-in code/);
  assert.equal(waiting.status().state, 'waiting');
});
test('the route needs the owner session, and no bot tool or state carries the login', async t => {
  const { runtime } = stub(t),
    codex = Object.assign(new EventEmitter(), {
      ready: true,
      async start() {},
      async stop() {},
      respond() {},
      reject() {},
      async request() {
        return {};
      },
    });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-login-route-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      runtime: codex,
      claudeRuntime: runtime,
      startEngine: false,
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${app.port}`,
    client = { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' },
    post = (headers, body) =>
      fetch(base + '/api/claude-login', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post(client, { action: 'start' })).status, 401);
  assert.equal((await fetch(base + '/api/claude-login')).status, 401);
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
    (
      await post(
        { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
        { action: 'start' },
      )
    ).status,
    403,
  );
  const started = await (await post(headers, { action: 'start' })).json();
  assert.equal(started.state, 'waiting');
  const state = await (await fetch(base + '/api/state', { headers })).text();
  assert.equal(state.includes('oauth/authorize'), false);
  assert.equal(
    TOOLS.some(tool => /login|sign.?in|auth/i.test(tool.name)),
    false,
  );
  assert.equal((await (await post(headers, { action: 'cancel' })).json()).state, 'idle');
  assert.equal((await post(headers, { action: 'other' })).status, 400);
});
