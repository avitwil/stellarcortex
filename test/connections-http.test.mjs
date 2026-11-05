import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';

class Runtime extends EventEmitter {
  async stop() {}
  async request() {
    throw new Error('No model calls expected');
  }
}
class GoogleStub extends EventEmitter {
  status() {
    return {
      configured: true,
      connected: !!this.connected,
      hasClientSecret: true,
      services: ['drive'],
      readOnly: true,
      revision: 'google-1',
    };
  }
  configure() {
    return this.status();
  }
  async startAuth({ owner, redirectUri }) {
    this.flow = { owner, redirectUri, state: 'test-google-state' };
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${this.flow.state}`,
    };
  }
  async completeAuth(input, { owner }) {
    assert(this.flow);
    assert.equal(owner, this.flow.owner);
    assert.equal(input.state, this.flow.state);
    assert.equal(input.code, 'test-code');
    this.flow = null;
    this.connected = true;
    return this.status();
  }
  disconnect() {
    this.connected = false;
    return this.status();
  }
  listTools() {
    return { tools: [], revision: 'google-1' };
  }
}
async function fixture(t, options = {}) {
  const root = path.resolve('.test-data');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'connections-http-'));
  const google = options.googleService || new GoogleStub();
  const app = await createApp({
    dataDir: dir,
    port: 0,
    startEngine: false,
    runtime: new Runtime(),
    claudeRuntime: new Runtime(),
    googleService: google,
    ...options,
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
  return { app, google, base, headers, api, sessionCookie: login.headers.get('set-cookie') };
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
  for (const route of ['/api/connections', '/api/mcp/connections', '/api/google/status'])
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

test('Google OAuth callback is browser bound without weakening the Strict application session', async t => {
  const f = await fixture(t);
  const started = await f.api('/api/google/connect', {});
  assert.match(started.data.authorizationUrl, /^https:\/\/accounts.google.com\//);
  const oauthCookie = started.headers.getSetCookie()[0];
  assert.match(oauthCookie, /HttpOnly; SameSite=Lax; Path=\/api\/google; Max-Age=600/);
  assert(!oauthCookie.includes('stellarcortex_session='));
  assert.match(f.sessionCookie, /SameSite=Strict/);
  assert.equal(f.google.flow.redirectUri, f.base + '/api/google/oauth/callback');
  const callback = f.base + '/api/google/oauth/callback?state=test-google-state&code=test-code';
  assert.equal((await fetch(callback, { redirect: 'manual' })).status, 400);
  const wrong = await fetch(callback, {
    headers: { Cookie: `stellarcortex_google_oauth=${'b'.repeat(64)}` },
    redirect: 'manual',
  });
  assert.equal(wrong.status, 303);
  assert.match(wrong.headers.get('location'), /result=error/);
  assert.equal(f.google.connected, undefined);
  const result = await fetch(callback, {
    headers: { Cookie: oauthCookie.split(';')[0] },
    redirect: 'manual',
  });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/?connections=google&result=connected');
  assert.equal(f.google.connected, true);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await f.api('/api/google/status')).data.connected, true);
  const replay = await fetch(callback, {
    headers: { Cookie: oauthCookie.split(';')[0] },
    redirect: 'manual',
  });
  assert.match(replay.headers.get('location'), /result=error/);
  assert.equal(
    (
      await fetch(f.base + '/api/google/connect', {
        method: 'POST',
        headers: { 'X-StellarCortex-Client': '1' },
        body: '{}',
      })
    ).status,
    401,
  );
});

test('OAuth owner cookies are reused by subsequent Connect requests and preserve pending MCP sign-ins', async t => {
  class McpStub extends EventEmitter {
    flows = new Map();
    owners = [];
    getPublic(id) {
      return { id, name: id, connected: false, revision: 'one', status: 'disconnected' };
    }
    list() {
      return { connections: ['first', 'second'].map(id => this.getPublic(id)) };
    }
    async connect(id, { owner }) {
      this.owners.push(owner);
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
  assert.equal(cookieFor(mcpCookie, '/api/google/connect'), '');
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
  const googleFirst = await f.api('/api/google/connect', {}),
    googleOwner = f.google.flow.owner,
    googleCookie = googleFirst.headers.getSetCookie()[0];
  const googleConnectCookie = cookieFor(googleCookie, '/api/google/connect');
  assert.ok(googleConnectCookie);
  assert.equal(cookieFor(googleCookie, '/api/mcp/connections/first/connect'), '');
  f.headers.Cookie = `${sessionCookie}; ${googleConnectCookie}`;
  const googleSecond = await f.api('/api/google/connect', {});
  assert.equal(googleSecond.headers.getSetCookie()[0].split(';')[0], googleConnectCookie);
  assert.equal(f.google.flow.owner, googleOwner);
  assert.match(f.sessionCookie, /SameSite=Strict/);
});
