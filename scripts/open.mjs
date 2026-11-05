import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultData } from '../src/server.mjs';
import { appOrigin } from '../src/managed-updates.mjs';
export const NO_ORIGIN =
  'This listen address has no browser address yet. Set STELLARCORTEX_PUBLIC_URL to the address you open in the browser.';
export function openUrl(url) {
  let bin, args;
  if (process.platform === 'win32') {
    bin = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    bin = 'open';
    args = [url];
  } else {
    bin = 'xdg-open';
    args = [url];
  }
  const p = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () =>
    console.log('Open http://127.0.0.1:4317 and enter the access key from your data directory.'),
  );
  p.unref();
}
export function openApp(dir, origin, open = openUrl) {
  if (!origin) return;
  open(
    `${origin}/#key=${encodeURIComponent(fs.readFileSync(path.join(dir, 'access-key'), 'utf8').trim())}`,
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = appOrigin();
  if (!origin) console.log(NO_ORIGIN);
  openApp(defaultData(), origin);
}
