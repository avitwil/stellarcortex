import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectionUrl, metadataHost, privateAddress, publicUrl } from '../src/browser.mjs';
import { HttpProvider } from '../src/http-provider.mjs';
import { McpConnections } from '../src/mcp-connections.mjs';
import { normalizeBaseUrl } from '../src/provider-connections.mjs';

const resolves = (t, ...addresses) =>
  t.mock.method(dns, 'lookup', async () =>
    addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-url-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const metadataUrls = [
  'http://169.254.169.254/v1',
  'http://169.254.170.2/v1',
  'http://[::ffff:169.254.169.254]/v1',
  'http://[::ffff:a9fe:a9fe]/v1',
  'http://[0:0:0:0:0:ffff:a9fe:a9fe]/v1',
  'http://[::ffff:0:a9fe:a9fe]/v1',
  'http://[::a9fe:a9fe]/v1',
  'http://[64:ff9b::a9fe:a9fe]/v1',
  'http://[2002:a9fe:a9fe::]/v1',
  'http://169.254.169.254./v1',
  'http://2852039166/v1',
  'http://0xa9.0xfe.0xa9.0xfe/v1',
  'http://metadata.google.internal/v1',
  'http://metadata.google.internal./v1',
  'http://METADATA.GOOGLE.INTERNAL./v1',
  'http://100.100.100.200/v1',
  'http://[::ffff:100.100.100.200]/v1',
  'http://[fd00:ec2::254]/v1',
];
const ownerUrls = [
  'http://127.0.0.1:11434/v1',
  'http://[::1]:8000/v1',
  'http://10.20.30.40:8080/v1',
  'http://172.16.4.2:8080/v1',
  'http://192.168.1.20:8080/v1',
  'http://100.64.0.7:8080/v1',
  'http://100.127.255.1:8080/v1',
  'http://[fd00::7]:8080/v1',
];
function provider(t, name, baseUrl) {
  const requests = [],
    config = {
      enabled: true,
      apiKey: 'test-key',
      engine: 'ollama',
      protocol: 'chat-completions',
      baseUrl,
      defaultModel: 'model-a',
    },
    fetchImpl = async url => {
      requests.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
  const runtime = new HttpProvider({
    provider: name,
    getConfig: () => config,
    dataDir: temp(t),
    fetchImpl,
  });
  t.after(() => runtime.stop());
  return { requests, models: () => runtime.getModels(runtime.config()) };
}
function mcp(t) {
  const requests = [],
    manager = new McpConnections({
      dataDir: temp(t),
      fetchImpl: async url => {
        requests.push(String(url));
        return new Response('{}');
      },
    });
  t.after(() => manager.close());
  return {
    requests,
    call(url) {
      const id = 'guarded',
        session = { id, revision: '1', controller: new AbortController() };
      manager.records[id] = {
        id,
        name: 'Guarded',
        transport: 'streamable-http',
        url,
        authType: 'none',
        revision: '1',
      };
      manager.sessions.set(id, session);
      return manager.network(session, url);
    },
    manager,
  };
}

test('metadata hosts are recognised in every form and refused when saved', t => {
  const manager = new McpConnections({ dataDir: temp(t) });
  for (const value of metadataUrls) {
    assert.equal(metadataHost(new URL(value).hostname), true, value);
    assert.throws(() => normalizeBaseUrl(value), /metadata/, value);
    assert.throws(
      () => manager.validate({ name: 'Blocked', transport: 'streamable-http', url: value }),
      /metadata/,
      value,
    );
  }
  for (const value of ownerUrls) assert.equal(metadataHost(new URL(value).hostname), false, value);
});
test('embedded IPv4 forms count as the address they carry', () => {
  for (const ip of [
    '::7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '::ffff:0:7f00:1',
    '::ffff:127.0.0.1',
    '::1',
    '::',
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '8.8.8.8'])
    assert.equal(privateAddress(ip), false, ip);
});
test('connections reach loopback, LAN and tailnet, and never metadata, including through DNS', async t => {
  for (const value of ownerUrls) assert.equal(await connectionUrl(value), value);
  for (const value of metadataUrls) await assert.rejects(connectionUrl(value), /metadata/, value);
  const lookup = resolves(t, '192.168.1.20');
  assert.equal(await connectionUrl('http://models.local:8080/v1'), 'http://models.local:8080/v1');
  for (const answers of [
    ['169.254.169.254'],
    ['::ffff:169.254.169.254'],
    ['::ffff:a9fe:a9fe'],
    ['64:ff9b::a9fe:a9fe'],
    ['100.100.100.200'],
    ['fd00:ec2::254'],
    ['192.168.1.20', '169.254.169.254'],
  ]) {
    lookup.mock.mockImplementation(async () =>
      answers.map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
    await assert.rejects(connectionUrl('http://rebound.example/v1'), /metadata/, answers.join());
    await assert.rejects(connectionUrl('http://rebound.example./v1'), /metadata/, answers.join());
  }
});
test('custom API providers and the local provider reach owner addresses and are refused metadata before any request', async t => {
  for (const name of ['custom-test', 'local']) {
    for (const baseUrl of ownerUrls) {
      const f = provider(t, name, baseUrl);
      await f.models();
      assert.deepEqual(f.requests, [`${baseUrl}/models`]);
    }
    const lookup = resolves(t, '169.254.169.254'),
      f = provider(t, name, 'http://rebound.example/v1');
    await assert.rejects(f.models(), /metadata/);
    assert.deepEqual(f.requests, []);
    lookup.mock.restore();
  }
});
test('fixed cloud providers skip the lookup because their address is constant', async t => {
  const lookup = resolves(t, '169.254.169.254'),
    f = provider(t, 'openai-api', '');
  await f.models();
  assert.equal(f.requests.length, 1);
  assert.equal(lookup.mock.callCount(), 0);
});
test('MCP HTTP reaches owner addresses and is refused metadata before any request', async t => {
  const f = mcp(t);
  for (const url of ownerUrls) {
    const target = url.replace('/v1', '/mcp');
    await f.call(target);
    assert.equal(f.requests.at(-1), target);
  }
  const before = f.requests.length;
  resolves(t, '169.254.169.254');
  await assert.rejects(f.call('http://rebound.example/mcp'), /metadata/);
  assert.equal(f.requests.length, before);
});
test('the browser still refuses private addresses', async t => {
  for (const value of [
    'http://127.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://10.0.0.8/',
    'http://localhost./',
    'http://printer.local./',
  ])
    await assert.rejects(publicUrl(value), /Private network browsing is disabled/, value);
  resolves(t, '10.0.0.1');
  await assert.rejects(
    publicUrl('http://rebound.example./'),
    /Private network browsing is disabled/,
  );
});
