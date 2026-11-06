import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  // Where the app opens it, so the install can print the tailscale serve command.
  if (settings.STELLARCORTEX_TAILNET_UI_URL)
    settings.STELLARCORTEX_UI_SOCKET = path.join(data, 'tailscale-ui.sock');
  return { ...settings, data, port: settings.PORT || '4317' };
}
// The app refuses every request with any other form, so this stops a typing mistake before it is kept.
export function validTailnetUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
// This machine's name on the tailnet, when Tailscale runs here. The owner pastes it into a shell.
export function tailnetName(run = spawnSync) {
  try {
    const { stdout } = run('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 }),
      name = JSON.parse(stdout).Self.DNSName.replace(/\.$/, '');
    return /^[a-z0-9.-]+$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}
export const tailnetSteps = (name, folder = root) =>
  (name
    ? '\nTailscale is running here. To open StellarCortex from your own devices, run this.'
    : '\nTo open StellarCortex from your own devices, set up Tailscale as in steps 4 and 5 of "On a VPS" in README.md, then run this.') +
  ` It restarts the service and prints the last step:\n\n  cd ${JSON.stringify(folder)}\n  STELLARCORTEX_TAILNET_UI_URL=https://${name || 'your-machine.your-tailnet.ts.net'}/ bash install.sh --service`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux')
    throw new Error('This helper is for Linux systemd user services');
  const settings = installedSettings(),
    folder = unitFolder(),
    conf = confFile();
  if (
    settings.STELLARCORTEX_TAILNET_UI_URL &&
    !validTailnetUrl(settings.STELLARCORTEX_TAILNET_UI_URL)
  ) {
    console.error(
      'STELLARCORTEX_TAILNET_UI_URL must look like https://your-machine.your-tailnet.ts.net/ and nothing was changed.',
    );
    process.exit(1);
  }
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'stellarcortex.service'), serviceUnit());
  if (SETTINGS.some(key => settings[key])) {
    fs.mkdirSync(path.dirname(conf), { recursive: true });
    fs.writeFileSync(conf, settingsConf(settings));
  }
  console.log('Wrote stellarcortex.service');
}
