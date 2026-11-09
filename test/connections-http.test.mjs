import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { McpSecretStore } from '../src/mcp-secret-store.mjs';
import {
  removeGoogleConnection,
  revokeGoogleToken,
  revokeRemovedGoogle,
} from '../src/google-removal.mjs';

class Runtime extends EventEmitter {
  async stop() {}
  async request() {
    throw new Error('No model calls expected');
  }
}
class McpStub extends EventEmitter {
  flows = new Map();
  owners = [];
  getPublic(id) {
    return { id, name: id, connected: false, revision: 'one', status: 'disconnected' };
  }
  list() {
    return { connections: ['first', 'second'].map(id => this.getPublic(id)) };
  }
  async connect(id, { owner, redirectUri }) {
    this.owners.push(owner);
    this.redirectUri = redirectUri;
    this.flows.set(id, owner);
    return {
      connection: this.getPublic(id),
      authorizationUrl: `https://oauth.example.test/authorize?state=${id}`,
    };
  }
  async completeAuth({ state, code }, { owner }) {
    assert.equal(this.flows.get(state), owner);
    assert.equal(code, 'test-code');
    this.flows.delete(state);
    return { id: state, connected: true };
  }
  async close() {}
}
async function fixture(t, options = {}) {
  const root = path.resolve('.test-data');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'connections-http-'));
  const { prepare, ...appOptions } = options;
  prepare?.(dir);
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Runtime(),
    claudeRuntime: new Runtime(),
    ...appOptions,
  });
  t.after(async () => {
    await app.close();
    if (path.dirname(path.resolve(dir)) !== root) throw new Error('Invalid test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`;
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers: { 'X-StellarCortex-Client': '1' },
    body: JSON.stringify({ key: app.accessKey }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0],
    headers = { Cookie: cookie, 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' };
  const api = async (route, data, method = data ? 'POST' : 'GET') => {
    const response = await fetch(base + route, {
      method,
      headers,
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  return { app, dir, base, headers, api, sessionCookie: login.headers.get('set-cookie') };
}
async function mcpEndpoint(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let input = '';
    for await (const part of req) input += part;
    const message = JSON.parse(input);
    requests.push({ message, authorization: req.headers.authorization });
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'independent-fixture', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'echo',
                  description: 'Return input',
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: message.params.arguments.text }] }
            : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        message.method === 'server/discover'
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Legacy protocol' } }
          : { jsonrpc: '2.0', id: message.id, result },
      ),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests };
}

test('independent MCP routes protect secrets and expose real SDK tools to the shared Engine after approval', async t => {
  const remote = await mcpEndpoint(t),
    f = await fixture(t),
    secret = 'independent-test-secret';
  for (const route of ['/api/connections', '/api/mcp/connections'])
    assert.equal((await fetch(f.base + route)).status, 401);
  assert.equal(
    (
      await fetch(f.base + '/api/mcp/connections', {
        method: 'POST',
        headers: { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const created = await f.api('/api/mcp/connections', {
    name: 'Independent tools',
    url: remote.url,
    authType: 'bearer',
    token: secret,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.connected, false);
  assert.equal(remote.requests.length, 0);
  const id = created.data.id,
    connected = await f.api(`/api/mcp/connections/${id}/connect`, {});
  assert.equal(connected.data.connection.connected, true);
  const catalog = await f.api(`/api/mcp/connections/${id}/tools`);
  assert.equal(catalog.data.tools[0].name, 'echo');
  for (const route of ['/api/connections', '/api/mcp/connections', '/api/state', '/api/export'])
    assert.equal(JSON.stringify((await f.api(route)).data).includes(secret), false);
  const bot = f.app.store.data.bots[0],
    chat = f.app.store.data.chats.find(c => c.botIds.includes(bot.id)),
    job = {
      id: 'independent-job',
      botId: bot.id,
      chatId: chat.id,
      provider: 'local',
      status: 'running',
    };
  f.app.store.data.jobs.push(job);
  const pending = f.app.engine.tool(job, 'stellarcortex_connections', {
    action: 'call',
    connectionId: id,
    toolName: 'echo',
    arguments: { text: 'MCP result through shared Engine' },
  });
  for (let count = 0; count < 100 && !f.app.store.data.approvals.length; count++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const approval = f.app.store.data.approvals.at(-1);
  assert.equal(approval.kind, 'connection');
  assert.equal(approval.details.connectionName, 'Independent tools');
  assert.equal(remote.requests.filter(r => r.message.method === 'tools/call').length, 0);
  await f.api(`/api/approvals/${approval.id}`, { approve: true });
  const content = await pending;
  assert(content.some(c => c.text === 'MCP result through shared Engine'));
  assert.equal(remote.requests.filter(r => r.message.method === 'tools/call').length, 1);
  assert(remote.requests.every(r => r.authorization === `Bearer ${secret}`));
  await f.api(`/api/mcp/connections/${id}/disconnect`, {});
  assert.equal((await f.api(`/api/mcp/connections/${id}/tools`)).status, 400);
  await f.api(`/api/mcp/connections/${id}`, {}, 'DELETE');
  assert.equal((await f.api('/api/mcp/connections')).data.connections.length, 0);
});

test('MCP OAuth callback is browser bound without weakening the Strict application session', async t => {
  const mcp = new McpStub(),
    f = await fixture(t, { mcpService: mcp });
  const started = await f.api('/api/mcp/connections/first/connect', {});
  assert.match(started.data.authorizationUrl, /^https:\/\/oauth.example.test\//);
  const oauthCookie = started.headers.getSetCookie()[0];
  assert.match(oauthCookie, /HttpOnly; SameSite=Lax; Path=\/api\/mcp; Max-Age=600/);
  assert(!oauthCookie.includes('stellarcortex_session='));
  assert.match(f.sessionCookie, /SameSite=Strict/);
  assert.equal(mcp.redirectUri, f.base + '/api/mcp/oauth/callback');
  const callback = f.base + '/api/mcp/oauth/callback?state=first&code=test-code';
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 400);
  const wrong = await fetch(callback, {
    headers: { Cookie: `stellarcortex_mcp_oauth=${'b'.repeat(64)}` },
    redirect: 'manual',
  });
  assert.equal(wrong.status, 303);
  assert.match(wrong.headers.get('location'), /result=error/);
  assert.equal(mcp.flows.size, 1);
  const result = await fetch(callback, {
    headers: { Cookie: oauthCookie.split(';')[0] },
    redirect: 'manual',
  });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/?connections=mcp&result=connected');
  assert.equal(mcp.flows.size, 0);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  const replay = await fetch(callback, {
    headers: { Cookie: oauthCookie.split(';')[0] },
    redirect: 'manual',
  });
  assert.match(replay.headers.get('location'), /result=error/);
  assert.equal(
    (
      await fetch(f.base + '/api/mcp/connections/first/connect', {
        method: 'POST',
        headers: { 'X-StellarCortex-Client': '1' },
        body: '{}',
      })
    ).status,
    401,
  );
});

test('OAuth owner cookies are reused by subsequent Connect requests and preserve pending MCP sign-ins', async t => {
  const mcp = new McpStub(),
    f = await fixture(t, { mcpService: mcp }),
    sessionCookie = f.headers.Cookie;
  // Model browser cookie-path matching rather than manually sending a cookie
  // to an endpoint that its Path would not normally cover.
  const cookieFor = (setCookie, requestPath) => {
    const cookiePath = setCookie.match(/; Path=([^;]+)/)?.[1];
    assert.ok(cookiePath);
    return requestPath === cookiePath || requestPath.startsWith(cookiePath + '/')
      ? setCookie.split(';')[0]
      : '';
  };
  const first = await f.api('/api/mcp/connections/first/connect', {}),
    mcpCookie = first.headers.getSetCookie()[0];
  assert.match(mcpCookie, /HttpOnly; SameSite=Lax; Path=\/api\/mcp; Max-Age=600/);
  assert.ok(
    first.headers
      .getSetCookie()
      .some(value => /Path=\/api\/mcp\/oauth\/callback; Max-Age=0/.test(value)),
  );
  const connectCookie = cookieFor(mcpCookie, '/api/mcp/connections/second/connect');
  assert.ok(connectCookie);
  f.headers.Cookie = `${sessionCookie}; ${connectCookie}`;
  const second = await f.api('/api/mcp/connections/second/connect', {});
  assert.equal(second.headers.getSetCookie()[0].split(';')[0], connectCookie);
  assert.equal(mcp.owners[0], mcp.owners[1]);
  for (const state of ['first', 'second']) {
    const callback = await fetch(`${f.base}/api/mcp/oauth/callback?state=${state}&code=test-code`, {
      headers: { Cookie: cookieFor(second.headers.getSetCookie()[0], '/api/mcp/oauth/callback') },
      redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location'), /result=connected/);
  }
  assert.equal(mcp.flows.size, 0);
  f.headers.Cookie = sessionCookie;
  assert.match(f.sessionCookie, /SameSite=Strict/);
});

const plantGoogle = dir => {
  fs.mkdirSync(path.join(dir, 'private'), { recursive: true });
  for (const name of ['google-connection.enc', 'google-connection.key', 'mcp-connections.key'])
    fs.writeFileSync(path.join(dir, 'private', name), 'saved');
};
test('an upgrade deletes saved Google connector credentials and shows the removal notice once', async t => {
  const revoked = [],
    f = await fixture(t, {
      prepare: plantGoogle,
      googleRevoke: async token => revoked.push(token),
    }),
    file = name => path.join(f.dir, 'private', name);
  assert.equal(fs.existsSync(file('google-connection.enc')), false);
  assert.equal(fs.existsSync(file('google-connection.key')), false);
  assert.equal(fs.existsSync(file('mcp-connections.key')), true);
  const saved = () => JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved().notices, ['google-removed']);
  assert.deepEqual((await f.api('/api/state')).data.notices, ['google-removed']);
  // A reload right after, inside the toast's time, gets no notice: it was marked seen on delivery.
  assert.deepEqual((await f.api('/api/state')).data.notices, []);
  assert.deepEqual(saved().notices, []);
  assert.equal((await f.api('/api/google/status')).status, 404);
  // The planted files cannot be decrypted, so there was no token to revoke.
  assert.deepEqual(revoked, []);
});
const scratch = (t, name) => {
  const root = path.resolve('.test-data');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, name));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir + '-updates', { recursive: true, force: true });
  });
  return dir;
};
test('the Google removal notice is added once per upgrade and not on a fresh install', t => {
  const dir = scratch(t, 'google-removal-'),
    load = () => {
      const store = new Store(dir);
      removeGoogleConnection(store, { managerDirs: [] });
      return store;
    };
  assert.equal(load().data.notices, undefined);
  plantGoogle(dir);
  assert.deepEqual(load().data.notices, ['google-removed']);
  // A stop after the save but before the files were deleted adds no second notice.
  plantGoogle(dir);
  const again = load();
  assert.deepEqual(again.data.notices, ['google-removed']);
  again.data.notices = [];
  again.save();
  assert.deepEqual(load().data.notices, []);
});
test('an upgrade revokes the saved Google token in the background and purges update backups', async t => {
  const backup = name => path.join(name + '-updates', 'backups', 'failed-1', 'private');
  let release;
  const revoked = [],
    f = await fixture(t, {
      prepare(dir) {
        t.after(() => fs.rmSync(dir + '-updates', { recursive: true, force: true }));
        new McpSecretStore(dir, 'google-connection').save({
          version: 1,
          clientSecret: 'client-secret-canary',
          tokens: { refreshToken: 'refresh-canary', accessToken: 'access-canary' },
        });
        fs.mkdirSync(backup(dir), { recursive: true });
        for (const name of [
          'google-connection.enc',
          'google-connection.key',
          'mcp-connections.enc',
        ])
          fs.copyFileSync(
            path.join(dir, 'private', 'google-connection.enc'),
            path.join(backup(dir), name),
          );
      },
      // Never settles: startup must not wait for it.
      googleRevoke: token => {
        revoked.push(token);
        return new Promise(resolve => (release = resolve));
      },
    });
  assert.deepEqual(revoked, ['refresh-canary']);
  assert.deepEqual(fs.readdirSync(backup(f.dir)), ['mcp-connections.enc']);
  // Only the token waits, encrypted, until Google confirms; the client secret is gone.
  assert.deepEqual(
    fs
      .readdirSync(path.join(f.dir, 'private'))
      .filter(n => n.startsWith('google'))
      .sort(),
    ['google-revoke-pending.enc', 'google-revoke-pending.key'],
  );
  release(true);
});
test('a failed revoke is retried at the next start and cleared once Google confirms', async t => {
  const dir = scratch(t, 'google-retry-'),
    pending = path.join(dir, 'private', 'google-revoke-pending.enc'),
    calls = [];
  new McpSecretStore(dir, 'google-connection').save({ tokens: { refreshToken: 'refresh-canary' } });
  removeGoogleConnection(new Store(dir), { managerDirs: [] });
  t.mock.method(console, 'warn', () => {});
  await revokeRemovedGoogle(dir, async token => (calls.push(token), false));
  assert.equal(fs.existsSync(pending), true);
  removeGoogleConnection(new Store(dir), { managerDirs: [] });
  await revokeRemovedGoogle(dir, async token => (calls.push(token), true));
  assert.deepEqual(calls, ['refresh-canary', 'refresh-canary']);
  assert.equal(fs.existsSync(pending), false);
  await revokeRemovedGoogle(dir, async token => (calls.push(token), true));
  assert.equal(calls.length, 2);
});
test('a Google file that cannot be deleted does not stop the start, and the log holds no secret', t => {
  const dir = scratch(t, 'google-stuck-'),
    warnings = [];
  new McpSecretStore(dir, 'google-connection').save({ tokens: { refreshToken: 'refresh-canary' } });
  // A directory in place of the key file makes the delete fail on every platform.
  fs.rmSync(path.join(dir, 'private', 'google-connection.key'));
  fs.mkdirSync(path.join(dir, 'private', 'google-connection.key', 'inner'), { recursive: true });
  t.mock.method(console, 'warn', message => warnings.push(message));
  const store = new Store(dir);
  assert.doesNotThrow(() => removeGoogleConnection(store, { managerDirs: [] }));
  assert.deepEqual(store.data.notices, ['google-removed']);
  assert.equal(fs.existsSync(path.join(dir, 'private', 'google-connection.enc')), false);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /canary|private/);
});
test('Google token revocation posts the token to Google and reports failure or a hang as false', async () => {
  const calls = [];
  assert.equal(
    await revokeGoogleToken('refresh-canary', {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      },
    }),
    true,
  );
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'token=refresh-canary');
  assert.equal(
    await revokeGoogleToken('x', { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    false,
  );
  // Google answers 400 for a token that is already revoked: nothing left to retry.
  assert.equal(
    await revokeGoogleToken('x', { fetchImpl: async () => ({ ok: false, status: 400 }) }),
    true,
  );
  assert.equal(
    await revokeGoogleToken('x', {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    false,
  );
  const hang = (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.equal(await revokeGoogleToken('x', { fetchImpl: hang, timeoutMs: 20 }), false);
});
