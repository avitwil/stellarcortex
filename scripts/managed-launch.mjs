// Supervisor for a user-owned installation, and what the service runs. No elevation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { acquireLock } from '../src/lock.mjs';
import { installedSoftware } from '../src/software-updates.mjs';
import { defaultData } from '../src/server.mjs';
import { readPinnedKeys, validVersion } from '../src/signed-releases.mjs';
import {
  assertManagedLayout,
  atomicJson,
  defaultManagerDir,
  fetchHealth,
  inside,
  kitBehind,
  pruneUpdates,
  stageRelease,
  updateKit,
  updateTransaction,
  UPDATE_PROTOCOL,
} from '../src/managed-updates.mjs';
import { createDesktopBrokerClient } from '../src/desktop-broker-server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2),
  options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--manager-dir', '--data-dir'].includes(argv[i]) || !argv[i + 1])
    throw new Error(
      'Usage: node scripts/managed-launch.mjs --manager-dir <absolute external directory> --data-dir <absolute existing data directory>',
    );
  options[argv[i]] = argv[i + 1];
}
const service = !argv.length,
  dataDir = options['--data-dir'] || (service ? path.resolve(defaultData()) : null),
  managerDir = options['--manager-dir'] || (service ? defaultManagerDir(dataDir) : null);
if (!managerDir || !dataDir)
  throw new Error(
    'Both --manager-dir and --data-dir are required. Stop the existing server before starting the supervisor.',
  );
// The app must start even where it cannot update itself, so the service falls back to the plain server.
try {
  assertManagedLayout({ root, managerDir, dataDir });
} catch (error) {
  if (!service) throw error;
  console.error('Updates from Settings are off: ' + error.message);
  process.exit(
    spawnSync(process.execPath, [path.join(root, 'src/server.mjs')], { stdio: 'inherit' }).status ??
      1,
  );
}
const unlock = acquireLock(managerDir),
  stateFile = path.join(managerDir, 'current.json'),
  journalFile = path.join(managerDir, 'transaction.json'),
  resultFile = path.join(managerDir, 'last-update.json');
const initial = { root, ...installedSoftware(root) };
let current = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : initial,
  child = null,
  busy = false,
  prepared = null,
  stopping = false;
function validateRelease(value) {
  if (
    !validVersion(value?.version) ||
    (value.root !== root && !inside(path.join(managerDir, 'releases'), value.root))
  )
    throw new Error('Invalid managed release pointer');
  return value;
}
// A hand update of this folder changes what it holds.
if (current.root === root) current = initial;
validateRelease(current);
function assertDataStopped() {
  const file = path.join(dataDir, 'server.lock');
  if (!fs.existsSync(file)) return;
  const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(owner.pid) || owner.pid < 1)
    throw new Error('Invalid data lock; inspect the existing installation');
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  throw new Error(
    'Another server still owns the data directory. Stop it before launching managed updates.',
  );
}
assertDataStopped();
// A crash during the probe must never run a half-migrated data directory.
if (fs.existsSync(journalFile)) {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  if (journal.phase === 'probing') {
    validateRelease(journal.previous);
    if (
      !inside(path.join(managerDir, 'backups'), journal.backupDir) ||
      !fs.existsSync(journal.backupDir)
    )
      throw new Error('Interrupted update requires manual backup recovery');
    const retained = path.join(managerDir, 'backups', 'interrupted-' + Date.now());
    fs.renameSync(dataDir, retained);
    fs.cpSync(journal.backupDir, dataDir, { recursive: true, errorOnExist: true, force: false });
    current = journal.previous;
    atomicJson(stateFile, current);
    atomicJson(journalFile, { ...journal, phase: 'rolled-back' });
    atomicJson(resultFile, {
      status: 'rolled-back',
      error: 'Recovered an interrupted update before enabling tasks.',
      version: current.version,
    });
  }
}
async function stop() {
  const target = child;
  if (!target || target.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The application did not stop. No files were switched.')),
      30000,
    );
    target.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    target.send({ type: 'shutdown' });
  });
  child = null;
}
async function probe(release) {
  validateRelease(release);
  const env = {
    ...process.env,
    STELLARCORTEX_DATA_DIR: dataDir,
    STELLARCORTEX_MANAGER_DIR: managerDir,
    STELLARCORTEX_MANAGED_UPDATES: '1',
    STELLARCORTEX_UPDATE_BOOT: '1',
    STELLARCORTEX_MANAGED_UPDATE_RESULT: fs.existsSync(resultFile)
      ? fs.readFileSync(resultFile, 'utf8')
      : '',
  };
  // No shell or server-supplied command. The pinned release is the program.
  child = fork(path.join(release.root, 'src/server.mjs'), [], {
    cwd: release.root,
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  const target = child;
  target.on(
    'message',
    message =>
      void receive(target, message).catch(error => console.error('Managed update:', error.message)),
  );
  target.once('exit', () => {
    if (child === target && !busy && !stopping) {
      console.error('Managed application exited. Restart the supervisor to recover.');
      process.exitCode = 1;
      unlock();
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('New release readiness check timed out'));
    }, 30000);
    const onMessage = message => {
      if (message?.type === 'managed-ready') {
        cleanup();
        resolve(message);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('New release failed before readiness'));
    };
    function cleanup() {
      clearTimeout(timer);
      target.off('message', onMessage);
      target.off('exit', onExit);
    }
    target.on('message', onMessage);
    target.once('exit', onExit);
    target.once('error', error => {
      cleanup();
      reject(error);
    });
  });
  if (
    ready.protocol !== UPDATE_PROTOCOL ||
    ready.commit !== release.commit ||
    ready.version !== release.version
  )
    throw new Error('Release identity or update protocol health check failed');
  const health = await fetchHealth(ready);
  if (health.ok !== true || health.version !== release.version)
    throw new Error('Release HTTP health check failed');
}
async function activate() {
  if (!child?.connected)
    throw new Error('The healthy release exited before activation. Restart the supervisor.');
  child.send({ type: 'activate' });
}
async function receive(sender, message) {
  if (sender !== child || stopping) return;
  if (message?.type === 'prepare-update') {
    if (busy || prepared) {
      sender.send({
        type: 'update-prepared',
        requestId: message.requestId,
        error: 'An update is already in progress.',
      });
      return;
    }
    busy = true;
    try {
      if (installedSoftware(current.root).modified)
        throw new Error('Local source changes must be preserved before updating');
      // The release running now holds the keys, so a rotation shipped in it counts.
      const progress = stage => {
        if (sender.connected) sender.send({ type: 'update-progress', stage });
      };
      const candidate = await stageRelease(managerDir, {
        version: message.version,
        current,
        keys: readPinnedKeys(current.root),
        progress,
      });
      // Before the app switches, so a refusal here leaves everything as it was. A host with no computer has nothing to do.
      if (kitBehind(candidate.kitVersion)) {
        progress('system');
        await updateKit({
          version: message.version,
          broker: createDesktopBrokerClient('/run/stellarcortex-desktop-broker/broker.sock'),
        });
      }
      prepared = { candidate, expires: Date.now() + 60000 };
      sender.send({ type: 'update-prepared', requestId: message.requestId });
      setTimeout(() => {
        if (prepared && Date.now() > prepared.expires) {
          prepared = null;
          busy = false;
        }
      }, 61000).unref();
    } catch (error) {
      busy = false;
      sender.send({ type: 'update-prepared', requestId: message.requestId, error: error.message });
    }
  } else if (message?.type === 'commit-update') {
    if (!prepared || prepared.expires < Date.now()) return;
    const candidate = prepared.candidate,
      from = current.version;
    prepared = null;
    if (sender.connected) sender.send({ type: 'update-progress', stage: 'restarting' });
    try {
      const result = await updateTransaction({
        managerDir,
        dataDir,
        previous: current,
        candidate,
        stop,
        probe,
        activate,
      });
      current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const finished = {
        ...result,
        from,
        to: candidate.version,
        finishedAt: new Date().toISOString(),
      };
      atomicJson(resultFile, finished);
      if (result.status === 'updated') pruneUpdates(managerDir, candidate.root);
      if (child?.connected) child.send({ type: 'update-result', result: finished });
      console.log(`Managed update: ${result.status} (${result.version})`);
    } catch (error) {
      const result = { status: 'recovery-required', error: error.message };
      atomicJson(resultFile, result);
      if (child?.connected) child.send({ type: 'update-result', result });
      console.error('Update requires recovery:', error.message);
    } finally {
      busy = false;
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    stop()
      .then(() => {
        unlock();
        process.exit(0);
      })
      .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
  });
try {
  busy = true;
  await probe(current);
  atomicJson(stateFile, current);
  await activate();
  busy = false;
  console.log('Managed StellarCortex is running. Keep this supervisor running.');
} catch (error) {
  stopping = true;
  await stop().catch(() => {});
  unlock();
  throw error;
}
