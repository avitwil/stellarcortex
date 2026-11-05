import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Claude keeps its sign-in under these, so a login in another environment is invisible to the service.
const CARRIED = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_BIN',
];
const sh = value =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
const powershell = value => `'${value.replaceAll("'", "''")}'`;
// The owner pastes this into a shell, so it must work from any folder and reach the service's sign-in.
export function claudeLoginCommand({
  env = process.env,
  platform = process.platform,
  root = ROOT,
  node = process.execPath,
  container = fs.existsSync('/.dockerenv'),
} = {}) {
  if (container)
    return `docker compose exec stellarcortex node ${sh(path.posix.join(root, 'scripts', 'claude-auth.mjs'))}`;
  if (platform === 'win32') {
    // Double quotes work in cmd and PowerShell. Setting a value has no form that works in both.
    const script = path.win32.join(root, 'scripts', 'claude-auth.mjs'),
      set = ['CLAUDE_CONFIG_DIR', 'CLAUDE_BIN']
        .filter(name => env[name])
        .map(name => `$env:${name}=${powershell(env[name])}; `)
        .join('');
    return set ? `${set}node ${powershell(script)}` : `node "${script}"`;
  }
  const carried = CARRIED.filter(name => env[name]).map(name => `${name}=${sh(env[name])}`);
  return [
    ...(carried.length ? ['env', ...carried] : []),
    sh(node),
    sh(path.posix.join(root, 'scripts', 'claude-auth.mjs')),
  ].join(' ');
}
const SIGN_IN_HOSTS = new Set([
  'claude.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com',
]);
export function trustedSignInLink(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      SIGN_IN_HOSTS.has(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const reasonFor = output =>
  /status code 4\d\d/.test(output)
    ? 'rejected'
    : /ENOTFOUND|ECONN|EAI_AGAIN|ETIMEDOUT|network/i.test(output)
      ? 'network'
      : 'failed';
// Runs the official login for the owner, with the service's own environment, so the sign-in lands where the service reads it.
// The CLI's output only yields the link and a fixed reason. Neither it nor the code is kept, logged or returned.
export class ClaudeLogin {
  constructor(runtime, { timeoutMs = 600000, linkTimeoutMs = 20000 } = {}) {
    Object.assign(this, { runtime, timeoutMs, linkTimeoutMs });
    this.current = null;
    this.last = { state: 'idle' };
  }
  // Connected is said once: this flow only shows when Claude is not connected, so saying it later would be stale.
  status() {
    const login = this.current;
    if (login)
      return login.url
        ? { state: login.submitted ? 'verifying' : 'waiting', url: login.url }
        : { state: 'starting' };
    const last = this.last;
    if (last.state === 'connected') this.last = { state: 'idle' };
    return last;
  }
  start() {
    if (this.current) return this.current.url ? Promise.resolve(this.status()) : this.current.ready;
    const runtime = this.runtime(),
      login = { child: null, url: null, output: '', submitted: false, ended: false };
    this.current = login;
    login.ready = new Promise(resolve => {
      const end = outcome => {
        if (login.ended) return;
        login.ended = true;
        clearTimeout(login.linkTimer);
        clearTimeout(login.timer);
        login.output = '';
        this.current = null;
        this.last = outcome;
        resolve(outcome);
      };
      const abort = reason => {
        if (login.ended) return;
        end({ state: 'failed', reason });
        login.stopping = runtime.kill({ child: login.child }).catch(() => {});
      };
      login.end = end;
      login.abort = abort;
      const read = chunk => {
        login.output = (login.output + chunk).slice(-65536);
      };
      try {
        login.child = runtime.child(['auth', 'login'], { detached: process.platform !== 'win32' });
      } catch {
        return end({ state: 'failed', reason: 'missing' });
      }
      const { child } = login;
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        read(chunk);
        if (login.url) return;
        const found = /https:\/\/[^\s\x07\x1b]+(?=\s)/.exec(login.output);
        if (!found) return;
        const url = trustedSignInLink(found[0]);
        if (!url) return abort('unexpected-link');
        login.url = url;
        clearTimeout(login.linkTimer);
        resolve(this.status());
      });
      child.stderr.on('data', read);
      child.once('error', error =>
        end({ state: 'failed', reason: error.code === 'ENOENT' ? 'missing' : 'failed' }),
      );
      child.once('close', code =>
        end(
          code === 0
            ? { state: 'connected' }
            : { state: 'failed', reason: reasonFor(login.output) },
        ),
      );
      login.linkTimer = setTimeout(() => abort('failed'), this.linkTimeoutMs);
      login.timer = setTimeout(() => abort('timeout'), this.timeoutMs);
      login.linkTimer.unref?.();
      login.timer.unref?.();
    });
    return login.ready;
  }
  submit(code) {
    const login = this.current;
    if (!login?.url || login.submitted) throw new Error('No sign-in is waiting for a code');
    if (typeof code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(code))
      throw new Error('That does not look like a sign-in code');
    login.submitted = true;
    login.child.stdin.write(code + '\n');
    return this.status();
  }
  async cancel() {
    const login = this.current;
    if (!login) return { state: 'idle' };
    login.end({ state: 'idle' });
    if (login.child)
      await this.runtime()
        .kill({ child: login.child })
        .catch(() => {});
    return { state: 'idle' };
  }
}
