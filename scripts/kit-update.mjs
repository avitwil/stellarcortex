// The root step of an update. Runs as root from root-owned files, and trusts only its own pinned keys, never the app user.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { keepNewest } from '../src/keep-newest.mjs';
import { logProcessOutput } from '../src/process-output.mjs';
import {
  compareVersions,
  downloadRelease,
  fetchRelease,
  parsePinnedKeys,
  readPinnedKeys,
  validVersion,
} from '../src/signed-releases.mjs';

const PROTOCOL = 1;
const STEP_FAILED = 'The update step on the host failed. Details are in the server log.';
// The status file reaches the Updates tab, so it keeps a fixed message or a line the owner can act on.
export function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let tail = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => {
        tail = (tail + chunk).slice(-400);
      });
    child.once('error', error => {
      logProcessOutput(path.basename(bin), error.message);
      reject(new Error(STEP_FAILED));
    });
    child.once('exit', code => {
      if (code === 0) return resolve();
      logProcessOutput(path.basename(bin), tail);
      const busy = /A computer is being prepared\..*/.exec(tail);
      reject(new Error(busy ? busy[0] : STEP_FAILED));
    });
  });
}
export async function runKitUpdate({
  version,
  root = '/var/lib/stellarcortex',
  etc = '/etc/stellarcortex',
  fetchImpl = fetch,
  exec = run,
  clock = Date.now,
}) {
  const folder = path.join(root, 'kit-update'),
    startedAt = new Date(clock()).toISOString(),
    statusFile = path.join(folder, 'status.json');
  fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
  const write = (state, extra = {}) => {
    const temp = statusFile + '.tmp',
      value = { state, version, startedAt, ...extra };
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o644 });
    fs.renameSync(temp, statusFile);
    return value;
  };
  write('running');
  const name = `next-${randomUUID()}`,
    next = path.join(folder, name),
    archive = next + '.tar.gz';
  try {
    if (!validVersion(version)) throw new Error('Invalid update version');
    const versionFile = path.join(etc, 'kit-version'),
      installed = fs.readFileSync(versionFile, 'utf8').trim();
    if (compareVersions(version, installed) <= 0) return write('done');
    const settings = JSON.parse(fs.readFileSync(path.join(etc, 'kit-update.json'), 'utf8')),
      keysFile = path.join(etc, 'update-keys.json'),
      keys = parsePinnedKeys(fs.readFileSync(keysFile, 'utf8'));
    const entry = await fetchRelease({ version, fetchImpl, keys });
    if (entry.updateProtocol !== PROTOCOL)
      throw new Error(
        'This release is not compatible with the installed update supervisor. Update the supervisor manually.',
      );
    fs.mkdirSync(next, { mode: 0o700 });
    await downloadRelease({ entry, file: archive, fetchImpl });
    await exec(
      'tar',
      ['-xzf', name + '.tar.gz', '-C', name, '--strip-components=1', '--no-same-owner'],
      folder,
    );
    await exec('chmod', ['-R', 'go-w', name], folder);
    const pkg = JSON.parse(fs.readFileSync(path.join(next, 'package.json'), 'utf8'));
    if (pkg.name !== 'stellarcortex' || pkg.version !== version)
      throw new Error('The release does not hold the version it was signed for.');
    if (!readPinnedKeys(next).length)
      throw new Error('The release pins no key, so it could never update again.');
    const bundle = path.join(root, `bundle-${version}-${clock()}`);
    await exec(
      'python3',
      [
        '-I',
        '-B',
        path.join(next, 'deployment/ubuntu-desktop/host-setup.py'),
        '--source',
        next,
        '--output',
        bundle,
        '--app-uid',
        String(settings.appUid),
        '--app-service',
        settings.appService,
      ],
      root,
    );
    // This script restores the previous version by itself if it fails.
    await exec(
      path.join(bundle, 'upgrade-approved.sh'),
      [
        fs.readFileSync(path.join(bundle, 'APPROVAL-SHA256'), 'utf8').trim(),
        ...(settings.flag ? [settings.flag] : []),
      ],
      bundle,
    );
    fs.copyFileSync(path.join(next, 'update-keys.json'), keysFile);
    // Atomic: a half-written version would stop every later update.
    fs.writeFileSync(versionFile + '.tmp', version + '\n');
    fs.renameSync(versionFile + '.tmp', versionFile);
    const kit = path.join(root, 'kit');
    fs.rmSync(kit, { recursive: true, force: true });
    fs.renameSync(next, kit);
    keepNewest(root, 2, { match: item => item.startsWith('bundle-') });
    keepNewest(path.join(root, 'desktops/backups'), 3);
    return write('done');
  } catch (error) {
    fs.rmSync(next, { recursive: true, force: true });
    return write('failed', { error: error.message });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runKitUpdate({ version: process.argv[2] }).then(result => {
    if (result.state === 'failed') {
      console.error(result.error);
      process.exitCode = 1;
    }
  });
