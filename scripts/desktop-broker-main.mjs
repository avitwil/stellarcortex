import { SessionOnboarding } from '../src/desktop-session-onboarding.mjs';
import { bootPolicy } from '../src/desktop-boot-policy.mjs';
import { validateDesktopRegistrations } from '../src/desktop-session-registration.mjs';
import { ComputerBuild } from '../src/desktop-computer-build.mjs';
import { KitUpdate } from '../src/desktop-kit-update.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { LibvirtDesktopBroker } from '../src/desktop-libvirt-broker.mjs';
import { DesktopEffectJournal } from '../src/desktop-effect-journal.mjs';
import { createDesktopBrokerServer } from '../src/desktop-broker-server.mjs';
import { desktopScope } from '../src/desktop-provider-session.mjs';
if (process.getuid?.() !== 0) throw Error('Broker requires its dedicated privileged service');
const configPath = '/etc/stellarcortex/desktop-broker.json',
  stat = fs.statSync(configPath);
if (stat.uid !== 0 || stat.mode & 0o022)
  throw Error('Root-owned non-writable broker configuration required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.approved !== true || !Number.isSafeInteger(config.appUid) || config.appUid < 1)
  throw Error('Explicit broker configuration required');
const records = new Map();
for (const record of validateDesktopRegistrations(config.desktops)) {
  desktopScope(record);
  if (record.domain !== 'scx-desktop-' + record.vmId || !/^[a-f0-9-]{36}$/i.test(record.uuid))
    throw Error('Invalid registered domain');
  const key = record.accountId + '\0' + record.botId;
  if (records.has(key)) throw Error('Duplicate desktop scope');
  records.set(key, Object.freeze(record));
}
const state = '/var/lib/stellarcortex/desktops/broker',
  runtime = '/run/stellarcortex-desktop-broker';
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const captures = path.join(state, 'captures');
fs.mkdirSync(captures, { mode: 0o700, recursive: true });
const reload = () => {
  const st = fs.lstatSync(configPath);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022)
    throw Error('Trusted broker configuration required');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (current.approved !== true || current.appUid !== config.appUid)
    throw Error('Broker ownership changed; controlled restart required');
  for (const record of validateDesktopRegistrations(current.desktops)) {
    desktopScope(record);
    const key = record.accountId + '\0' + record.botId,
      old = records.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(record))
      throw Error('Existing computer allocation changed; controlled migration required');
    if (!old) records.set(key, Object.freeze(record));
  }
  const kept = new Set(current.desktops.map(r => r.accountId + '\0' + r.botId));
  for (const key of records.keys()) if (!kept.has(key)) records.delete(key);
  return current;
};
const broker = new LibvirtDesktopBroker({
  registry: {
    get: (account, bot) => {
      reload();
      return records.get(account + '\0' + bot);
    },
  },
  approved: true,
  effects: new DesktopEffectJournal(path.join(state, 'effects.json')),
  captureDirectory: captures,
});
const build = new ComputerBuild({ computer: () => reload().sessionProvisioning?.computer });
broker.computerBuild = retry => (retry ? build.retry() : build.status());
broker.computerStop = () => build.stop();
const kit = new KitUpdate();
broker.kitUpdate = version => (version === undefined ? kit.status() : kit.start(version));
broker.bootPolicy = bootPolicy(path.join(state, 'boot-policy.json'), () => reload().bootApproved);
const sessions = new SessionOnboarding({ load: reload });
broker.sessionSetup = (account, environment, bot, start) =>
  sessions.ensure(account, environment, bot, start);
broker.sessionRemove = (account, environment, bot) => sessions.remove(account, environment, bot);
const server = createDesktopBrokerServer({ broker }),
  socket = path.join(runtime, 'broker.sock');
// systemd/flock owns the process lock before this stale socket can be removed.
if (fs.existsSync(socket)) {
  if (!fs.lstatSync(socket).isSocket()) throw Error('Unexpected broker path');
  fs.unlinkSync(socket);
}
server.listen(socket, () => {
  fs.chmodSync(socket, 0o600);
  fs.chownSync(socket, config.appUid, 0);
  fs.chmodSync(runtime, 0o711);
  console.log('Registered desktop broker ready');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
