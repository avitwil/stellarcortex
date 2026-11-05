// The last thing an install prints: one link that opens the app already signed in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedSettings } from './linux-service.mjs';
const {
    data,
    port,
    STELLARCORTEX_TAILNET_UI_URL: tailnet,
    STELLARCORTEX_PUBLIC_URL: publicUrl,
    STELLARCORTEX_UI_SOCKET: socket,
  } = installedSettings(),
  file = path.join(data, 'access-key'),
  base = (tailnet || publicUrl || `http://127.0.0.1:${port}`).replace(/\/$/, '');
for (let i = 0; i < 300 && !fs.existsSync(file); i++)
  await new Promise(resolve => setTimeout(resolve, 100));
if (!fs.existsSync(file)) console.log(`\nOpen ${base} when the service has started.`);
else {
  // A redirected install goes to a log file, so the link with the key goes only to the terminal.
  let terminal = null;
  try {
    terminal = fs.openSync('/dev/tty', 'w');
  } catch {}
  if (terminal === null)
    console.log(
      `\nStellarCortex is ready at ${base}. Its access key is in ${file}. It is not shown here, because this output is not a terminal and may be a log.`,
    );
  else {
    fs.writeSync(
      terminal,
      `\nStellarCortex is ready. This link opens it signed in, so keep it private:\n\n  ${base}/#key=${encodeURIComponent(fs.readFileSync(file, 'utf8').trim())}\n`,
    );
    fs.closeSync(terminal);
  }
  if (tailnet)
    console.log(
      `\nTo serve it on your tailnet, run this once, and again if the data folder moves:\n\n  sudo tailscale serve --bg --https=443 unix:${socket}`,
    );
  else if (!publicUrl)
    console.log(
      `\nOn a remote server, first run this on your own computer: ssh -N -L ${port}:127.0.0.1:${port} ${os.userInfo().username}@this-server`,
    );
}
