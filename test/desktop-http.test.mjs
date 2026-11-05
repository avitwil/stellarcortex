import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
class Runtime extends EventEmitter {
  ready = false;
  async stop() {}
}
class Desktop {
  enabled = true;
  takeoverBotId = null;
  calls = [];
  async status() {
    return { enabled: this.enabled, available: this.enabled, mode: 'test-desktop' };
  }
  async snapshot(botId) {
    if (!this.enabled) throw new Error('Disabled');
    return { botId, image: 'test', width: 100, height: 100 };
  }
  setTakeover(botId, value) {
    if (!this.enabled) throw new Error('Disabled');
    this.takeoverBotId = value ? botId : null;
  }
  async action(botId, args, manual) {
    if (this.takeoverBotId !== botId) throw new Error('Take control first');
    this.calls.push({ botId, args, manual });
    return { ok: true };
  }
  release() {}
  async close() {}
}
test('desktop HTTP requires a session and manual takeover; deleted bots cannot control it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-desktop-http-')),
    desktop = new Desktop();
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Runtime(),
    desktopRuntime: desktop,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`,
      bot = app.store.data.bots[0];
    bot.computer = 'host';
    assert.equal((await fetch(base + '/api/desktop/status')).status, 401);
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'X-StellarCortex-Client': '1' },
      body: JSON.stringify({ key: app.accessKey }),
    });
    const headers = {
      'X-StellarCortex-Client': '1',
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const request = (url, data, method = 'POST') =>
      fetch(base + url, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    assert.equal((await request('/api/desktop/config', { enabled: true })).status, 400);
    assert.equal(
      (await request(`/api/desktop/${bot.id}/action`, { action: 'key', key: 'Tab' })).status,
      400,
    );
    assert.equal((await request(`/api/desktop/${bot.id}/takeover`, { enabled: true })).status, 200);
    assert.equal(
      (await request(`/api/desktop/${bot.id}/action`, { action: 'key', key: 'Tab' })).status,
      200,
    );
    assert.equal(desktop.calls[0].manual, true);
    assert.equal((await request(`/api/desktop/${bot.id}/action`, undefined, 'GET')).status, 405);
    assert.equal((await request(`/api/bots/${bot.id}`, undefined, 'DELETE')).status, 200);
    assert.ok(app.store.bot(bot.id).deletedAt);
    assert.equal((await request(`/api/desktop/${bot.id}`, undefined, 'GET')).status, 400);
    assert.equal((await request(`/api/bots/${bot.id}/restore`, {})).status, 200);
    assert.equal(app.store.bot(bot.id).deletedAt, undefined);
  } finally {
    await app.close();
    const relative = path.relative(os.tmpdir(), dir);
    if (!relative.startsWith('stellarcortex-desktop-http-') || relative.includes(path.sep))
      throw new Error('Unsafe test cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
