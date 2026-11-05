// Staged worker for a dedicated unprivileged X11 user; never run on the host.
import fs from 'node:fs';
import path from 'node:path';
import { desktopScope, scopeKey } from '../src/desktop-provider-session.mjs';
import { GuestWorker, guestSocketServer, prepareGuestSocket } from '../src/guest-worker.mjs';
import { X11SessionDesktop, x11SessionText } from '../src/x11-session-desktop.mjs';
import { VisibleBrowserWorkspace } from '../src/visible-browser.mjs';
import { guestShell } from '../src/guest-shell.mjs';
if (process.env.STELLARCORTEX_INSIDE_GUEST !== '1' || process.getuid() === 0)
  throw Error('Unprivileged guest session required');
const sessionId = process.env.STELLARCORTEX_SESSION_ID;
if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || '')) throw Error('Registered session ID required');
const file = '/etc/stellarcortex/sessions/' + sessionId + '.json',
  stat = fs.lstatSync(file);
if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
  throw Error('Trusted session configuration required');
const config = JSON.parse(fs.readFileSync(file, 'utf8')),
  scope = desktopScope(config);
if (
  config.uid !== process.getuid() ||
  scope.sessionId !== sessionId ||
  process.env.XDG_RUNTIME_DIR !== '/run/user/' + config.uid
)
  throw Error('Session OS identity mismatch');
const data = path.join(process.env.HOME, '.local/share/stellarcortex'),
  workspace = path.join(data, 'workspace'),
  runtime = path.join(process.env.XDG_RUNTIME_DIR, 'stellarcortex');
for (const dir of [data, workspace, runtime]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const desktop = new X11SessionDesktop(),
  browser = new VisibleBrowserWorkspace(data, desktop),
  worker = new GuestWorker({
    vmId: scope.vmId,
    generation: scope.generation,
    allowedBots: [scope.botId],
    desktop,
    browser,
    workspace,
    runShell: guestShell,
    typeText: x11SessionText,
    ledgerFile: path.join(data, 'effects-ledger.json'),
  });
const dispatch = worker.dispatch.bind(worker);
worker.dispatch = request =>
  request.method === 'desktop.input'
    ? desktop.input(request.args)
    : request.method === 'desktop.releaseInputs'
      ? desktop.releaseInputs()
      : dispatch(request);
const handle = worker.handle.bind(worker);
worker.handle = async request => {
  const reply = { protocol: 'scx-guest-v1', ...scope, requestId: request.requestId };
  try {
    if (scopeKey(request) !== scopeKey(scope) || request.method === 'roster.register')
      throw Error('Request does not belong to this bot session');
    return { ...(await handle(request)), ...reply };
  } catch (error) {
    return { ...reply, error: error.message };
  }
};
const socket = path.join(runtime, 'worker.sock');
await prepareGuestSocket(socket);
const server = await guestSocketServer(worker, socket);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    server.close();
    await worker.close();
    process.exit(0);
  });
