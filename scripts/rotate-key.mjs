// Replaces the installation access key. Sign-ins end when the server restarts, and the computers stay the owner's.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rotateKey } from '../src/store.mjs';
import { installedSettings } from './linux-service.mjs';

const SERVICE = 'stellarcortex.service';
export function rotate({
  data = installedSettings().data,
  run = spawnSync,
  log = console.log,
} = {}) {
  const file = path.join(data, 'access-key');
  if (!fs.existsSync(file)) throw new Error(`No access key in ${data}. Check the data folder.`);
  rotateKey(data);
  // A leaked key is why this runs, so the new one goes to no output that a log could keep.
  log(`The access key is replaced. The new key is in ${file}, and it is not shown here.`);
  if (run('systemctl', ['--user', 'is-active', '--quiet', SERVICE]).status !== 0)
    return log('Restart the server now. Until it restarts, the old key still works.');
  if (run('systemctl', ['--user', 'restart', SERVICE]).status !== 0)
    throw new Error(`Could not restart ${SERVICE}. Until it restarts, the old key still works.`);
  log('The server restarted. The old key and every sign-in have stopped working.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    rotate();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
