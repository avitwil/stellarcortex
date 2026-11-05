import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { McpConnections } from '../src/mcp-connections.mjs';

const echoTool = {
  name: 'echo',
  description: 'Echo input',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  annotations: { readOnlyHint: true },
};
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};
const response = message =>
  message.method === 'server/discover'
    ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Legacy test server' } }
    : message.method === 'initialize'
      ? {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'test-mcp', version: '1.0' },
          },
        }
      : message.method === 'tools/list'
        ? { jsonrpc: '2.0', id: message.id, result: { tools: [echoTool] } }
        : message.method === 'tools/call'
          ? {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [
                  { type: 'text', text: message.params.arguments.value },
                  { type: 'image', mimeType: 'image/png', data: 'eA==' },
                ],
              },
            }
          : { jsonrpc: '2.0', id: message.id, result: {} };
async function fixture(t, handler) {
  const root = path.resolve('.test-data');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'mcp-manager-')),
    requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: text ? JSON.parse(text) : null,
      };
      requests.push(request);
      await handler(request, res);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const manager = new McpConnections({
    dataDir: dir,
    callbackUrl: `${base}/api/mcp/oauth/callback`,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 3000,
  });
  t.after(async () => {
    await manager.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(dir)) !== root) throw new Error('Unsafe MCP test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { manager, dir, base, requests };
}
function simple(req, res) {
  if (req.method === 'GET') return json(res, 405, {});
  if (!Object.hasOwn(req.body || {}, 'id')) {
    res.writeHead(202);
    res.end();
    return;
  }
  json(res, 200, response(req.body));
}

test('MCP Streamable HTTP uses independent credentials, forwards real tool content and enforces revisions', async t => {
  const f = await fixture(t, simple),
    one = f.manager.create({
      name: 'Remote one',
      url: `${f.base}/mcp`,
      authType: 'bearer',
      token: 'secret-one',
    }),
    two = f.manager.create({
      name: 'Remote two',
      url: `${f.base}/second`,
      authType: 'header',
      headerName: 'X-API-Key',
      token: 'secret-two',
    });
  assert.equal(f.requests.length, 0);
  assert.equal(one.enabled, false);
  assert.equal(one.hasToken, true);
  assert.equal(JSON.stringify(f.manager.list()).includes('secret-one'), false);
  for (const connection of [one, two])
    assert.equal((await f.manager.connect(connection.id)).connection.connected, true);
  const catalog = await f.manager.listTools(one.id);
  assert.equal(catalog.tools[0].name, 'echo');
  const result = await f.manager.callTool(
    one.id,
    'echo',
    { value: 'hello' },
    { expectedRevision: catalog.revision },
  );
  assert.equal(result.content[0].text, 'hello');
  assert.equal(result.content[1].type, 'image');
  assert.ok(
    f.requests.some(req => req.url === '/mcp' && req.headers.authorization === 'Bearer secret-one'),
  );
  assert.ok(
    f.requests.some(req => req.url === '/second' && req.headers['x-api-key'] === 'secret-two'),
  );
  await f.manager.update(one.id, { name: 'Renamed' });
  await assert.rejects(
    f.manager.callTool(one.id, 'echo', { value: 'late' }, { expectedRevision: catalog.revision }),
    /Connect|changed/,
  );
  assert.equal(JSON.stringify(f.manager.list()).includes('secret-two'), false);
  assert.equal(
    fs
      .readFileSync(path.join(f.dir, 'private', 'mcp-connections.enc'), 'utf8')
      .includes('secret-one'),
    false,
  );
  await assert.rejects(f.manager.callTool('missing', 'echo', {}), /Unknown/);
});

test('MCP credentials persist encrypted; explicit disconnect survives restore and URL changes need a key decision', async t => {
  const f = await fixture(t, simple),
    connection = f.manager.create({
      name: 'Persisted',
      url: `${f.base}/mcp`,
      authType: 'bearer',
      token: 'persistent-secret',
    });
  await f.manager.connect(connection.id);
  await f.manager.disconnect(connection.id);
  await assert.rejects(f.manager.update(connection.id, { url: `${f.base}/other` }), /Re-enter/);
  const reloaded = new McpConnections({ dataDir: f.dir, callbackUrl: `${f.base}/callback` });
  t.after(() => reloaded.close());
  assert.equal(reloaded.getPublic(connection.id).enabled, false);
  const before = f.requests.length;
  await reloaded.restore();
  assert.equal(f.requests.length, before);
  assert.equal((await reloaded.connect(connection.id)).connection.connected, true);
  await reloaded.remove(connection.id);
  assert.deepEqual(reloaded.list(), { connections: [] });
});

test('MCP legacy SSE connection uses the official transport and does not forward credentials across origins', async t => {
  let stream;
  const f = await fixture(t, (req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (req.method === 'POST' && req.url === '/messages') {
      res.writeHead(202);
      res.end();
      if (Object.hasOwn(req.body, 'id'))
        stream.write(`event: message\ndata: ${JSON.stringify(response(req.body))}\n\n`);
      return;
    }
    json(res, 404, {});
  });
  const connection = f.manager.create({
    name: 'Legacy',
    transport: 'sse',
    url: `${f.base}/sse`,
    authType: 'header',
    headerName: 'X-Test-Key',
    token: 'sse-secret',
  });
  assert.equal((await f.manager.connect(connection.id)).connection.connected, true);
  assert.equal(
    (await f.manager.call(connection.id, 'echo', { value: 'sse' })).content[0].text,
    'sse',
  );
  assert.ok(f.requests.every(req => req.headers['x-test-key'] === 'sse-secret'));
  await f.manager.disconnect(connection.id);
});

test('MCP stdio starts only on explicit connect and exposes environment names, never values', async t => {
  const f = await fixture(t, simple),
    script = path.join(f.dir, 'server.mjs');
  fs.writeFileSync(
    script,
    `import readline from 'node:readline';const tool=${JSON.stringify(echoTool)};readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'stdio-test',version:'1'}}:m.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:process.env.MCP_TEST_SECRET?'explicit env present':'missing'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
  );
  const connection = f.manager.create({
    name: 'Installed script',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    cwd: f.dir,
    env: { MCP_TEST_SECRET: 'private-env-value' },
  });
  assert.deepEqual(connection.envKeys, ['MCP_TEST_SECRET']);
  assert.equal(JSON.stringify(connection).includes('private-env-value'), false);
  assert.equal(connection.status, 'disconnected');
  assert.equal((await f.manager.connect(connection.id)).connection.connected, true);
  assert.equal(
    (await f.manager.call(connection.id, 'echo', { value: 'x' })).content[0].text,
    'explicit env present',
  );
  await f.manager.disconnect(connection.id);
});

test('MCP tool cancellation reaches the SDK request and never retries the tool action', async t => {
  let called;
  const began = new Promise(resolve => (called = resolve));
  const f = await fixture(t, (req, res) => {
    if (req.body?.method === 'tools/call') {
      called();
      return;
    }
    simple(req, res);
  });
  const connection = f.manager.create({ name: 'Cancellation', url: `${f.base}/mcp` });
  await f.manager.connect(connection.id);
  const controller = new AbortController(),
    pending = f.manager.call(
      connection.id,
      'echo',
      { value: 'wait' },
      { signal: controller.signal },
    );
  await began;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(f.requests.filter(req => req.body?.method === 'tools/call').length, 1);
});

test('MCP concurrent connects share one handshake and late configuration changes invalidate approved schemas', async t => {
  let schemaChanged = false;
  const f = await fixture(t, (req, res) => {
    if (req.body?.method === 'tools/list' && schemaChanged)
      return json(res, 200, {
        jsonrpc: '2.0',
        id: req.body.id,
        result: { tools: [{ ...echoTool, description: 'A changed action' }] },
      });
    simple(req, res);
  });
  const c = f.manager.create({ name: 'Concurrent', url: `${f.base}/mcp` });
  const results = await Promise.all([f.manager.connect(c.id), f.manager.connect(c.id)]);
  assert.ok(results.every(result => result.connection.connected));
  assert.equal(f.requests.filter(req => req.body?.method === 'initialize').length, 1);
  const catalog = await f.manager.tools(c.id);
  schemaChanged = true;
  await assert.rejects(
    f.manager.call(
      c.id,
      'echo',
      { value: 'should not execute' },
      { expectedRevision: catalog.revision },
    ),
    /changed after approval/,
  );
  assert.equal(f.requests.filter(req => req.body?.method === 'tools/call').length, 0);
});

test('MCP results cannot echo stored authentication secrets into bot context', async t => {
  const secret = 'server-only-secret-value',
    f = await fixture(t, (req, res) => {
      if (req.body?.method === 'tools/call')
        return json(res, 200, {
          jsonrpc: '2.0',
          id: req.body.id,
          result: {
            content: [{ type: 'text', text: `echoed ${secret}` }],
            structuredContent: { value: secret },
          },
        });
      simple(req, res);
    });
  const c = f.manager.create({
    name: 'Redaction',
    url: `${f.base}/mcp`,
    authType: 'bearer',
    token: secret,
  });
  await f.manager.connect(c.id);
  const result = await f.manager.call(c.id, 'echo', { value: 'request' });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.structuredContent.value, '[redacted]');
  assert.throws(
    () =>
      f.manager.create({
        name: 'No install',
        transport: 'stdio',
        command: 'npx',
        args: ['some-uninstalled-package'],
      }),
    /does not install/,
  );
});

test('MCP failures redact manual tokens and reject redirect credentials', async t => {
  const f = await fixture(t, (req, res) =>
      json(res, 500, { message: `Never expose ${req.headers.authorization}` }),
    ),
    connection = f.manager.create({
      name: 'Failed',
      url: `${f.base}/mcp`,
      authType: 'bearer',
      token: 'do-not-expose-this',
    });
  await assert.rejects(
    f.manager.connect(connection.id),
    error => !error.message.includes('do-not-expose-this'),
  );
  assert.equal(JSON.stringify(f.manager.list()).includes('do-not-expose-this'), false);
  assert.throws(
    () => f.manager.create({ name: 'Bad URL', url: 'https://user:password@example.test/mcp' }),
    /credentials/,
  );
  assert.throws(
    () =>
      f.manager.create({ name: 'Bad OAuth', url: 'http://example.test/mcp', authType: 'oauth' }),
    /HTTPS/,
  );
});

test('MCP OAuth uses discovery, PKCE, browser-bound single-use state and encrypted tokens', async t => {
  let base,
    challenge,
    tokenCalls = 0,
    registrations = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read'],
      });
    if (req.url.startsWith('/.well-known/oauth-authorization-server'))
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
    if (req.url === '/register') {
      registrations++;
      return json(res, 201, { ...req.body, client_id: 'test-client' });
    }
    if (req.url === '/token') {
      tokenCalls++;
      return json(res, 200, {
        access_token: 'oauth-access-secret',
        refresh_token: 'oauth-refresh-secret',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read',
      });
    }
    if (req.url === '/mcp' && req.headers.authorization !== 'Bearer oauth-access-secret')
      return json(
        res,
        401,
        { error: 'unauthorized' },
        {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        },
      );
    simple(req, res);
  });
  base = f.base;
  // Token requests use form encoding, unlike the JSON MCP requests.
  const originalFetch = f.manager.fetchImpl;
  f.manager.fetchImpl = async (input, init) => {
    if (String(input).endsWith('/token')) {
      const fields = new URLSearchParams(init.body);
      assert.equal(fields.get('code'), 'good-code');
      assert.equal(
        createHash('sha256').update(fields.get('code_verifier')).digest('base64url'),
        challenge,
      );
      return new Response(
        JSON.stringify({
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };
  const connection = f.manager.create({
    name: 'OAuth service',
    url: `${base}/mcp`,
    authType: 'oauth',
    oauthScope: 'read',
  });
  let started = await f.manager.connect(connection.id, {
    owner: 'browser-one',
    redirectUri: `${base}/api/mcp/oauth/callback`,
  });
  assert.equal(started.connection.status, 'authorization-required');
  assert.ok(started.authorizationUrl);
  let auth = new URL(started.authorizationUrl);
  challenge = auth.searchParams.get('code_challenge');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('state'), started.state);
  assert.ok(challenge);
  assert.equal(registrations, 1);
  await assert.rejects(
    f.manager.completeAuth(
      { state: started.state, code: 'good-code', iss: base },
      { owner: 'other-browser' },
    ),
    /state/,
  );
  await assert.rejects(
    f.manager.completeAuth(
      { state: started.state, code: 'good-code', iss: 'https://wrong-issuer.invalid' },
      { owner: 'browser-one' },
    ),
    /issuer/i,
  );
  started = await f.manager.getAuthStart(connection.id, {
    owner: 'browser-one',
    redirectUri: `${base}/api/mcp/oauth/callback`,
  });
  auth = new URL(started.authorizationUrl);
  challenge = auth.searchParams.get('code_challenge');
  const completed = await f.manager.completeAuth(
    { state: started.state, code: 'good-code', iss: base },
    { owner: 'browser-one' },
  );
  assert.equal(completed.connected, true);
  assert.equal(completed.hasToken, true);
  await assert.rejects(
    f.manager.completeAuth(
      { state: started.state, code: 'good-code', iss: base },
      { owner: 'browser-one' },
    ),
    /state/,
  );
  const listed = JSON.stringify(f.manager.list()),
    encrypted = fs.readFileSync(path.join(f.dir, 'private', 'mcp-connections.enc'), 'utf8');
  for (const secret of ['oauth-access-secret', 'oauth-refresh-secret']) {
    assert.equal(listed.includes(secret), false);
    assert.equal(encrypted.includes(secret), false);
  }
  assert.equal(
    (await f.manager.call(connection.id, 'echo', { value: 'authorized' })).content[0].text,
    'authorized',
  );
  assert.equal(tokenCalls, 0);
});

test('MCP OAuth supports manually registered clients and rejects stale callback configuration', async t => {
  let base;
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url.startsWith('/.well-known/oauth-authorization-server'))
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    json(
      res,
      401,
      { error: 'unauthorized' },
      {
        'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      },
    );
  });
  base = f.base;
  const c = f.manager.create({
    name: 'Manual OAuth',
    url: `${base}/mcp`,
    authType: 'oauth',
    oauthClientId: 'pre-registered-client',
    oauthClientSecret: 'private-client-secret',
  });
  const noBrowser = await f.manager.connect(c.id);
  assert.equal(noBrowser.connection.status, 'authorization-required');
  assert.equal(f.requests.length, 0);
  const started = await f.manager.getAuthStart(c.id, { owner: 'browser' });
  assert.equal(
    new URL(started.authorizationUrl).searchParams.get('client_id'),
    'pre-registered-client',
  );
  assert.equal(
    f.requests.some(req => req.url === '/register'),
    false,
  );
  await f.manager.update(c.id, { oauthScope: 'different' });
  await assert.rejects(
    f.manager.completeAuth({ state: started.state, code: 'x', iss: base }, { owner: 'browser' }),
    /state|changed/,
  );
  assert.equal(
    f.requests.some(req => req.url === '/token'),
    false,
  );
  assert.equal(JSON.stringify(f.manager.list()).includes('private-client-secret'), false);
});
