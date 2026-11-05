import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { claudeLoginCommand } from '../src/claude-login.mjs';

class Provider extends EventEmitter {
  constructor(id, { missing = false } = {}) {
    super();
    this.id = id;
    this.ready = !missing;
    this.installed = !missing;
    this.missing = missing;
    this.calls = [];
  }
  async start() {
    if (this.missing) throw new Error(`${this.id} is not installed`);
    this.ready = true;
  }
  async stop() {
    this.ready = false;
  }
  async request(method) {
    this.calls.push(method);
    if (method === 'account/read')
      return {
        account: {
          type: this.id === 'codex' ? 'chatgpt' : 'claude',
          email: `${this.id}@example.test`,
        },
      };
    if (method === 'model/list')
      return {
        data: [
          {
            id: `${this.id}-model`,
            model: `${this.id}-model`,
            displayName: `${this.id} model`,
            isDefault: true,
            supportedReasoningEfforts: [],
            serviceTiers: [],
          },
        ],
      };
    if (method === 'config/read') return { config: { model: `${this.id}-model` } };
    if (method === 'account/rateLimits/read')
      return this.id === 'claude'
        ? {
            available: true,
            source: 'claude-code-usage',
            rateLimitsByLimitId: {
              five_hour: {
                limitId: 'five_hour',
                limitName: 'Current session',
                primary: {
                  usedPercent: 32,
                  windowDurationMins: 300,
                  resetText: 'Oct 26, 7pm (Asia/Jerusalem)',
                },
              },
            },
          }
        : { rateLimits: {} };
    if (method === 'mcpServerStatus/list') return { data: [] };
    throw new Error(`Unexpected ${method}`);
  }
}
async function fixture(t, options = {}) {
  const baseDir = path.resolve('.test-data');
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseDir, 'providers-http-'));
  const codex = options.codex || new Provider('codex'),
    claude = options.claude || new Provider('claude');
  const app = await createApp({
    dataDir: dir,
    port: 0,
    runtime: codex,
    claudeRuntime: claude,
    startEngine: options.startEngine === true,
    ...(options.voiceSessionFactory ? { voiceSessionFactory: options.voiceSessionFactory } : {}),
  });
  const apps = [app];
  t.after(async () => {
    for (const instance of apps.toReversed()) await instance.close();
    if (path.dirname(path.resolve(dir)) !== baseDir) throw new Error('Unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const connect = async instance => {
    const base = `http://127.0.0.1:${instance.port}`;
    const session = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'X-StellarCortex-Client': '1' },
      body: JSON.stringify({ key: instance.accessKey }),
    });
    const headers = {
      Cookie: session.headers.get('set-cookie').split(';')[0],
      'X-StellarCortex-Client': '1',
      'Content-Type': 'application/json',
    };
    const api = async (route, body) => {
      const response = await fetch(base + route, {
        headers,
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    return { base, headers, api, app: instance };
  };
  const restart = async () => {
    await apps.at(-1).close();
    const next = await createApp({
      dataDir: dir,
      port: 0,
      runtime: new Provider('codex'),
      claudeRuntime: new Provider('claude'),
      startEngine: false,
    });
    apps.push(next);
    return connect(next);
  };
  return { ...(await connect(app)), codex, claude, restart };
}

async function compatibleServer(
  t,
  { model, reply, protocol = 'chat-completions', inputTokens = 13, outputTokens = 4 } = {},
) {
  const requests = [],
    errors = [];
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
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      assert.equal(request.body.model, model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events =
        protocol === 'responses'
          ? [
              { type: 'response.output_text.delta', item_id: 'reply', delta: reply },
              {
                type: 'response.completed',
                response: {
                  status: 'completed',
                  model,
                  output: [
                    {
                      type: 'message',
                      id: 'reply',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: reply, annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                },
              },
            ]
          : [
              {
                choices: [{ delta: { content: reply }, finish_reason: 'stop' }],
                usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
              },
              '[DONE]',
            ];
      res.end(
        events
          .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
          .join(''),
      );
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    assert.deepEqual(errors, []);
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
async function completedJob(app, id) {
  const job = app.store.data.jobs.find(item => item.id === id);
  assert.ok(job);
  for (
    let attempt = 0;
    attempt < 250 && !['completed', 'failed', 'interrupted'].includes(job.status);
    attempt++
  )
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(job.status, 'completed', job.error);
  return job;
}
test('provider accounts and model catalogs stay isolated; legacy account remains Codex', async t => {
  const { api, claude } = await fixture(t);
  const list = await api('/api/providers');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.data.providers.map(p => [p.id, p.connected]),
    [
      ['codex', true],
      ['claude', true],
      ['openai-api', false],
      ['anthropic-api', false],
      ['local', false],
    ],
  );
  const account = await api('/api/providers/claude/account');
  assert.equal(account.data.account.type, 'claude');
  assert.equal(account.data.defaultModel, 'claude-model');
  assert.equal(account.data.loginInstructions, claudeLoginCommand());
  assert.equal(account.data.models[0].id, 'claude-model');
  assert.equal(account.data.usage.rateLimitsByLimitId.five_hour.primary.usedPercent, 32);
  assert.equal(claude.calls.includes('account/rateLimits/read'), true);
  const legacy = await api('/api/account');
  assert.equal(legacy.data.account.type, 'chatgpt');
  assert.equal(legacy.data.defaultModel, 'codex-model');
  assert.equal((await api('/api/providers/unknown/account')).status, 400);
});
test('missing Claude does not break Codex or prevent configuring a Claude bot', async t => {
  const { api } = await fixture(t, { claude: new Provider('claude', { missing: true }) });
  const list = (await api('/api/providers')).data;
  assert.equal(list.providers[0].connected, true);
  assert.equal(list.providers[1].installed, false);
  assert.equal(list.providers[1].connected, false);
  assert.match(list.providers[1].error, /not installed/);
  const result = await api('/api/bots', { name: 'Claude specialist', provider: 'claude' });
  assert.equal(result.status, 201);
  assert.equal(result.data.bot.provider, 'claude');
  assert.equal(result.data.bot.model, '');
  const template = await api(`/api/bots/${result.data.bot.id}/template`);
  assert.equal(template.data.bot.provider, 'claude');
  assert.equal('account' in template.data.bot, false);
  assert.equal((await api('/api/account')).data.connected, true);
});
test('provider status endpoints remain protected by the installation session', async t => {
  const { base } = await fixture(t);
  assert.equal((await fetch(`${base}/api/providers`)).status, 401);
  assert.equal((await fetch(`${base}/api/providers/claude/account`)).status, 401);
  assert.equal((await fetch(`${base}/api/provider-connections`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/provider-connections`, {
        method: 'POST',
        headers: { 'X-StellarCortex-Client': '1' },
        body: JSON.stringify({
          name: 'Unauthorized connection',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'unauthorized-key',
          protocol: 'chat-completions',
        }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/provider-connections/local`, {
        method: 'PATCH',
        headers: { 'X-StellarCortex-Client': '1' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal((await fetch(`${base}/api/voice/status`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/voice/session`, {
        method: 'POST',
        headers: { 'X-StellarCortex-Client': '1' },
        body: '{}',
      })
    ).status,
    401,
  );
});

test('voice API uses the saved server key, requires an active bot and returns no credentials', async t => {
  const calls = [],
    answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  const { base, headers, api, app } = await fixture(t, {
    voiceSessionFactory: async input => {
      calls.push(input);
      return { sdp: answer, model: 'gpt-realtime-2.1', voice: 'marin', apiKey: input.apiKey };
    },
  });
  const botId = app.store.data.bots[0].id,
    secret = 'test-voice-server-key';
  assert.equal((await api('/api/voice/status')).data.openaiAvailable, false);
  assert.equal(
    (await api('/api/voice/session', { botId, sdp: answer, language: 'he' })).status,
    400,
  );
  assert.equal(calls.length, 0);
  await fetch(`${base}/api/provider-connections/openai-api`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ apiKey: secret }),
  });
  assert.equal((await api('/api/voice/status')).data.openaiAvailable, true);
  const result = await api('/api/voice/session', { botId, sdp: answer, language: 'en' });
  assert.equal(result.status, 200);
  assert.equal(calls[0].apiKey, secret);
  assert.equal(calls[0].language, 'en');
  assert.equal(JSON.stringify(result.data).includes(secret), false);
  assert.equal('apiKey' in result.data, false);
  app.store.deleteBot(botId);
  assert.equal((await api('/api/voice/session', { botId, sdp: answer })).status, 400);
  assert.equal(calls.length, 1);
});

test('voice task-tree cancellation suppresses late delegated replies without cancelling other work', async t => {
  const { api, app } = await fixture(t),
    bot = app.store.data.bots[0],
    chat = app.store.data.chats[0];
  const root = {
      id: 'voice-root',
      rootJobId: 'voice-root',
      botId: bot.id,
      chatId: chat.id,
      status: 'completed',
    },
    child = {
      id: 'voice-child',
      rootJobId: root.id,
      parentJobId: root.id,
      botId: bot.id,
      chatId: chat.id,
      status: 'queued',
    },
    other = {
      id: 'other-root',
      rootJobId: 'other-root',
      botId: bot.id,
      chatId: chat.id,
      status: 'queued',
    };
  app.store.data.jobs.push(root, child, other);
  app.store.save();
  assert.equal((await api(`/api/jobs/${root.id}/cancel`, { tree: true })).status, 200);
  assert.equal(root.cancelled, true);
  assert.equal(child.status, 'interrupted');
  assert.equal(child.reportSuppressed, 'The receiving bot or originating task is no longer active');
  assert.equal(other.status, 'queued');
  assert.equal(app.store.data.jobs.length, 3);
});

test('a failed interrupt leaves no job of the tree running, and nothing new starts under a stopped root', async t => {
  const codex = new Provider('codex'),
    { api, app } = await fixture(t, { codex }),
    bot = app.store.data.bots[0],
    chat = app.store.data.chats[0];
  const job = (id, fields) => ({
    id,
    rootJobId: 'stop-root',
    botId: bot.id,
    chatId: chat.id,
    provider: 'codex',
    ...fields,
  });
  const jobs = [
    job('stop-root', { status: 'running', turnId: 'slow', threadId: 'slow' }),
    job('stop-failing', { status: 'running', turnId: 'bad', threadId: 'bad' }),
    job('stop-next', { status: 'running', turnId: 'next', threadId: 'next' }),
    job('stop-queued', { status: 'queued' }),
  ];
  app.store.data.jobs.push(...jobs);
  app.store.save();
  let release, reached;
  const held = new Promise(resolve => {
      reached = resolve;
    }),
    interrupted = [],
    request = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method !== 'turn/interrupt') return request(method, params);
    interrupted.push(params.threadId);
    if (params.threadId === 'bad') throw new Error('turn already ended');
    if (params.threadId === 'slow')
      await new Promise(resolve => {
        release = resolve;
        reached();
      });
    return {};
  };
  const stopped = api('/api/jobs/stop-root/cancel', { tree: true });
  await held;
  try {
    assert.deepEqual(
      jobs.map(item => item.cancelled),
      [true, true, true, true],
    );
    assert.deepEqual(interrupted, ['slow', 'bad', 'next']);
    assert.equal(jobs[3].status, 'interrupted');
    assert.throws(
      () =>
        app.engine.enqueue(chat.id, 'one more', {
          botIds: [bot.id],
          source: 'handoff',
          depth: 1,
          parentJobId: 'stop-next',
          rootJobId: 'stop-root',
        }),
      /was stopped/,
    );
  } finally {
    release();
  }
  const result = await stopped;
  assert.equal(result.status, 400);
  assert.match(result.data.error, /turn already ended/);
  assert.equal(app.store.data.jobs.length, 4);
});

test('HTTP connection edits keep secrets out of state, status, templates and exports', async t => {
  const { base, headers, api } = await fixture(t),
    secret = 'test-private-api-key-987654';
  const patch = async (provider, body) => {
    const response = await fetch(`${base}/api/provider-connections/${provider}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const saved = await patch('openai-api', { apiKey: secret, defaultModel: 'gpt-test' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.hasApiKey, true);
  assert.equal(JSON.stringify(saved.data).includes(secret), false);
  for (const endpoint of [
    '/api/state',
    '/api/export',
    '/api/provider-connections',
    '/api/providers',
  ])
    assert.equal(JSON.stringify((await api(endpoint)).data).includes(secret), false);
  const bot = (await api('/api/bots', { name: 'API teammate', provider: 'openai-api' })).data.bot;
  assert.equal((await api(`/api/bots/${bot.id}/template`)).data.bot.provider, 'openai-api');
  assert.equal((await patch('openai-api', { baseUrl: 'https://other.example/v1' })).status, 400);
  assert.equal((await patch('openai-api', { removeApiKey: true })).data.hasApiKey, false);
  const listed = (await api('/api/provider-connections')).data;
  assert.equal(listed.localEngines.length, 4);
  assert.equal(listed.connections.find(c => c.provider === 'local').configured, false);
});

test('local endpoint can be configured without a key; connection test does not fabricate success', async t => {
  const { base, headers, api } = await fixture(t);
  const response = await fetch(`${base}/api/provider-connections/local`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      engine: 'llamacpp',
      baseUrl: 'http://127.0.0.1:1/v1',
      defaultModel: 'local-test',
      toolsEnabled: false,
    }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.hasApiKey, false);
  assert.equal(saved.configured, true);
  const probe = await api('/api/provider-connections/local/test', {});
  assert.equal(probe.status, 200);
  assert.equal(probe.data.connected, false);
  assert.ok(probe.data.error);
  assert.equal((await api('/api/providers/local/account')).data.connected, false);
  assert.equal((await api('/api/provider-connections/unknown/test', {})).status, 400);
});

test('a delayed connection probe cannot verify a different saved endpoint', async t => {
  let release, started;
  const began = new Promise(resolve => (started = resolve)),
    gate = new Promise(resolve => (release = resolve));
  const oldServer = http.createServer(async (_req, res) => {
    started();
    await gate;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'old-model' }] }));
  });
  await new Promise(resolve => oldServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    release();
    oldServer.closeAllConnections();
    oldServer.close();
  });
  const { base, headers, api } = await fixture(t);
  const patch = body =>
    fetch(`${base}/api/provider-connections/local`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  await patch({
    baseUrl: `http://127.0.0.1:${oldServer.address().port}/v1`,
    defaultModel: 'old-model',
  });
  const pending = api('/api/provider-connections/local/test', {});
  await began;
  await patch({ baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'new-model' });
  release();
  const result = await pending;
  assert.equal(result.data.connected, false);
  assert.match(result.data.error, /changed/);
  assert.equal(result.data.defaultModel, 'new-model');
});

test('configured local server streams through the real engine, calls StellarCortex tools and records results', async t => {
  const requests = [];
  const modelServer = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'integration-local' }] }));
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const output =
      requests.length === 1
        ? {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'memory-call',
                      type: 'function',
                      function: {
                        name: 'stellarcortex_memory',
                        arguments: JSON.stringify({ action: 'save', text: 'Integration memory' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }
        : {
            choices: [{ delta: { content: 'LOCAL_ENGINE_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 4 },
          };
    res.end(`data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    modelServer.closeAllConnections();
    modelServer.close();
  });
  const { base, headers, api, app } = await fixture(t, { startEngine: true });
  const saved = await fetch(`${base}/api/provider-connections/local`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      engine: 'vllm',
      baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
      defaultModel: 'integration-local',
    }),
  });
  assert.equal(saved.status, 200);
  const created = await api('/api/bots', {
    name: 'Local integration',
    provider: 'local',
    model: 'integration-local',
  });
  assert.equal(created.status, 201);
  const sent = await api(`/api/chats/${created.data.chat.id}/messages`, {
    text: 'Save the integration memory, then confirm.',
  });
  assert.equal(sent.status, 202);
  const job = app.store.data.jobs.find(j => j.id === sent.data.jobs[0].id);
  for (let i = 0; i < 200 && !['completed', 'failed', 'interrupted'].includes(job.status); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(job.status, 'completed', job.error);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.role === 'tool' && m.tool_call_id === 'memory-call'));
  assert.equal(app.store.bot(created.data.bot.id).memory[0].text, 'Integration memory');
  assert.ok(
    app.store.data.messages.some(
      m => m.jobId === job.id && m.role === 'assistant' && m.text === 'LOCAL_ENGINE_OK',
    ),
  );
  assert.equal(app.store.data.providerUsage.local.totalTokens, 24);
  assert.equal(app.store.data.providerUsage.local.requests, 2);
});

test('named custom API connections register immediately with isolated models, keys, bots and usage', async t => {
  const alpha = await compatibleServer(t, {
    model: 'alpha-chat-model',
    reply: 'ALPHA_REPLY',
    inputTokens: 19,
    outputTokens: 6,
  });
  const beta = await compatibleServer(t, {
    model: 'beta-response-model',
    reply: 'BETA_REPLY',
    protocol: 'responses',
    inputTokens: 31,
    outputTokens: 8,
  });
  const f = await fixture(t, { startEngine: true }),
    specs = [
      {
        name: 'Alpha private API',
        apiKey: 'alpha-isolated-secret-1234',
        baseUrl: alpha.baseUrl,
        protocol: 'chat-completions',
        server: alpha,
        model: 'alpha-chat-model',
        reply: 'ALPHA_REPLY',
        tokens: 25,
      },
      {
        name: 'Beta private API',
        apiKey: 'beta-isolated-secret-5678',
        baseUrl: beta.baseUrl,
        protocol: 'responses',
        server: beta,
        model: 'beta-response-model',
        reply: 'BETA_REPLY',
        tokens: 39,
      },
    ];
  for (const spec of specs) {
    const created = await f.api('/api/provider-connections', {
      name: spec.name,
      apiKey: spec.apiKey,
      baseUrl: spec.baseUrl,
      protocol: spec.protocol,
    });
    assert.equal(created.status, 201, created.data.error);
    assert.match(created.data.provider, /^custom-[a-z0-9-]+$/);
    spec.id = created.data.provider;
    assert.equal(created.data.name, spec.name);
    assert.equal(created.data.protocol, spec.protocol);
    assert.equal(created.data.defaultModel, '');
    assert.equal(created.data.hasApiKey, true);
    assert.equal(JSON.stringify(created.data).includes(spec.apiKey), false);
    const tested = await f.api(`/api/provider-connections/${spec.id}/test`, {});
    assert.equal(tested.status, 200);
    assert.equal(tested.data.connected, true, tested.data.error);
    const account = await f.api(`/api/providers/${spec.id}/account`);
    assert.equal(account.status, 200);
    assert.equal(account.data.name, spec.name);
    assert.equal(account.data.account.type, 'api');
    assert.equal(account.data.connected, true);
    assert.deepEqual(
      account.data.models.map(model => model.model),
      [spec.model],
    );
    assert.equal(
      spec.server.requests.filter(request => request.method === 'POST').length,
      0,
      'Adding and testing a connection must not generate model replies',
    );
  }
  assert.notEqual(specs[0].id, specs[1].id);
  const listed = (await f.api('/api/provider-connections')).data.connections,
    providers = (await f.api('/api/providers')).data.providers,
    state = (await f.api('/api/state')).data;
  for (const spec of specs) {
    assert.equal(listed.find(item => item.provider === spec.id)?.name, spec.name);
    assert.equal(providers.find(item => item.id === spec.id)?.name, spec.name);
    assert.equal(state.providers.find(item => item.id === spec.id)?.name, spec.name);
  }
  for (const spec of specs) {
    const created = await f.api('/api/bots', {
      name: `${spec.name} bot`,
      provider: spec.id,
      model: spec.model,
    });
    assert.equal(created.status, 201, created.data.error);
    assert.equal(created.data.bot.provider, spec.id);
    spec.botId = created.data.bot.id;
    const sent = await f.api(`/api/chats/${created.data.chat.id}/messages`, {
      text: `Reply using ${spec.name}`,
    });
    assert.equal(sent.status, 202, sent.data.error);
    const job = await completedJob(f.app, sent.data.jobs[0].id);
    assert.ok(
      f.app.store.data.messages.some(
        message =>
          message.jobId === job.id && message.role === 'assistant' && message.text === spec.reply,
      ),
    );
    const posts = spec.server.requests.filter(request => request.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.model, spec.model);
    assert.equal(f.app.store.data.providerUsage[spec.id].requests, 1);
    assert.equal(f.app.store.data.providerUsage[spec.id].totalTokens, spec.tokens);
  }
  for (const spec of specs) {
    for (const request of spec.server.requests)
      assert.equal(request.headers.authorization, `Bearer ${spec.apiKey}`);
    assert.equal(
      JSON.stringify(spec.server.requests).includes(specs.find(other => other !== spec).apiKey),
      false,
    );
  }
  for (const route of [
    '/api/state',
    '/api/export',
    '/api/provider-connections',
    '/api/providers',
    ...specs.map(spec => `/api/bots/${spec.botId}/template`),
  ]) {
    const result = await f.api(route);
    assert.equal(result.status, 200);
    for (const spec of specs)
      assert.equal(JSON.stringify(result.data).includes(spec.apiKey), false, route);
  }
  const otherModel = await fetch(`${f.base}/api/bots/${specs[0].botId}`, {
    method: 'PATCH',
    headers: f.headers,
    body: JSON.stringify({ model: specs[1].model }),
  });
  assert.equal(otherModel.status, 400, 'A bot must not silently use another provider catalog');
});

test('custom API settings and runtime registration survive restart; unknown IDs fail closed', async t => {
  const remote = await compatibleServer(t, { model: 'persistent-api-model', reply: 'unused' }),
    f = await fixture(t),
    secret = 'persisted-custom-key-98765';
  const created = await f.api('/api/provider-connections', {
    name: 'Persistent API',
    baseUrl: remote.baseUrl,
    apiKey: secret,
    protocol: 'chat-completions',
  });
  assert.equal(created.status, 201, created.data.error);
  const id = created.data.provider;
  const bot = await f.api('/api/bots', {
    name: 'Persistent teammate',
    provider: id,
    model: 'persistent-api-model',
  });
  assert.equal(bot.status, 201, bot.data.error);
  const renamed = await fetch(`${f.base}/api/provider-connections/${id}`, {
    method: 'PATCH',
    headers: f.headers,
    body: JSON.stringify({ name: 'Renamed persistent API' }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, 'Renamed persistent API');
  const next = await f.restart();
  const listed = (await next.api('/api/provider-connections')).data.connections;
  assert.equal(listed.find(item => item.provider === id).name, 'Renamed persistent API');
  assert.equal(listed.find(item => item.provider === id).hasApiKey, true);
  assert.equal(
    (await next.api('/api/providers')).data.providers.find(item => item.id === id)?.name,
    'Renamed persistent API',
  );
  const state = (await next.api('/api/state')).data;
  assert.equal(state.providers.find(item => item.id === id)?.name, 'Renamed persistent API');
  assert.equal(state.bots.find(item => item.id === bot.data.bot.id).provider, id);
  const tested = await next.api(`/api/provider-connections/${id}/test`, {});
  assert.equal(tested.data.connected, true, tested.data.error);
  assert.deepEqual(
    tested.data.models.map(model => model.model),
    ['persistent-api-model'],
  );
  assert.equal(remote.requests.filter(request => request.method === 'POST').length, 0);
  assert.ok(remote.requests.length > 0);
  for (const request of remote.requests)
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
  const unknown = 'custom-00000000-0000-4000-8000-000000000000',
    before = remote.requests.length;
  assert.equal((await next.api(`/api/providers/${unknown}/account`)).status, 400);
  assert.equal((await next.api(`/api/provider-connections/${unknown}/test`, {})).status, 400);
  assert.equal(
    (
      await fetch(`${next.base}/api/provider-connections/${unknown}`, {
        method: 'PATCH',
        headers: next.headers,
        body: JSON.stringify({ name: 'Should not exist' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await next.api('/api/bots', {
        name: 'Unknown provider bot',
        provider: unknown,
        model: 'persistent-api-model',
      })
    ).status,
    400,
  );
  assert.equal(remote.requests.length, before);
  for (const route of ['/api/state', '/api/export', '/api/provider-connections'])
    assert.equal(JSON.stringify((await next.api(route)).data).includes(secret), false);
});

test('changing a custom endpoint requires an explicit key decision and never leaks the old key', async t => {
  const first = await compatibleServer(t, { model: 'first-model', reply: 'unused' }),
    second = await compatibleServer(t, { model: 'second-model', reply: 'unused' }),
    f = await fixture(t),
    original = 'first-private-api-key',
    replacement = 'second-private-api-key';
  const created = await f.api('/api/provider-connections', {
    name: 'Moveable API',
    baseUrl: first.baseUrl,
    apiKey: original,
    protocol: 'chat-completions',
  });
  assert.equal(created.status, 201, created.data.error);
  const id = created.data.provider;
  const patch = async body => {
    const response = await fetch(`${f.base}/api/provider-connections/${id}`, {
      method: 'PATCH',
      headers: f.headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await patch({ baseUrl: second.baseUrl })).status, 400);
  assert.equal(second.requests.length, 0);
  assert.equal((await f.api(`/api/provider-connections/${id}/test`, {})).data.connected, true);
  assert.ok(first.requests.length > 0);
  for (const request of first.requests)
    assert.equal(request.headers.authorization, `Bearer ${original}`);
  assert.equal((await patch({ baseUrl: second.baseUrl, apiKey: replacement })).status, 200);
  const tested = await f.api(`/api/provider-connections/${id}/test`, {});
  assert.equal(tested.data.connected, true, tested.data.error);
  assert.deepEqual(
    tested.data.models.map(model => model.model),
    ['second-model'],
  );
  assert.ok(second.requests.length > 0);
  for (const request of second.requests)
    assert.equal(request.headers.authorization, `Bearer ${replacement}`);
  assert.equal(JSON.stringify(second.requests).includes(original), false);
});

test('persisted Claude percentages become stale at read time even while the provider is unavailable', async t => {
  const { api, app } = await fixture(t, { claude: new Provider('claude', { missing: true }) });
  app.store.data.providerUsage = {
    claude: {
      source: 'claude-code',
      available: true,
      stale: false,
      observedAt: '2020-01-01T00:00:00.000Z',
      rateLimitsByLimitId: {
        five_hour: {
          limitName: 'Current session',
          observedAt: '2020-01-01T00:00:00.000Z',
          primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: null },
        },
      },
    },
  };
  app.store.save();
  const state = (await api('/api/state')).data;
  assert.equal(state.providerUsage.claude.stale, true);
  assert.equal(state.providerUsage.claude.rateLimitsByLimitId.five_hour.primary.usedPercent, 32);
});
