import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defaultData } from '../src/server.mjs';
import { appOrigin, fetchHealth, defaultManagerDir } from '../src/managed-updates.mjs';
import { NO_ORIGIN, openApp } from './open.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  dir = path.resolve(defaultData()),
  port = process.env.PORT || 4317;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const host = process.env.STELLARCORTEX_BIND || '127.0.0.1';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// After an update the running release is newer than this folder.
const expected = () => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(defaultManagerDir(dir), 'current.json'), 'utf8'))
        .version || version
    );
  } catch {
    return version;
  }
};
async function healthy() {
  try {
    const b = await fetchHealth({ host, port, timeoutMs: 1500 });
    return b.ok === true && b.version === expected();
  } catch {
    return false;
  }
}
if (!(await healthy())) {
  const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'managed-launch.mjs')], {
    cwd: root,
    env: { ...process.env, STELLARCORTEX_DATA_DIR: dir },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.on('error', e => {
    console.error(e.message);
    process.exitCode = 1;
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(path.join(dir, 'launcher.pid'), String(child.pid), { mode: 0o600 });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await healthy()) {
      ready = true;
      break;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) throw new Error(`Server did not start. Read ${path.join(dir, 'server.log')}`);
}
const origin = appOrigin({ port });
console.log(origin ? `StellarCortex: ${origin}` : NO_ORIGIN);
if (!process.argv.includes('--no-open')) openApp(dir, origin);
