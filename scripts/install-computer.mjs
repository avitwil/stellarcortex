// The computer part of `bash install.sh --service`. A host that cannot have one finishes without it, says why, and the tool works.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installedSettings } from './linux-service.mjs';
export const NEEDS = { memoryMiB: 4096 + 6144, diskGiB: 90 };
const REASONS = {
  platform: 'This is not a 64-bit Intel or AMD Linux host.',
  kvm: 'This host has no KVM (/dev/kvm). Turn on virtualization in the BIOS, or for a VM, nested virtualization.',
  memory: `This host has too little memory. The computer needs ${NEEDS.memoryMiB / 1024} GiB in all.`,
  disk: `Less than ${NEEDS.diskGiB} GiB is free under /var/lib.`,
  apt: 'This host has no apt-get. The computer setup supports Debian and Ubuntu.',
  systemd: 'This host has no systemd.',
  root: 'The root step did not finish. Check that your user can use sudo.',
  node: 'Root cannot find Node.js and npm. Install them for the whole system, not only for your user.',
  firewall: 'The firewall question was not answered with yes, so nothing was changed.',
  failed: 'The root step stopped. Its output is above.',
};
export function computerBlocker({
  platform = process.platform,
  arch = process.arch,
  exists = fs.existsSync,
  memoryMiB = os.totalmem() / 1048576,
  freeGiB,
} = {}) {
  if (platform !== 'linux' || arch !== 'x64') return 'platform';
  if (!exists('/dev/kvm')) return 'kvm';
  if (memoryMiB < NEEDS.memoryMiB) return 'memory';
  if (!exists('/usr/bin/apt-get')) return 'apt';
  if (!exists('/run/systemd/system')) return 'systemd';
  return freeGiB < NEEDS.diskGiB ? 'disk' : null;
}
// The app needs these with or without a computer. Root's kit has no node_modules, so every way through the install runs them from here.
export function hostBasics({ root, user, run = spawnSync, node = process.execPath }) {
  return [
    ['loginctl', 'enable-linger', user],
    [node, path.join(root, 'node_modules/playwright/cli.js'), 'install-deps', 'chromium'],
  ]
    .filter(step => run('sudo', step, { stdio: ['inherit', 'ignore', 'inherit'] }).status !== 0)
    .map(step => 'sudo ' + step.join(' '));
}
export function rootResult(status) {
  return status === 0
    ? null
    : status === 3
      ? 'firewall'
      : status === 4
        ? 'node'
        : status === null || status === 1
          ? 'root'
          : 'failed';
}
function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    { data } = installedSettings(),
    note = path.join(data, 'computer-install.json');
  if (fs.existsSync('/etc/stellarcortex/desktop-broker.json'))
    return console.log('The virtual computer is already installed.');
  const stat = fs.statfsSync(fs.existsSync('/var/lib') ? '/var/lib' : '/'),
    basics = () => {
      const left = hostBasics({ root, user: os.userInfo().username });
      if (left.length) console.log('That did not finish. Run these yourself:\n' + left.join('\n'));
    },
    stop = code => {
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(note, JSON.stringify({ code }), { mode: 0o600 });
      console.log(
        'No virtual computer on this host: ' +
          REASONS[code] +
          '\nStellarCortex works without it: new bots have no computer. Run this command again after fixing that.\nThe app still needs root once, to keep running after you log out and for the browser libraries.',
      );
      basics();
    };
  const blocker = computerBlocker({ freeGiB: (stat.bavail * stat.bsize) / 1073741824 });
  if (blocker) return stop(blocker);
  // The renderer derives the owner identity from the key that the app makes on its first start.
  for (let i = 0; i < 60 && !fs.existsSync(path.join(data, 'access-key')); i++)
    spawnSync('sleep', ['1']);
  console.log('Adding the virtual computer. This one step needs root.');
  const code = rootResult(
    spawnSync(
      'sudo',
      [
        'bash',
        path.join(root, 'deployment/ubuntu-desktop/host-install.sh'),
        root,
        String(process.getuid()),
        'stellarcortex.service',
        os.userInfo().username,
      ],
      { stdio: 'inherit' },
    ).status,
  );
  if (code) return stop(code);
  basics();
  fs.rmSync(note, { force: true });
  spawnSync('systemctl', ['--user', 'restart', 'stellarcortex.service'], { stdio: 'inherit' });
  console.log(
    'The virtual computer is building in the background. You can use the app now, and follow it in Settings > Computer.',
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
