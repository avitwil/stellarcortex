import fs from 'node:fs';
import { spawn } from 'node:child_process';
// Every computer tool call of a bot past the limit lands here, and each try is a root unit.
const LIMIT_WAIT_MS = 60000;
export class SessionOnboarding {
  constructor({
    load,
    directory = '/var/lib/stellarcortex/desktops/sessions',
    run = spawn,
    now = Date.now,
  }) {
    Object.assign(this, { load, directory, run, now });
    this.pending = new Set();
    this.limited = new Map();
  }
  status(account, environment, bot) {
    if (
      ![account, environment, bot].every(
        v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v),
      )
    )
      throw Error('Stable session identity required');
    const cfg = this.load(),
      policy = cfg.sessionProvisioning;
    if (!policy?.approved || policy.accountId !== account || policy.environmentId !== environment)
      throw Error('Environment session provisioning is not approved');
    if (
      cfg.desktops.some(
        r => r.accountId === account && r.environmentId === environment && r.botId === bot,
      )
    )
      return { state: 'ready' };
    try {
      return JSON.parse(fs.readFileSync(this.directory + '/' + bot + '.json', 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return {
      state: 'allocation-available',
      active: this.pending.has(bot),
      message: 'Preparing a separate desktop on the environment computer.',
    };
  }
  ensure(account, environment, bot, start) {
    const state = this.status(account, environment, bot);
    if (
      !start ||
      !['allocation-available', 'blocked', 'session-limit'].includes(state.state) ||
      this.pending.has(bot)
    )
      return state;
    if (state.state === 'session-limit') {
      if (this.now() - (this.limited.get(bot) ?? -LIMIT_WAIT_MS) < LIMIT_WAIT_MS) return state;
      this.limited.set(bot, this.now());
    }
    this.pending.add(bot);
    const child = this.run(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'stellarcortex-session-provision@' + bot + '.service'],
      { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } },
    );
    const clear = () => this.pending.delete(bot);
    child.once('error', clear);
    child.once('exit', clear);
    return { ...state, active: true };
  }
  remove(account, environment, bot) {
    const cfg = this.load(),
      policy = cfg.sessionProvisioning;
    if (
      ![account, environment, bot].every(
        v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v),
      ) ||
      !policy?.approved ||
      policy.accountId !== account ||
      policy.environmentId !== environment
    )
      throw Error('Environment session provisioning is not approved');
    if (
      !cfg.desktops.some(
        r => r.accountId === account && r.environmentId === environment && r.botId === bot,
      ) &&
      !fs.existsSync(this.directory + '/' + bot + '.json')
    )
      return { state: 'removed' };
    const key = 'remove-' + bot;
    if (this.pending.has(key)) return { state: 'removing' };
    this.pending.add(key);
    const child = this.run(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'stellarcortex-session-remove@' + bot + '.service'],
      { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } },
    );
    const clear = () => this.pending.delete(key);
    child.once('error', clear);
    child.once('exit', clear);
    return { state: 'removing' };
  }
}
