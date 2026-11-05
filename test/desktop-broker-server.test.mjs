import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDesktopBrokerServer,
  createDesktopBrokerClient,
} from '../src/desktop-broker-server.mjs';
test('protected broker protocol exposes fixed operations and validates scope before adapters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scx-broker-')),
    socket = join(dir, 'broker.sock');
  let calls = 0;
  const broker = {
    status: async scope => {
      calls++;
      return { scope, state: 'running' };
    },
    capture: async () => ({ image: 'test', mimeType: 'image/png' }),
  };
  const server = createDesktopBrokerServer({ broker });
  await new Promise(resolve => server.listen(socket, resolve));
  const client = createDesktopBrokerClient(socket),
    scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'one' };
  try {
    assert.equal((await client.status(scope)).state, 'running');
    assert.equal(calls, 1);
    await assert.rejects(client.status({ ...scope, vmId: '../../host' }), /scope/i);
    assert.equal(calls, 1);
    assert.equal((await client.capture(scope)).image, 'test');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
test('release closes only controller console transports before confirmed key cleanup', async () => {
  const { default: net } = await import('node:net');
  const dir = await mkdtemp(join(tmpdir(), 'scx-broker-release-')),
    socket = join(dir, 'broker.sock'),
    rfbPath = join(dir, 'rfb.sock'),
    links = [];
  let released = 0;
  const rfb = net.createServer(s => s.write('RFB 003.008\n'));
  await new Promise(resolve => rfb.listen(rfbPath, resolve));
  const broker = {
    checked: async () => ({ domain: 'scx-desktop-01' }),
    status: async () => ({ state: 'running' }),
    release: async () => {
      assert.equal(links[0].destroyed, false);
      assert.equal(links[1].destroyed, true);
      released++;
      return { released: true };
    },
  };
  const server = createDesktopBrokerServer({
    broker,
    connect: () => {
      const socket = net.createConnection(rfbPath);
      links.push(socket);
      return socket;
    },
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const client = createDesktopBrokerClient(socket),
    scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'one' };
  let viewer, controller;
  try {
    viewer = await client.connectConsole(scope);
    viewer.resume();
    controller = await client.connectConsole(scope, { mode: 'control' });
    controller.resume();
    assert.deepEqual(await client.release({ scope, requestId: 'release-fixture' }), {
      released: true,
    });
    assert.equal(released, 1);
  } finally {
    viewer?.destroy();
    controller?.destroy();
    links.forEach(s => s.destroy());
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => rfb.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
