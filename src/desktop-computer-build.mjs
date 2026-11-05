import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
const STEPS = ['download', 'prepare', 'install', 'first-boot'],
  ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };
// The build is one root service. This reads how it is going, starts it again on the owner's Retry,
// and once built tells whether the computer really runs, because a finished build can be stopped later.
export class ComputerBuild {
  constructor({
    file = '/var/lib/stellarcortex/desktops/provisioning/build.json',
    run = spawn,
    bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    alive = pid => fs.existsSync('/proc/' + pid),
    computer = () => null,
    domainState = uuid =>
      execFileSync('/usr/bin/virsh', ['--connect', 'qemu:///system', 'domstate', uuid], {
        encoding: 'utf8',
        timeout: 10000,
        env: ENV,
      }).trim(),
  } = {}) {
    Object.assign(this, { file, run, bootId, alive, computer, domainState });
    this.pending = false;
    this.starting = false;
    this.startFailed = false;
  }
  status() {
    if (this.starting) return { state: 'starting' };
    if (this.pending)
      return { state: 'building', stage: 'download', step: 1, steps: STEPS.length, percent: null };
    let build;
    try {
      build = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'not-started' };
      throw error;
    }
    if (build.stage === 'ready') return this.running();
    if (build.stage === 'failed')
      return { state: 'failed', code: build.code || 'other', message: build.message || null };
    if (build.bootId !== this.bootId() || !this.alive(build.pid))
      return { state: 'failed', code: 'interrupted', message: null };
    return {
      state: 'building',
      stage: build.stage,
      step: STEPS.indexOf(build.stage) + 1,
      steps: STEPS.length,
      percent: build.percent ?? null,
    };
  }
  running() {
    const record = this.computer();
    if (!record?.uuid) return { state: 'ready' };
    let state = null;
    try {
      state = this.domainState(record.uuid);
    } catch {
      // libvirt not answering means the computer cannot be used either.
    }
    if (state === 'running') return { state: 'ready' };
    return { state: 'stopped', ...(this.startFailed ? { code: 'start-failed' } : {}) };
  }
  start() {
    this.starting = true;
    this.startFailed = false;
    const done = ok => {
      this.starting = false;
      this.startFailed = !ok;
    };
    const child = this.run(
      '/usr/bin/systemctl',
      ['start', 'stellarcortex-computer-start.service'],
      {
        stdio: 'ignore',
        env: ENV,
      },
    );
    child.once('error', () => done(false));
    child.once('exit', code => done(code === 0));
    return this.status();
  }
  retry() {
    const state = this.status();
    if (state.state === 'stopped') return this.start();
    if (!['failed', 'not-started'].includes(state.state)) return state;
    this.pending = true;
    const child = this.run(
      '/usr/bin/systemctl',
      ['start', '--no-block', 'stellarcortex-computer-build@retry.service'],
      { stdio: 'ignore', env: ENV },
    );
    // The service writes its own state within moments. Until then this says it has started.
    const clear = () =>
      setTimeout(() => {
        this.pending = false;
      }, 5000).unref();
    child.once('error', clear);
    child.once('exit', clear);
    return this.status();
  }
}
