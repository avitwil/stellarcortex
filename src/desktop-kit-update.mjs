import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { validVersion } from './signed-releases.mjs';
// The root step of an update is one root service. The app can only name a version: the service finds, verifies and refuses on its own.
export class KitUpdate {
  constructor({ file = '/var/lib/stellarcortex/kit-update/status.json', run = spawn } = {}) {
    Object.assign(this, { file, run });
  }
  status() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'idle' };
      throw error;
    }
  }
  start(version) {
    if (!validVersion(version)) throw Error('Invalid update version');
    this.run(
      '/usr/bin/systemctl',
      ['start', '--no-block', `stellarcortex-kit-update@${version}.service`],
      { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } },
    ).once('error', () => {});
    return { state: 'started', version };
  }
}
