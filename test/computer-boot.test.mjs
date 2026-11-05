import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { bootPolicy } from '../src/desktop-boot-policy.mjs';
import {
  createDesktopBrokerServer,
  createDesktopBrokerClient,
} from '../src/desktop-broker-server.mjs';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
import { mountComputerBoot } from '../public/computer-settings.js';

class Offline extends EventEmitter {
  ready = false;
  async start() {}
  stop() {}
  async request() {
    return { account: null, data: [] };
  }
}
test('the setting starts from the install value, and a choice persists alone in its own file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-boot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'boot-policy.json'),
    policy = bootPolicy(file, () => true);
  assert.deepEqual(policy(), { enabled: true });
  assert.deepEqual(policy(false), { enabled: false });
  assert.deepEqual(policy(), { enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: false });
  assert.deepEqual(fs.readdirSync(dir), ['boot-policy.json']);
  assert.throws(() => policy('yes'), /on or off/);
  assert.deepEqual(policy(), { enabled: false });
});
test(
  'the broker accepts this one flag and nothing else',
  { skip: process.platform === 'win32' },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-boot-socket-')),
      socket = path.join(dir, 'broker.sock');
    let value = true;
    const server = createDesktopBrokerServer({
      broker: {
        bootPolicy: enabled => {
          if (enabled !== undefined) value = enabled;
          return { enabled: value };
        },
      },
    });
    await new Promise(resolve => server.listen(socket, resolve));
    t.after(() => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const client = createDesktopBrokerClient(socket);
    assert.deepEqual(await client.bootPolicy(), { enabled: true });
    assert.deepEqual(await client.bootPolicy(false), { enabled: false });
  },
);
test('only the signed-in owner can read or change it, and only this one value', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-boot-http-')),
    calls = [],
    provider = {
      enabled: true,
      broker: {
        bootPolicy: async enabled => {
          calls.push(enabled);
          return { enabled: enabled ?? true };
        },
      },
      coordinator: new DesktopSessionCoordinator({ releaseInputs: async () => {} }),
      lookup: () => null,
      connectConsole: () => {
        throw Error('unused');
      },
    };
  const app = await createApp({
    dataDir: dir,
    port: 0,
    host: '127.0.0.1',
    startEngine: false,
    runtime: new Offline(),
    claudeRuntime: new Offline(),
    desktopProvider: provider,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`,
    url = base + '/api/computer-boot',
    client = { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' };
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { method: 'PATCH', headers: client, body: '{"enabled":false}' })).status,
    401,
  );
  assert.deepEqual(calls, []);
  const headers = {
    ...client,
    Cookie: (
      await fetch(base + '/api/session', {
        method: 'POST',
        headers: client,
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0],
  };
  assert.equal(
    (
      await fetch(url, {
        method: 'PATCH',
        headers: { Cookie: headers.Cookie },
        body: '{"enabled":false}',
      })
    ).status,
    403,
  );
  assert.deepEqual(await (await fetch(url, { headers })).json(), {
    available: true,
    enabled: true,
  });
  assert.deepEqual(
    await (await fetch(url, { method: 'PATCH', headers, body: '{"enabled":false}' })).json(),
    { available: true, enabled: false },
  );
  for (const body of ['{"enabled":"no"}', '{"enabled":false,"bootApproved":true}', '{}'])
    assert.equal((await fetch(url, { method: 'PATCH', headers, body })).status, 400, body);
  assert.deepEqual(calls, [undefined, false]);
});
test('no engine tool or bot path reaches this setting', async () => {
  for (const name of ['engine.mjs', 'kanban.mjs', 'connection-hub.mjs'])
    assert.equal(
      fs.existsSync(new URL(`../src/${name}`, import.meta.url)) &&
        fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8').includes('bootPolicy'),
      false,
      name,
    );
});
test('both states show how to start the computer, and a failed save keeps the old value', async () => {
  const node = {
    hidden: true,
    isConnected: true,
    innerHTML: '',
    querySelector(selector) {
      return selector === '#computer-boot' ? this.box : this.note;
    },
    box: {},
    note: { textContent: '' },
  };
  const en = (_he, english) => english;
  let answer = { available: true, enabled: false };
  mountComputerBoot(node, { api: async () => answer, tr: en });
  await new Promise(setImmediate);
  assert.equal(node.hidden, false);
  assert.match(node.innerHTML, /press Start above/);
  assert.doesNotMatch(node.innerHTML, /checked/);
  answer = { available: true, enabled: true };
  mountComputerBoot(node, { api: async () => answer, tr: en });
  await new Promise(setImmediate);
  assert.match(node.innerHTML, /press Start above/);
  assert.match(node.innerHTML, /checked/);
  mountComputerBoot(node, {
    api: async (_url, body) => {
      if (body) throw Error('Broker is down');
      return answer;
    },
    tr: en,
  });
  await new Promise(setImmediate);
  node.box.checked = false;
  await node.box.onchange();
  assert.equal(node.box.checked, true);
  assert.equal(node.note.textContent, 'Broker is down');
  answer = { available: false };
  mountComputerBoot(node, { api: async () => answer, tr: en });
  await new Promise(setImmediate);
  assert.equal(node.hidden, true);
});
test('Settings says the switch does not start a computer that is off now', () => {
  const node = {
      hidden: true,
      isConnected: true,
      innerHTML: '',
      querySelector(selector) {
        return selector === '#computer-boot' ? {} : { textContent: '' };
      },
    },
    api = async () => ({ available: true, enabled: true });
  return import('../public/computer-settings.js').then(async ({ mountComputerBoot }) => {
    mountComputerBoot(node, { api, tr: (_he, en) => en });
    await new Promise(resolve => setTimeout(resolve));
    assert.match(node.innerHTML, /from the next reboot.*does not start.*press Start above/s);
  });
});
