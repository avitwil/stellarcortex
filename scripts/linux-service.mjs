import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// What `bash install.sh --service` keeps from its own environment, in a drop-in that a later run leaves alone.
const SETTINGS = [
  'STELLARCORTEX_DATA_DIR',
  'STELLARCORTEX_BIND',
  'PORT',
  'STELLARCORTEX_PUBLIC_URL',
  'STELLARCORTEX_TAILNET_UI_URL',
  'STELLARCORTEX_UI_SOCKET',
];
const oneLine = value => {
  if (/[\r\n]/.test(value) || value !== value.trim() || value.endsWith('\\'))
    throw new Error('A systemd setting cannot hold this value: ' + JSON.stringify(value));
  return value;
};
// Each setting has its own syntax. A path setting takes the raw text, so quotes would become part of the path, and spaces need nothing.
const rawPath = value => oneLine(value).replace(/%/g, '%%');
const quoted = value =>
  '"' + oneLine(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
// In ExecStart a later word also expands $, while the program's own path is taken as it is.
const argument = value => quoted(value).replace(/\$/g, '$$$$');
export function serviceUnit({ root: folder = root, node = process.execPath } = {}) {
  return `[Unit]\nDescription=StellarCortex personal AI teammates\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${rawPath(folder)}\nExecStart=${quoted(node)} ${argument(path.posix.join(folder, 'scripts', 'managed-launch.mjs'))}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nLimitCORE=0\n\n[Install]\nWantedBy=default.target\n`;
}
export const settingsConf = settings =>
  '[Service]\n' +
  SETTINGS.filter(key => settings[key])
    .map(key => 'Environment=' + quoted(key + '=' + settings[key]) + '\n')
    .join('');
const parseConf = text =>
  Object.fromEntries(
    [...text.matchAll(/^Environment="(\w+)=(.*)"$/gm)].map(([, key, value]) => [
      key,
      value.replace(/\\(["\\])/g, '$1').replace(/%%/g, '%'),
    ]),
  );
const unitFolder = (home = os.homedir()) => path.join(home, '.config', 'systemd', 'user');
const confFile = home => path.join(unitFolder(home), 'stellarcortex.service.d', 'install.conf');
// This run's environment over what an earlier run kept, so every step of the install sees what the service will.
export function installedSettings({ env = process.env, home = os.homedir() } = {}) {
  const file = confFile(home),
    kept = fs.existsSync(file) ? parseConf(fs.readFileSync(file, 'utf8')) : {},
    settings = {
      ...kept,
      ...Object.fromEntries(SETTINGS.filter(key => env[key]).map(key => [key, env[key]])),
    };
  const data = settings.STELLARCORTEX_DATA_DIR || path.join(home, '.stellarcortex');
  // The app takes this socket only at this one place, so a tailnet link needs no second setting.
  if (settings.STELLARCORTEX_TAILNET_UI_URL)
    settings.STELLARCORTEX_UI_SOCKET = path.join(data, 'tailscale-ui.sock');
  return { ...settings, data, port: settings.PORT || '4317' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux')
    throw new Error('This helper is for Linux systemd user services');
  const settings = installedSettings(),
    folder = unitFolder(),
    conf = confFile();
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'stellarcortex.service'), serviceUnit());
  if (SETTINGS.some(key => settings[key])) {
    fs.mkdirSync(path.dirname(conf), { recursive: true });
    fs.writeFileSync(conf, settingsConf(settings));
  }
  console.log('Wrote stellarcortex.service');
}
