import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { launchPrivateBrowser } from '../src/private-browser.mjs';
import { BrowserWorkspace, browserTarget, refusePasswordSaving } from '../src/browser.mjs';
import { browserSocket, browserRequest } from '../src/visible-browser.mjs';
import { BrowserSession, focusedBrowserPage } from '../src/browser-session.mjs';
import { prepareGuestSocket } from '../src/guest-worker.mjs';

if (
  process.platform !== 'linux' ||
  process.env.STELLARCORTEX_DESKTOP_MODE !== 'virtual' ||
  !process.env.DISPLAY
)
  throw Error('A private desktop session is required');
const data = path.resolve(
  process.env.STELLARCORTEX_DATA_DIR || path.join(os.homedir(), '.stellarcortex'),
);
const botId = process.env.STELLARCORTEX_BOT_DESKTOP_ID,
  socketPath = browserSocket(data, botId);
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
if (fs.existsSync(socketPath)) {
  try {
    await browserRequest(socketPath, { method: 'show' });
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
    await prepareGuestSocket(socketPath);
  }
}
const profile = process.env.STELLARCORTEX_DESKTOP_BROWSER_PROFILE_ROOT
  ? path.join(process.env.STELLARCORTEX_DESKTOP_BROWSER_PROFILE_ROOT, botId)
  : path.join(data, 'desktop-browsers', botId);
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
refusePasswordSaving(profile);
let active = null;
const stateDir = path.join(data, 'desktop-browser-state', botId);
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const session = new BrowserSession(path.join(stateDir, 'session.json'));
const browser = new BrowserWorkspace(stateDir, {
  contextFactory: async () => {
    const context = await launchPrivateBrowser(chromium, {
      executablePath:
        process.env.STELLARCORTEX_DESKTOP_BROWSER_EXECUTABLE || chromium.executablePath(),
      profile,
      runtime: process.env.XDG_RUNTIME_DIR,
    });
    const select = page => {
      session.select(page);
      active = page;
      browser.pages.set(botId, page);
      page.on('close', () => {
        if (active === page) {
          active = context.pages().find(p => !p.isClosed()) || null;
          if (active) browser.pages.set(botId, active);
          else browser.pages.delete(botId);
        }
      });
    };
    context.pages().forEach(select);
    context.on('page', select);
    context.on('close', () => {
      active = null;
    });
    return context;
  },
});
// Human tab changes must change the target of subsequent agent commands too.
async function visiblePage() {
  if (!browser.ctx) return null;
  active = await focusedBrowserPage(browser.ctx.pages(), active);
  if (active && !active.isClosed()) {
    browser.pages.set(botId, active);
    session.select(active);
  }
  return active;
}
async function show() {
  await browser.context();
  let page = await visiblePage();
  if (!page || page.isClosed()) page = await browser.page(botId, { restore: false });
  await page.bringToFront();
  return { available: true, url: page.url() };
}
let queue = Promise.resolve();
const server = net.createServer(socket => {
  let input = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) {
      socket.destroy();
      return;
    }
    if (!input.includes('\n')) return;
    socket.pause();
    const work = queue
      .catch(() => {})
      .then(async () => {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (request.method === 'show') return show();
        if (request.method === 'snapshot') {
          await visiblePage();
          return browser.snapshot(botId);
        }
        if (request.method === 'login-status') {
          await visiblePage();
          return browser.loginTarget(botId);
        }
        if (request.method === 'login') {
          await visiblePage();
          return browser.deliverLogin(botId, request.target, request.secret);
        }
        if (request.method !== 'action')
          throw Object.assign(Error('Unsupported browser operation'), {
            rejectedBeforeEffects: true,
          });
        if (request.args?.action === 'open')
          try {
            await browserTarget(request.args.url);
          } catch (error) {
            error.rejectedBeforeEffects = true;
            throw error;
          }
        await visiblePage();
        if (request.args?.action === 'open') await show();
        else if (!active || active.isClosed())
          return {
            available: false,
            url: '',
            title: '',
            text: 'The visible browser is closed. Open it explicitly.',
          };
        return browser.action(botId, request.args, true);
      });
    queue = work;
    work.then(
      result => socket.end(JSON.stringify({ result }) + '\n'),
      error =>
        socket.end(
          JSON.stringify({
            error: error.message,
            rejectedBeforeEffects: error.rejectedBeforeEffects === true,
          }) + '\n',
        ),
    );
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});
fs.chmodSync(socketPath, 0o600);
await session.restore(await browser.context(), browserTarget);
active = session.active || active;
await visiblePage();
const focusTimer = setInterval(() => visiblePage().catch(() => {}), 1000);
focusTimer.unref();
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    clearInterval(focusTimer);
    session.freeze();
    server.close();
    await browser.close();
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
