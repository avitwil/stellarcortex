import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.env.STELLARCORTEX_DESKTOP_MODE !== 'virtual')
  process.exit(0);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  desktop = path.join(os.homedir(), 'Desktop'),
  apps = path.join(os.homedir(), '.local', 'share', 'applications');
const quoted = value =>
  '"' +
  String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('`', '\\`')
    .replaceAll('$', '\\$') +
  '"';
if (!process.argv.includes('--install-system')) {
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(apps, { recursive: true });
}
const entries = [
  [
    'stellarcortex-browser',
    'StellarCortex Browser',
    `${quoted(process.execPath)} ${quoted(path.join(root, 'scripts', 'browser-desktop.mjs'))}`,
    'web-browser',
  ],
  ['stellarcortex-terminal', 'Terminal', 'xterm', 'utilities-terminal'],
  ['stellarcortex-files', 'Files', 'pcmanfm', 'system-file-manager'],
  ['stellarcortex-editor', 'Text editor', 'mousepad', 'accessories-text-editor'],
];
const systemApps = '/usr/local/share/applications';
const installSystem = process.argv.includes('--install-system');
if (installSystem) {
  if (process.getuid() !== 0)
    throw Error('System launcher installation requires deployment privilege');
  fs.mkdirSync(systemApps, { recursive: true });
}
for (const [name, title, command, icon] of entries) {
  const content = `[Desktop Entry]\nType=Application\nName=${title}\nExec=${command}\nIcon=${icon}\nTerminal=false\nCategories=Utility;\n`;
  if (installSystem) {
    fs.writeFileSync(path.join(systemApps, `${name}.desktop`), content, { mode: 0o644 });
    continue;
  }
  fs.writeFileSync(path.join(apps, `${name}.desktop`), content, { mode: 0o644 });
  const installed = path.join(systemApps, `${name}.desktop`);
  if (fs.existsSync(installed) && fs.statSync(installed).uid === 0) {
    fs.writeFileSync(
      path.join(desktop, `${name}.desktop`),
      `[Desktop Entry]\nType=Link\nName=${title}\nURL=file://${installed}\nIcon=${icon}\n`,
      { mode: 0o644 },
    );
  } else fs.writeFileSync(path.join(desktop, `${name}.desktop`), content, { mode: 0o700 });
}
