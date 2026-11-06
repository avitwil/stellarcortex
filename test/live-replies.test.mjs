import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';

class FakeCodex extends EventEmitter {
  ready = true;
  threads = 0;
  turns = 0;
  async start() {}
  async request(method, p) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.threads}` } };
    if (method === 'thread/resume') return { thread: { id: p.threadId } };
    if (method !== 'turn/start') return {};
    const turnId = `turn-${++this.turns}`,
      delta = JSON.stringify(p.input)
        .match(/ping-\d+/)[0]
        .replace('ping', 'pong');
    // Late enough that the page's own refresh after sending cannot show it.
    setTimeout(() => {
      this.emit('notification', {
        method: 'item/agentMessage/delta',
        params: { threadId: p.threadId, itemId: turnId, delta },
      });
      this.emit('notification', {
        method: 'turn/completed',
        params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } },
      });
    }, 500);
    return { turn: { id: turnId } };
  }
  stop() {}
  respond() {}
}

// Streams like a reverse proxy, and answers 502 itself while the app is down.
async function streamingProxy(t, target) {
  const proxy = http.createServer((req, res) => {
    if (proxy.refuse) {
      res.writeHead(proxy.refuse, { 'Content-Type': 'application/json' });
      return res.end('{"error":"refused"}');
    }
    const host = `127.0.0.1:${target()}`,
      upstream = http.request(
        {
          host: '127.0.0.1',
          port: target(),
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            host,
            ...(req.headers.origin ? { origin: `http://${host}` } : {}),
          },
        },
        answer => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
          answer.on('error', () => res.destroy());
        },
      );
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  return proxy;
}

async function launchBrowser(t) {
  try {
    return await chromium
      .launch({ channel: 'chrome', headless: true })
      .catch(() => chromium.launch({ headless: true }));
  } catch {
    t.skip('No browser is installed');
    return null;
  }
}

const liveTest = (name, run) =>
  test(name, { timeout: 60000 }, async t => {
    const browser = await launchBrowser(t);
    if (!browser) return;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-live-')),
      start = port =>
        createApp({
          dataDir,
          port,
          startEngine: true,
          runtime: new FakeCodex(),
          claudeRuntime: new FakeCodex(),
        }),
      live = { app: await start(0) };
    const port = live.app.port;
    live.restart = async () => {
      live.app = await start(port);
    };
    live.proxy = await streamingProxy(t, () => port);
    live.direct = `http://127.0.0.1:${port}`;
    live.proxied = `http://127.0.0.1:${live.proxy.address().port}`;
    live.open = async origin => {
      const page = await (await browser.newContext()).newPage();
      await page.addInitScript(() => {
        const Native = window.EventSource;
        window.streams = [];
        window.EventSource = class extends Native {
          constructor(...args) {
            super(...args);
            window.streams.push(this);
          }
        };
      });
      await page.goto(`${origin}/#key=${live.app.accessKey}`);
      await page.locator('.bot-row[data-chat]').first().click();
      return page;
    };
    t.after(async () => {
      await browser.close();
      await live.app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    await run(live);
  });

async function sendAndSeeReply(page, number) {
  await page.locator('#prompt').fill(`ping-${number}`);
  await page.locator('#send').click();
  await page.getByText(`pong-${number}`).first().waitFor({ timeout: 15000 });
}

liveTest('a reply appears by itself, directly and through a proxy', async live => {
  await sendAndSeeReply(await live.open(live.direct), 1);
  await sendAndSeeReply(await live.open(live.proxied), 2);
});

liveTest(
  'a page left open through an app restart behind a proxy still gets replies',
  async live => {
    const page = await live.open(live.proxied);
    await sendAndSeeReply(page, 1);
    await live.app.close();
    await page.waitForFunction(() => window.streams.at(-1).readyState === 2, null, {
      timeout: 15000,
    });
    await live.restart();
    await sendAndSeeReply(page, 2);
    await page.waitForFunction(() => window.streams.at(-1).readyState === 1, null, {
      timeout: 15000,
    });
    assert.equal(await page.locator('#runtime-notice').isVisible(), false);
    await sendAndSeeReply(page, 3);
  },
);

liveTest(
  'a page left open through an app restart without a proxy still gets replies',
  async live => {
    const page = await live.open(live.direct);
    await sendAndSeeReply(page, 1);
    await live.app.close();
    await page.locator('#runtime-notice').waitFor({ timeout: 15000 });
    await live.restart();
    await sendAndSeeReply(page, 2);
  },
);

liveTest('an ended session goes to login and stops reopening the stream', async live => {
  const page = await live.open(live.proxied);
  await page.waitForFunction(() => window.streams.at(-1).readyState === 1);
  live.proxy.refuse = 401;
  live.proxy.closeAllConnections();
  await page.locator('#login').waitFor({ timeout: 15000 });
  const opened = await page.evaluate(() => window.streams.length);
  await page.waitForTimeout(4000);
  assert.equal(await page.evaluate(() => window.streams.length), opened);
});
