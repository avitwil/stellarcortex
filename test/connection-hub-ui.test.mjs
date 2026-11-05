import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nonSecretFields,
  commandArguments,
  oauthAuthorizationUrl,
  selectedServices,
  mcpConnectionDraft,
  mcpConnectionPayload,
  safeMcpConnection,
  safeGoogleStatus,
} from '../public/connection-hub.js';
import { AppsHub } from '../public/apps-hub.js';

test('hub drafts exclude credentials even when a field is accidentally allowlisted', () => {
  const source = {
    name: 'Calendar',
    url: 'https://example.test/mcp',
    clientId: 'public-client',
    clientSecret: 'secret',
    accessToken: 'token',
    apiKey: 'key',
    authorization: 'Bearer key',
    services: ['calendar'],
    nested: { token: 'secret' },
  };
  const draft = nonSecretFields(source, Object.keys(source));
  assert.deepEqual(draft, {
    name: 'Calendar',
    url: 'https://example.test/mcp',
    clientId: 'public-client',
    services: ['calendar'],
  });
  draft.services.push('drive');
  assert.deepEqual(source.services, ['calendar']);
});
test('stdio arguments preserve argument boundaries without shell evaluation', () => {
  assert.deepEqual(commandArguments('--root\nC:\\My Files\n--read-only'), [
    '--root',
    'C:\\My Files',
    '--read-only',
  ]);
  assert.deepEqual(commandArguments('["--name","a b","$(do-not-run)"]'), [
    '--name',
    'a b',
    '$(do-not-run)',
  ]);
  assert.deepEqual(commandArguments(''), []);
  assert.throws(() => commandArguments('[1]'), /arguments-array/);
  assert.throws(() => commandArguments('[broken'), /arguments-json/);
});
test('OAuth navigation permits HTTPS and loopback development URLs only', () => {
  assert.equal(
    oauthAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?state=opaque'),
    'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
  );
  assert.equal(
    oauthAuthorizationUrl('http://127.0.0.1:5000/authorize'),
    'http://127.0.0.1:5000/authorize',
  );
  for (const value of [
    'javascript:alert(1)',
    'file:///private',
    'https://name:secret@example.test/',
    'http://public.example/authorize',
    'not a url',
  ])
    assert.equal(oauthAuthorizationUrl(value), null);
});
test('Google service selection preserves only supported service IDs', () => {
  assert.deepEqual(
    selectedServices(
      ['gmail', 'calendar', 'gmail', 'unknown'],
      [{ id: 'gmail' }, { id: 'calendar' }],
    ),
    ['gmail', 'calendar'],
  );
});
test('MCP public metadata and drafts never cache token, OAuth secret, or environment values', () => {
  const record = {
    id: 'mcp-1',
    name: 'Private',
    transport: 'stdio',
    command: 'server',
    args: ['--stdio'],
    env: { API_KEY: 'secret-env' },
    envKeys: ['API_KEY'],
    authType: 'oauth',
    token: 'secret-token',
    oauthClientSecret: 'secret-client',
    accessToken: 'secret-oauth',
    hasToken: true,
    hasClientSecret: true,
    status: 'disconnected',
    enabled: true,
  };
  const draft = mcpConnectionDraft(record),
    safe = safeMcpConnection(record);
  assert.equal(JSON.stringify(draft).includes('secret-'), false);
  assert.equal(JSON.stringify(safe).includes('secret-'), false);
  assert.deepEqual(safe.envKeys, ['API_KEY']);
  assert.equal(safe.hasToken, true);
  assert.equal(safe.status, 'disconnected');
  assert.equal(Object.hasOwn(draft, 'env'), false);
  assert.equal(Object.hasOwn(safe, 'accessToken'), false);
});
test('MCP payload separates transports and preserves blank credentials unless removal is explicit', () => {
  assert.deepEqual(
    mcpConnectionPayload({
      name: 'Web',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      authType: 'bearer',
      token: 'must-not-copy',
    }),
    {
      name: 'Web',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      authType: 'bearer',
    },
  );
  const oauth = mcpConnectionPayload(
    {
      name: 'OAuth',
      url: 'https://example.test/mcp',
      authType: 'oauth',
      oauthClientId: 'public-id',
    },
    { oauthClientSecret: ' private ' },
  );
  assert.equal(oauth.oauthClientSecret, 'private');
  assert.equal(oauth.oauthClientId, 'public-id');
  const stdio = mcpConnectionPayload(
    {
      name: 'Local',
      transport: 'stdio',
      command: 'tool',
      args: ['a b'],
      cwd: '/workspace',
      authType: 'bearer',
    },
    { env: '{"API_KEY":"private"}', removeToken: true, removeClientSecret: true },
  );
  assert.deepEqual(stdio, {
    name: 'Local',
    transport: 'stdio',
    command: 'tool',
    args: ['a b'],
    cwd: '/workspace',
    authType: 'none',
    env: { API_KEY: 'private' },
    removeToken: true,
    removeClientSecret: true,
  });
  assert.deepEqual(mcpConnectionPayload({ transport: 'stdio' }, { env: '{}' }).env, {});
  assert.equal(
    Object.hasOwn(mcpConnectionPayload({ transport: 'stdio' }, { env: '' }), 'env'),
    false,
  );
  assert.throws(
    () => mcpConnectionPayload({ transport: 'stdio' }, { env: '{"KEY":1}' }),
    /environment-object/,
  );
});
test('Google public state retains verified connection state and excludes returned credentials', () => {
  const safe = safeGoogleStatus({
    clientId: 'public-id',
    clientSecret: 'private',
    tokens: { access_token: 'secret' },
    accessToken: 'secret',
    hasClientSecret: true,
    configured: true,
    connected: false,
    services: ['gmail'],
    readOnly: true,
    account: { email: 'me@example.test', token: 'secret' },
  });
  assert.equal(safe.connected, false);
  assert.equal(safe.configured, true);
  assert.equal(safe.hasClientSecret, true);
  assert.equal(safe.clientId, 'public-id');
  assert.deepEqual(safe.account, { email: 'me@example.test' });
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});
test('loading and refreshing the hub never connects saved servers or starts OAuth', async () => {
  const original = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const requests = [],
      hub = new AppsHub({
        api: async (url, data) => {
          requests.push({ url, data });
          return url === '/api/mcp/connections'
            ? {
                connections: [
                  {
                    id: 'mcp-1',
                    name: 'Saved',
                    enabled: true,
                    status: 'disconnected',
                    hasToken: true,
                  },
                ],
              }
            : { configured: true, connected: false, clientId: 'public', services: ['gmail'] };
        },
        tr: (_, en) => en,
        icon: () => '',
        isVisible: () => false,
        toast() {},
        modal() {},
      });
    await hub.load();
    await hub.load();
    assert.equal(requests.length, 4);
    assert.equal(
      requests.every(request => request.data === undefined),
      true,
    );
    assert.equal(hub.connections[0].status, 'disconnected');
    assert.equal(hub.google.connected, false);
    assert.equal(hub.authorization.size, 0);
    hub.mcpStale = true;
    assert.match(
      hub.serverCard({ id: 'mcp-1', name: 'Saved', status: 'connected' }),
      /Status unavailable/,
    );
    assert.equal(
      hub.serverCard({ id: 'mcp-1', name: 'Saved', status: 'connected' }).includes('View tools'),
      false,
    );
  } finally {
    globalThis.window = original;
  }
});
test('explicit MCP connect retains a safe OAuth link but does not invent a connected state', async () => {
  const original = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const requests = [],
      record = { id: 'mcp-1', name: 'OAuth', authType: 'oauth', status: 'authorization-required' },
      popup = {
        closed: false,
        location: { href: '' },
        close() {
          this.closed = true;
        },
      };
    const hub = new AppsHub({
      api: async (url, data) => {
        requests.push({ url, data });
        if (url.endsWith('/connect'))
          return {
            connection: record,
            authorizationUrl: 'https://auth.example.test/authorize?state=opaque',
          };
        return url === '/api/mcp/connections'
          ? { connections: [record] }
          : { configured: false, connected: false };
      },
      tr: (_, en) => en,
      icon: () => '',
      isVisible: () => false,
      toast() {},
      modal() {},
    });
    await hub.connectServer(record, popup);
    assert.equal(requests.filter(request => request.url.endsWith('/connect')).length, 1);
    assert.equal(hub.connections[0].status, 'authorization-required');
    assert.equal(hub.authorization.has(record.id), true);
    assert.equal(popup.location.href, 'https://auth.example.test/authorize?state=opaque');
  } finally {
    globalThis.window = original;
  }
});
