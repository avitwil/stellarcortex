// Installed application launcher: ask the one session-owned browser to reopen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserSocket, browserRequest } from '../src/visible-browser.mjs';
if (process.platform !== 'linux' || process.getuid() === 0 || !process.env.DISPLAY)
  throw Error('Existing guest desktop session required');
const sid = process.env.STELLARCORTEX_SESSION_ID;
if (sid && !/^desktop-[a-f0-9]{20}$/.test(sid)) throw Error('Invalid session identity');
const file = sid ? '/etc/stellarcortex/sessions/' + sid + '.json' : '/etc/stellarcortex/guest.json',
  stat = fs.lstatSync(file);
if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
  throw Error('Trusted browser registration required');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
if (sid) {
  if (config.uid !== process.getuid() || config.sessionId !== sid)
    throw Error('Browser session owner mismatch');
  config.botIds = [config.botId];
}
if (config.provider !== 'qemu-kvm-ubuntu-desktop' || config.botIds?.length !== 1)
  throw Error('Registered guest browser required');
await browserRequest(
  browserSocket(path.join(os.homedir(), '.local/share/stellarcortex'), config.botIds[0]),
  { method: 'show' },
);
