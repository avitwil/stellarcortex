import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  compareVersions,
  downloadRelease,
  fetchRelease,
  readPinnedKeys,
  validVersion,
} from './signed-releases.mjs';
import { keepNewest } from './keep-newest.mjs';

export const UPDATE_PROTOCOL = 1;
// A wildcard bind has no address of its own, so it is reached through loopback.
export const healthUrl = ({ host, port }) => {
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}/health`;
};
// Null means no address is known to serve the app, so nothing may be opened, least of all with the access key.
export const appOrigin = ({
  publicUrl = process.env.STELLARCORTEX_PUBLIC_URL,
  bind = process.env.STELLARCORTEX_BIND,
  port = process.env.PORT || 4317,
} = {}) => {
  if (publicUrl) return new URL(publicUrl).origin;
  if (bind === '::1') return `http://[::1]:${port}`;
  if (bind === 'localhost') return `http://localhost:${port}`;
  return !bind || ['127.0.0.1', '0.0.0.0', '::'].includes(bind) ? `http://127.0.0.1:${port}` : null;
};
// The Host guard knows loopback names whatever address is bound, so the probe presents one and the guard stays as it is. fetch would replace this header.
export const fetchHealth = ({ host, port, timeoutMs = 5000 }) =>
  new Promise((resolve, reject) => {
    http
      .get(
        healthUrl({ host, port }),
        { headers: { host: `127.0.0.1:${port}` }, signal: AbortSignal.timeout(timeoutMs) },
        response => {
          let body = '';
          response
            .setEncoding('utf8')
            .on('data', chunk => {
              body += chunk;
            })
            .on('error', reject)
            .on('end', () => {
              try {
                resolve(response.statusCode === 200 ? JSON.parse(body) : {});
              } catch (error) {
                reject(error);
              }
            });
        },
      )
      .on('error', reject);
  });
// Beside the data folder: separate from it, and on the same filesystem in the usual case.
export const defaultManagerDir = dataDir => path.resolve(dataDir) + '-updates';
export function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function assertManagedLayout({ root, managerDir, dataDir }) {
  if (process.getuid?.() === 0)
    throw new Error('Managed updates must run as an unprivileged installation owner, never root.');
  for (const value of [root, managerDir, dataDir])
    if (!path.isAbsolute(value))
      throw new Error('Managed installation and data paths must be absolute');
  if (
    inside(root, managerDir) ||
    inside(managerDir, root) ||
    inside(root, dataDir) ||
    inside(dataDir, root) ||
    inside(managerDir, dataDir) ||
    inside(dataDir, managerDir)
  )
    throw new Error('Application, manager and data directories must be separate, non-nested paths');
  fs.accessSync(root, fs.constants.W_OK);
  for (const dir of [managerDir, dataDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== path.resolve(dir))
      throw new Error('Managed paths must not contain symlinks or junctions');
    fs.accessSync(dir, fs.constants.W_OK);
  }
  if (fs.statSync(managerDir).dev !== fs.statSync(dataDir).dev)
    throw new Error(
      'Manager and data directories must share a filesystem for atomic rollback moves',
    );
}
export function atomicJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function run(bin, args, cwd, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'ignore', windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Update preparation timed out. The current release is unchanged.'));
    }, timeout);
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`Cannot run update prerequisite (${error.code || 'execution failed'}).`));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(
              'Update preparation failed. Check npm availability and network access. The current release is unchanged.',
            ),
          );
    });
  });
}
function npmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error('Managed updates require npm installed alongside Node.js.');
  return found;
}
// Everything here runs before the current release is touched, and any refusal leaves it running.
export async function stageRelease(
  managerDir,
  { version, current, keys, fetchImpl = fetch, exec = run, progress = () => {} },
) {
  if (!validVersion(version)) throw new Error('Invalid update version');
  if (compareVersions(version, current.version) <= 0)
    throw new Error('Refusing a version that is not newer than the current one.');
  progress('checking');
  const entry = await fetchRelease({ version, fetchImpl, keys });
  if (entry.updateProtocol !== UPDATE_PROTOCOL)
    throw new Error(
      'This release is not compatible with the installed update supervisor. Update the supervisor manually.',
    );
  const releases = path.join(managerDir, 'releases');
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  // Unique staging directories also make retries safe.
  const name = version + '-' + randomUUID(),
    target = path.join(releases, name),
    archive = target + '.tar.gz';
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    progress('downloading');
    await downloadRelease({ entry, file: archive, fetchImpl });
    // Relative paths: GNU tar reads a drive letter as a remote host.
    await exec(
      'tar',
      ['-xzf', name + '.tar.gz', '-C', name, '--strip-components=1', '--no-same-owner'],
      releases,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    if (pkg.name !== 'stellarcortex' || pkg.version !== version)
      throw new Error('The release does not hold the version it was signed for.');
    if (
      JSON.parse(fs.readFileSync(path.join(target, 'update-protocol.json'), 'utf8')).version !==
      UPDATE_PROTOCOL
    )
      throw new Error(
        'This release is not compatible with the installed update supervisor. Update the supervisor manually.',
      );
    if (!readPinnedKeys(target).length)
      throw new Error('The release pins no key, so it could never update again.');
    progress('installing');
    // Dependency lifecycle scripts are never run by the updater. The signed lockfile
    // pins each package's hash. Provider homes stay outside; no login or model run is used.
    await exec(
      process.execPath,
      [npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'],
      target,
    );
    // npm skips an optional package that fails to download, and Codex's program is one.
    await exec(
      process.execPath,
      ['node_modules/@openai/codex/bin/codex.js', '--version'],
      target,
      30000,
    );
    await exec(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium'], target);
    await exec(process.execPath, ['--check', 'src/server.mjs'], target, 30000);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(archive, { force: true });
  }
  return {
    root: target,
    commit: null,
    version,
    sha256: entry.sha256,
    kitVersion: entry.kitVersion,
  };
}
// Backups hold a full copy of the data, so they do not pile up. Failed ones stay for inspection.
export function pruneUpdates(managerDir, currentRoot) {
  keepNewest(path.join(managerDir, 'releases'), 3, { protect: [currentRoot] });
  keepNewest(path.join(managerDir, 'backups'), 3, {
    match: name => !/^(failed|interrupted)-/.test(name),
  });
}
// The manifest names the last release that changed the root parts, so a host that skipped that release still catches up.
export function kitBehind(kitVersion, file = '/etc/stellarcortex/kit-version') {
  let installed;
  try {
    installed = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return false;
  }
  return compareVersions(kitVersion, installed) > 0;
}
// The root service does the work and restarts the broker on the way, so a failed poll only means try again.
export async function updateKit({
  version,
  broker,
  clock = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 3000000,
}) {
  const before = await broker.kitUpdate(),
    deadline = clock() + timeoutMs;
  await broker.kitUpdate(version);
  while (clock() < deadline) {
    await sleep(2000);
    const status = await broker.kitUpdate().catch(() => null);
    if (
      status?.version !== version ||
      status.startedAt === before.startedAt ||
      status.state === 'running'
    )
      continue;
    if (status.state === 'failed')
      throw new Error(status.error || 'The virtual computer could not be updated.');
    if (status.state === 'done') return status;
  }
  throw new Error('Updating the virtual computer timed out. The app was not switched.');
}
function copyData(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    filter: file => {
      if (fs.lstatSync(file).isSymbolicLink())
        throw new Error(
          'Data backup contains a symlink or junction. Use an administrator-managed backup.',
        );
      return file !== path.join(source, 'server.lock');
    },
  });
}
// stop() must wait until the current child has exited. probe() must keep all
// task execution and HTTP mutations disabled until activate() is called.
export async function updateTransaction({
  managerDir,
  dataDir,
  previous,
  candidate,
  stop,
  probe,
  activate,
  writeState = state => atomicJson(path.join(managerDir, 'current.json'), state),
  backup = copyData,
}) {
  const backups = path.join(managerDir, 'backups');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const backupDir = path.join(backups, randomUUID());
  let backedUp = false,
    candidateStarted = false;
  await stop();
  try {
    backup(dataDir, backupDir);
    backedUp = true;
    // The journal supports conservative recovery after a supervisor interruption.
    atomicJson(path.join(managerDir, 'transaction.json'), {
      previous,
      candidate,
      backupDir,
      phase: 'probing',
    });
    candidateStarted = true;
    await probe(candidate);
    writeState(candidate);
    atomicJson(path.join(managerDir, 'transaction.json'), {
      previous,
      candidate,
      backupDir,
      phase: 'committed',
    });
  } catch (error) {
    if (candidateStarted) await stop();
    if (backedUp) {
      const failed = path.join(backups, 'failed-' + randomUUID());
      // Both paths are verified inside the explicit installation layout. Retain
      // failed data instead of deleting it; restore only while no child runs.
      if (!inside(backups, failed) || !inside(backups, backupDir) || inside(managerDir, dataDir))
        throw new Error('Unsafe rollback path');
      fs.renameSync(dataDir, failed);
      backup(backupDir, dataDir);
    }
    writeState(previous);
    await probe(previous);
    atomicJson(path.join(managerDir, 'transaction.json'), {
      previous,
      candidate,
      backupDir,
      phase: 'rolled-back',
    });
    await activate();
    return {
      status: 'rolled-back',
      error: error.message,
      version: previous.version,
      commit: previous.commit,
    };
  }
  // Never roll back after enabling tasks: they might already have performed work.
  await activate();
  return { status: 'updated', version: candidate.version, commit: candidate.commit };
}

export function managedUpdateClient() {
  if (process.env.STELLARCORTEX_MANAGED_UPDATES !== '1' || typeof process.send !== 'function')
    return null;
  return {
    prepare(version) {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          process.off('message', receive);
          reject(new Error('Update supervisor did not respond. Installation was not activated.'));
        }, 3600000);
        function receive(message) {
          if (message?.type !== 'update-prepared' || message.requestId !== requestId) return;
          clearTimeout(timer);
          process.off('message', receive);
          message.error ? reject(new Error(message.error)) : resolve(message);
        }
        process.on('message', receive);
        process.send({ type: 'prepare-update', requestId, version });
      });
    },
    commit() {
      process.send({ type: 'commit-update' });
    },
  };
}
