import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { logProcessOutput } from './process-output.mjs';
// Chromium CDP stays on inherited pipes. The adapter exposes only an owner-only
// Unix socket, never a TCP debugging listener or a browser credential endpoint.
export async function launchPrivateBrowser(
  chromium,
  { executablePath, profile, runtime, headless = false, spawnBrowser = spawn },
) {
  const stat = fs.lstatSync(runtime);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error('Private owned browser runtime directory required');
  const dir = fs.mkdtempSync(path.join(runtime, 'scx-cdp-'));
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'browser.sock');
  const child = spawnBrowser(
    executablePath,
    [
      '--remote-debugging-pipe',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      ...(headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  const server = http.createServer(),
    wss = new WebSocketServer({ server, maxPayload: 32 * 1024 * 1024 });
  let client = null,
    buffer = Buffer.alloc(0),
    exited = false,
    closed = false,
    diagnostic = '';
  child.stderr.on('data', b => {
    diagnostic = (diagnostic + b.toString()).slice(-1500);
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    client?.terminate();
    wss.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  child.once('exit', () => {
    exited = true;
    cleanup();
  });
  child.once('error', cleanup);
  child.stdio[3].on('error', () => {});
  child.stdio[4].on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 32 * 1024 * 1024) {
      child.kill('SIGTERM');
      return;
    }
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (client?.readyState === 1) client.send(frame.toString());
    }
  });
  wss.on('connection', ws => {
    if (client) {
      ws.close(1008, 'One browser owner');
      return;
    }
    client = ws;
    ws.on('message', data => {
      if (!exited) child.stdio[3].write(Buffer.concat([Buffer.from(data), Buffer.from([0])]));
    });
    ws.on('error', () => {});
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    fs.chmodSync(socket, 0o600);
    if (exited) {
      logProcessOutput('Owned Chromium', diagnostic);
      throw Error('Owned Chromium exited before attachment. Details are in the server log.');
    }
    browser = await chromium.connectOverCDP('ws+unix://' + socket + ':/', {
      noDefaults: true,
      isLocal: true,
      timeout: 20000,
    });
  } catch (error) {
    if (!exited) child.kill('SIGTERM');
    cleanup();
    throw error;
  }
  const context = browser.contexts()[0];
  if (!context) throw Error('Owned browser has no default context');
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    if (!exited) {
      const done = once(child, 'exit');
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch {}
      await Promise.race([done, new Promise(r => setTimeout(r, 5000))]);
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([done, new Promise(r => setTimeout(r, 3000))]);
      }
    }
    await browser.close().catch(() => {});
    cleanup();
  };
  context.close = close;
  return context;
}
