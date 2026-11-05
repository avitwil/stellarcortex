import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpProvider, httpModelEfforts } from '../src/http-provider.mjs';

const tool = {
  name: 'stellarcortex_memory',
  description: 'List memory',
  inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};
const img = 'data:image/png;base64,eA==';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, provider, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-http-test-')),
    requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    };
    requests.push(request);
    try {
      await handler(request, res, requests);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`,
    config = {
      enabled: true,
      apiKey: 'test-secret-never-expose',
      engine: 'ollama',
      baseUrl: `${base}/v1`,
      defaultModel:
        provider === 'anthropic-api'
          ? 'claude-sonnet-5-5'
          : provider === 'openai-api'
            ? 'gpt-6.1-sol'
            : 'test-local',
      toolsEnabled: true,
      visionEnabled: true,
      revision: 'first',
    };
  const fetchImpl = (url, options) => {
    assert.equal(options.redirect, 'error');
    if (provider === 'openai-api') assert.ok(url.startsWith('https://api.openai.com/v1/'));
    if (provider === 'anthropic-api') assert.ok(url.startsWith('https://api.anthropic.com/v1/'));
    return fetch(`${base}${new URL(url).pathname}${new URL(url).search}`, options);
  };
  const runtime = new HttpProvider({ provider, getConfig: () => config, dataDir: dir, fetchImpl });
  t.after(async () => {
    await runtime.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith('stellarcortex-http-test-')
    )
      throw new Error('Unsafe test cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, config, dir, requests, base };
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const bytes = Buffer.from(
    events
      .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`)
      .join(''),
  );
  for (let i = 0; i < bytes.length; i += 7) {
    if (res.destroyed) return;
    res.write(bytes.subarray(i, i + 7));
  }
  res.end();
}
const done = runtime =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP provider turn timed out')), 10000);
    const listener = event => {
      if (event.method === 'turn/completed') {
        clearTimeout(timer);
        runtime.off('notification', listener);
        resolve(event.params.turn);
      }
    };
    runtime.on('notification', listener);
  });
async function run(runtime, { threadId, model, input = 'Hello' } = {}) {
  const thread = await runtime.request(threadId ? 'thread/resume' : 'thread/start', {
    threadId,
    model,
    cwd: os.tmpdir(),
    developerInstructions: 'Use StellarCortex tools when needed.',
    dynamicTools: [tool],
  });
  const complete = done(runtime);
  const turn = await runtime.request('turn/start', {
    threadId: thread.thread.id,
    input: [{ type: 'text', text: input }],
    serviceTier: 'default',
  });
  return { threadId: thread.thread.id, turnId: turn.turn.id, complete };
}
const successfulTool = runtime =>
  runtime.on('request', request =>
    runtime.respond(request.id, {
      success: true,
      contentItems: [
        { type: 'inputText', text: 'memory result' },
        { type: 'inputImage', imageUrl: img },
      ],
    }),
  );

test('OpenAI Responses streams text and tools, preserves reasoning replay, and resumes persisted history', async t => {
  let posts = 0;
  const f = await fixture(t, 'openai-api', async (req, res) => {
    if (req.method === 'GET') return json(res, { data: [{ id: 'gpt-6.1-sol' }] });
    posts++;
    if (posts === 1)
      return sse(res, [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'encrypted' },
        },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            model: 'gpt-6.1-sol',
            output: [
              { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'encrypted' },
              {
                type: 'function_call',
                id: 'fc1',
                call_id: 'c1',
                name: 'stellarcortex_memory',
                arguments: '{"action":"list"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        },
      ]);
    return sse(res, [
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'שלום' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          model: 'gpt-6.1-sol',
          output: [
            {
              type: 'message',
              id: 'm1',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'שלום', annotations: [] }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 5 },
        },
      },
    ]);
  });
  successfulTool(f.runtime);
  const events = [];
  f.runtime.on('notification', m => events.push(m));
  assert.equal((await f.runtime.request('model/list')).data[0].id, 'gpt-6.1-sol');
  const first = await run(f.runtime);
  assert.equal((await first.complete).status, 'completed');
  const secondBody = f.requests.filter(r => r.method === 'POST')[1].body;
  assert.equal(secondBody.store, false);
  assert.deepEqual(secondBody.include, ['reasoning.encrypted_content']);
  assert.equal(secondBody.input[1].encrypted_content, 'encrypted');
  assert.equal(secondBody.input[3].type, 'function_call_output');
  assert.equal(secondBody.input[3].output[1].image_url, img);
  assert.equal(
    events
      .filter(e => e.method === 'item/agentMessage/delta')
      .map(e => e.params.delta)
      .join(''),
    'שלום',
  );
  f.runtime.threads.clear();
  const resumed = await run(f.runtime, { threadId: first.threadId, input: 'Continue' });
  assert.equal((await resumed.complete).status, 'completed');
  const history = f.requests.at(-1).body.input;
  assert.equal(history.at(-1).content[0].text, 'Continue');
  assert.ok(history.some(item => item.type === 'function_call_output'));
  const usage = await f.runtime.request('account/rateLimits/read');
  assert.equal(usage.requests, 3);
  assert.equal(usage.inputTokens, 34);
  assert.equal(usage.outputTokens, 14);
  assert.equal(usage.scope, 'this-installation');
  const saved = fs.readFileSync(f.runtime.sessionFile(first.threadId), 'utf8');
  assert.equal(saved.includes(f.config.apiKey), false);
  assert.equal(saved.includes('developerInstructions'), false);
});
test('Anthropic Messages keeps signed thinking and tool result images in provider-required order', async t => {
  let posts = 0;
  const f = await fixture(t, 'anthropic-api', async (req, res) => {
    if (req.method === 'GET')
      return json(res, {
        data: [{ id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }],
        has_more: false,
      });
    posts++;
    const start = {
      type: 'message_start',
      message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 0 } },
    };
    if (posts === 1)
      return sse(res, [
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'private' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'signature' },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 't1', name: 'stellarcortex_memory', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"action":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"list"}' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);
    return sse(res, [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
  });
  successfulTool(f.runtime);
  const messages = [];
  f.runtime.on('notification', m => {
    if (m.method === 'item/agentMessage/delta') messages.push(m.params.delta);
  });
  const task = await run(f.runtime);
  assert.equal((await task.complete).status, 'completed');
  const body = f.requests[1].body;
  assert.equal(body.messages[1].content[0].signature, 'signature');
  assert.equal(body.messages[2].content[0].type, 'tool_result');
  assert.equal(body.messages[2].content[0].content[1].source.data, 'eA==');
  assert.equal(messages.join(''), 'Done');
  assert.equal(f.requests[0].headers['x-api-key'], f.config.apiKey);
});
test('local OpenAI-compatible runtimes support all four engine choices and parallel tool-call ordering', async t => {
  let posts = 0;
  const f = await fixture(t, 'local', async (req, res) => {
    if (req.method === 'GET') return json(res, { data: [{ id: 'test-local' }] });
    posts++;
    if (posts === 1)
      return sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'a',
                    function: { name: 'stellarcortex_memory', arguments: '{"action":' },
                  },
                  {
                    index: 1,
                    id: 'b',
                    function: { name: 'stellarcortex_memory', arguments: '{"action":"list"}' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"list"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        '[DONE]',
      ]);
    return sse(res, [
      { choices: [{ delta: { content: 'Local result' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      '[DONE]',
    ]);
  });
  successfulTool(f.runtime);
  for (const engine of ['ollama', 'lmstudio', 'llamacpp', 'vllm']) {
    f.config.engine = engine;
    assert.equal((await f.runtime.request('connection/test')).connected, true);
  }
  const task = await run(f.runtime);
  assert.equal((await task.complete).status, 'completed');
  const body = f.requests.filter(r => r.method === 'POST')[1].body;
  assert.deepEqual(
    body.messages.slice(3, 5).map(m => [m.role, m.tool_call_id]),
    [
      ['tool', 'a'],
      ['tool', 'b'],
    ],
  );
  assert.equal(body.messages[5].role, 'user');
  assert.equal(body.messages[5].content.filter(c => c.type === 'image_url').length, 2);
  assert.deepEqual(httpModelEfforts('local', 'test-local'), []);
  assert.equal((await f.runtime.request('account/rateLimits/read')).reportedRequests, 1);
});
test('configured manual model fallback is explicit and connection test never masks a failed server', async t => {
  const f = await fixture(t, 'local', (_, res) =>
    json(res, { error: 'catalog not implemented' }, 404),
  );
  await f.runtime.start();
  assert.equal(f.requests.length, 0);
  const listed = await f.runtime.request('model/list');
  assert.equal(listed.data[0].availability, 'unverified');
  assert.equal(listed.data[0].catalogSource, 'configured');
  await assert.rejects(f.runtime.request('connection/test'), /404/);
  f.config.enabled = false;
  await assert.rejects(f.runtime.request('model/list'), /Configure/);
  assert.equal((await f.runtime.request('account/read')).account, null);
});
test('HTTP errors redact API keys and do not retry failed paid requests or follow redirects', async t => {
  let calls = 0;
  const f = await fixture(t, 'openai-api', (req, res) => {
    calls++;
    if (calls === 1) return json(res, { error: `Bad key ${req.headers.authorization}` }, 401);
    res.writeHead(307, { Location: 'http://example.invalid/steal' });
    res.end();
  });
  const one = await run(f.runtime);
  const result = await one.complete;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.message.includes(f.config.apiKey), false);
  assert.equal(calls, 1);
  const two = await run(f.runtime);
  assert.equal((await two.complete).status, 'failed');
  assert.equal(calls, 2);
});
test('cancellation aborts an open SSE stream without executing follow-up requests', async t => {
  const f = await fixture(t, 'local', async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Working"}}]}\n\n');
    await new Promise(resolve => res.once('close', resolve));
  });
  const emitted = new Promise(resolve =>
    f.runtime.on('notification', e => {
      if (e.method === 'item/agentMessage/delta') resolve();
    }),
  );
  const task = await run(f.runtime);
  await emitted;
  await f.runtime.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId });
  assert.equal((await task.complete).status, 'interrupted');
  assert.equal(f.requests.length, 1);
});
test('cancellation rejects a pending tool approval and records an interrupted result for safe resume', async t => {
  const f = await fixture(t, 'local', (_req, res) =>
    sse(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'pending',
                  function: { name: 'stellarcortex_memory', arguments: '{"action":"list"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      '[DONE]',
    ]),
  );
  const requested = new Promise(resolve => f.runtime.on('request', resolve));
  const task = await run(f.runtime);
  await requested;
  await f.runtime.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId });
  assert.equal((await task.complete).status, 'interrupted');
  assert.equal(f.runtime.pending.size, 0);
  assert.equal(f.requests.length, 1);
  const saved = JSON.parse(fs.readFileSync(f.runtime.sessionFile(task.threadId), 'utf8'));
  assert.equal(saved.pendingCalls, undefined);
  assert.ok(
    saved.history.some(message => message.role === 'tool' && /interrupted/.test(message.content)),
  );
});
test('persisted unfinished tool batches recover confirmed outputs and never execute unknown outcomes again', async t => {
  const f = await fixture(t, 'local', (_req, res) =>
    sse(res, [
      { choices: [{ delta: { content: 'Reviewed prior results' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]),
  );
  const started = await f.runtime.request('thread/start', { dynamicTools: [tool] }),
    id = started.thread.id,
    file = f.runtime.sessionFile(id),
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.history = [
    { role: 'user', content: 'Prior task' },
    {
      role: 'assistant',
      content: null,
      tool_calls: ['a', 'b'].map(id => ({
        id,
        type: 'function',
        function: { name: 'stellarcortex_memory', arguments: '{}' },
      })),
    },
  ];
  saved.pendingCalls = [
    {
      id: 'a',
      name: 'stellarcortex_memory',
      arguments: '{}',
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'Confirmed prior output' }],
      },
    },
    { id: 'b', name: 'stellarcortex_memory', arguments: '{}' },
  ];
  fs.writeFileSync(file, JSON.stringify(saved));
  f.runtime.threads.clear();
  let tools = 0;
  f.runtime.on('request', () => tools++);
  const resumed = await run(f.runtime, { threadId: id });
  assert.equal((await resumed.complete).status, 'completed');
  assert.equal(tools, 0);
  const history = f.requests[0].body.messages;
  assert.equal(history[3].content, 'Confirmed prior output');
  assert.match(history[4].content, /server stopped/);
});
test('connection revisions isolate saved sessions and active turns retain their original credentials', async t => {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const f = await fixture(t, 'local', async (req, res) => {
    await gate;
    return sse(res, [
      { choices: [{ delta: { content: 'Original connection' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  });
  const task = await run(f.runtime);
  for (let i = 0; i < 30 && !f.requests.length; i++) await wait(10);
  f.config.apiKey = 'different-account-secret';
  f.config.revision = 'second';
  f.runtime.configurationChanged();
  release();
  assert.equal((await task.complete).status, 'completed');
  assert.equal(f.requests[0].headers.authorization, 'Bearer test-secret-never-expose');
  await assert.rejects(
    f.runtime.request('thread/resume', { threadId: task.threadId, dynamicTools: [tool] }),
    /connection changed/,
  );
  assert.equal((await f.runtime.request('account/rateLimits/read')).requests, 0);
});
test('truncated streams never execute unconfirmed tool calls', async t => {
  const f = await fixture(t, 'openai-api', (_req, res) =>
    sse(res, [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'x',
          name: 'stellarcortex_memory',
          arguments: '{}',
        },
      },
    ]),
  );
  let tools = 0;
  f.runtime.on('request', () => tools++);
  const task = await run(f.runtime);
  assert.equal((await task.complete).status, 'failed');
  assert.equal(tools, 0);
});
test('catalog and error readers enforce byte limits before consuming unbounded responses', async t => {
  const f = await fixture(t, 'local', (req, res) => {
    res.writeHead(req.url === '/v1/models' ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end('x'.repeat(5 * 1024 * 1024));
  });
  await assert.rejects(f.runtime.request('connection/test'), /size limit/);
  const task = await run(f.runtime);
  const result = await task.complete;
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /size limit/);
  assert.ok(result.error.message.length < 1600);
});
test('API effort choices follow documented model families instead of local or unknown model guesses', () => {
  assert.deepEqual(httpModelEfforts('openai-api', 'gpt-6.1-sol'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(httpModelEfforts('openai-api', 'gpt-6-luna'), [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(httpModelEfforts('openai-api', 'unknown-model'), []);
  assert.deepEqual(httpModelEfforts('anthropic-api', 'claude-opus-4-6'), [
    'low',
    'medium',
    'high',
    'max',
  ]);
});

for (const protocol of ['chat-completions', 'responses', 'anthropic'])
  test(`custom ${protocol} connection discovers remote IDs and completes its own tool loop and persisted resume`, async t => {
    let posts = 0;
    const provider = `custom-${protocol}`,
      model =
        protocol === 'anthropic'
          ? 'claude-sonnet-5-5'
          : protocol === 'responses'
            ? 'gpt-6.1-sol'
            : 'nvidia/vendor-model';
    const f = await fixture(t, provider, async (req, res) => {
      if (req.method === 'GET')
        return json(res, {
          data: [{ id: model, display_name: 'Remote display name' }],
          has_more: false,
        });
      posts++;
      if (protocol === 'responses')
        return sse(res, [
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              model,
              output:
                posts === 1
                  ? [
                      {
                        type: 'function_call',
                        call_id: 'custom-call',
                        name: 'stellarcortex_memory',
                        arguments: '{"action":"list"}',
                      },
                    ]
                  : [
                      {
                        type: 'message',
                        id: `reply-${posts}`,
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'Custom reply' }],
                      },
                    ],
              usage: { input_tokens: 6, output_tokens: 2 },
            },
          },
        ]);
      if (protocol === 'anthropic')
        return sse(res, [
          {
            type: 'message_start',
            message: {
              model,
              usage: { input_tokens: 6, output_tokens: 0, cache_read_input_tokens: 3 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block:
              posts === 1
                ? {
                    type: 'tool_use',
                    id: 'custom-call',
                    name: 'stellarcortex_memory',
                    input: { action: 'list' },
                  }
                : { type: 'text', text: '' },
          },
          ...(posts === 1
            ? []
            : [
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'Custom reply' },
                },
              ]),
          {
            type: 'message_delta',
            delta: { stop_reason: posts === 1 ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: 2 },
          },
          { type: 'message_stop' },
        ]);
      return sse(res, [
        {
          model,
          choices: [
            {
              delta:
                posts === 1
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'custom-call',
                          function: {
                            name: 'stellarcortex_memory',
                            arguments: '{"action":"list"}',
                          },
                        },
                      ],
                    }
                  : { content: 'Custom reply' },
              finish_reason: posts === 1 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 2 },
        },
        '[DONE]',
      ]);
    });
    f.config.protocol = protocol;
    f.config.baseUrl = `${f.base}/gateway/v1`;
    delete f.config.defaultModel;
    successfulTool(f.runtime);
    const account = await f.runtime.request('account/read');
    assert.equal(account.account.type, 'api');
    assert.equal((await f.runtime.request('config/read')).config.model, null);
    const catalog = await f.runtime.request('model/list');
    assert.equal(catalog.data[0].model, model);
    assert.equal(catalog.data[0].isDefault, false);
    assert.deepEqual(catalog.data[0].supportedReasoningEfforts, []);
    assert.deepEqual(catalog.data[0].serviceTiers, []);
    const task = await run(f.runtime, { model });
    assert.equal((await task.complete).status, 'completed');
    const requests = f.requests.filter(r => r.method === 'POST'),
      route =
        protocol === 'responses'
          ? 'responses'
          : protocol === 'anthropic'
            ? 'messages'
            : 'chat/completions';
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.url === `/gateway/v1/${route}`));
    if (protocol === 'anthropic') {
      assert.equal(requests[0].headers['x-api-key'], f.config.apiKey);
      assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
      assert.equal(requests[0].headers.authorization, undefined);
      assert.match(f.requests[0].url, /models\?limit=100/);
      assert.equal(requests[1].body.messages[2].content[0].type, 'tool_result');
      assert.equal(requests[1].body.messages[2].content[0].content[1].type, 'image');
    } else {
      assert.equal(requests[0].headers.authorization, `Bearer ${f.config.apiKey}`);
      assert.equal(requests[0].headers['x-api-key'], undefined);
      if (protocol === 'responses') {
        assert.equal(requests[0].body.input[0].content[0].type, 'input_text');
        assert.equal(requests[1].body.input[2].type, 'function_call_output');
      } else {
        assert.equal(requests[0].body.messages[1].content, 'Hello');
        assert.equal(requests[1].body.messages[3].role, 'tool');
      }
    }
    f.runtime.threads.clear();
    const resumed = await run(f.runtime, {
      threadId: task.threadId,
      model,
      input: 'Continue this connection',
    });
    assert.equal((await resumed.complete).status, 'completed');
    const usage = await f.runtime.request('account/rateLimits/read');
    assert.equal(usage.provider, provider);
    assert.equal(usage.requests, 3);
    assert.equal(usage.reportedRequests, 3);
    assert.equal(usage.inputTokens, protocol === 'anthropic' ? 27 : 18);
    assert.equal(usage.outputTokens, 6);
    await assert.rejects(
      f.runtime.request('turn/start', {
        threadId: task.threadId,
        model,
        effort: 'high',
        input: [],
      }),
      /does not advertise/,
    );
  });

test('custom protocol changes isolate sessions and token accounts while active tool rounds keep their captured protocol', async t => {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  let chatPosts = 0;
  const f = await fixture(t, 'custom-zen', async (req, res) => {
    if (req.url.endsWith('/responses'))
      return sse(res, [
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'new',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'New protocol' }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      ]);
    chatPosts++;
    if (chatPosts === 1) {
      await gate;
      return sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'old-tool',
                    function: { name: 'stellarcortex_memory', arguments: '{"action":"list"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        '[DONE]',
      ]);
    }
    return sse(res, [
      {
        choices: [{ delta: { content: 'Old protocol completed' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      },
      '[DONE]',
    ]);
  });
  f.config.protocol = 'chat-completions';
  delete f.config.revision;
  successfulTool(f.runtime);
  const oldVersion = f.runtime.configurationVersion,
    task = await run(f.runtime, { model: 'shared-model' });
  for (let i = 0; i < 50 && !f.requests.length; i++) await wait(10);
  f.config.protocol = 'responses';
  assert.notEqual(f.runtime.configurationVersion, oldVersion);
  f.runtime.configurationChanged();
  release();
  assert.equal((await task.complete).status, 'completed');
  assert.ok(f.requests.every(r => r.url.endsWith('/chat/completions')));
  assert.equal((await f.runtime.request('account/rateLimits/read')).requests, 0);
  await assert.rejects(
    f.runtime.request('thread/resume', { threadId: task.threadId }),
    /connection changed/,
  );
  const next = await run(f.runtime, { model: 'shared-model' });
  assert.equal((await next.complete).status, 'completed');
  assert.ok(f.requests.at(-1).url.endsWith('/responses'));
  assert.equal((await f.runtime.request('account/rateLimits/read')).requests, 1);
  const other = new HttpProvider({
    provider: 'custom-other',
    getConfig: () => f.config,
    dataDir: f.dir,
    fetchImpl: () => {
      throw new Error('No network expected');
    },
  });
  t.after(() => other.stop());
  assert.notEqual(other.config().binding, f.runtime.config().binding);
  assert.equal((await other.request('account/rateLimits/read')).requests, 0);
  await assert.rejects(other.request('thread/resume', { threadId: next.threadId }), /unavailable/);
});

test('custom connections require explicit credentials and valid protocol and never infer vendor effort from remote IDs', async t => {
  const f = await fixture(t, 'custom-nvidia', (_, res) => json(res, { data: [] }));
  f.config.apiKey = '';
  assert.equal((await f.runtime.request('account/read')).account, null);
  await assert.rejects(f.runtime.request('connection/test'), /API key/);
  assert.equal(f.requests.length, 0);
  f.config.apiKey = 'key';
  delete f.config.baseUrl;
  assert.equal((await f.runtime.request('account/read')).account, null);
  f.config.baseUrl = `${f.base}/v1`;
  f.config.protocol = 'unknown';
  await assert.rejects(f.runtime.request('account/read'), /protocol/);
  for (const model of ['gpt-6.1-sol', 'claude-opus-4-6', 'claude-sonnet-5-5'])
    assert.deepEqual(httpModelEfforts('custom-nvidia', model), []);
});

test('custom model catalog can use a separate same-origin route without changing inference routing or leaking credentials', async t => {
  const f = await fixture(t, 'custom-opencode', async (req, res) => {
    if (req.method === 'GET') return json(res, { data: [{ id: 'remote-gpt' }] });
    return sse(res, [
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'answer',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Done' }],
            },
          ],
        },
      },
    ]);
  });
  Object.assign(f.config, {
    name: 'OpenCode Zen',
    protocol: 'responses',
    baseUrl: `${f.base}/inference/openai/v1`,
    modelsUrl: `${f.base}/inference/v1/models`,
  });
  delete f.config.defaultModel;
  assert.equal(f.runtime.displayName, 'OpenCode Zen');
  assert.equal((await f.runtime.request('model/list')).data[0].id, 'remote-gpt');
  assert.equal(f.requests[0].url, '/inference/v1/models');
  assert.equal(f.requests[0].headers.authorization, `Bearer ${f.config.apiKey}`);
  const task = await run(f.runtime, { model: 'remote-gpt' });
  assert.equal((await task.complete).status, 'completed');
  assert.equal(f.requests.at(-1).url, '/inference/openai/v1/responses');
  const before = f.requests.length;
  for (const modelsUrl of [
    'https://other.example/models',
    `${f.base}/models?secret=key`,
    `${f.base}/models#fragment`,
    `${f.base.replace('://', '://user:password@')}/models`,
  ]) {
    f.config.modelsUrl = modelsUrl;
    await assert.rejects(f.runtime.request('connection/test'), /catalog URL/);
  }
  assert.equal(f.requests.length, before);
  f.config.modelsUrl = `${f.base}/inference/v1/models`;
  await assert.rejects(
    f.runtime.http(f.runtime.config(), 'https://other.example/models'),
    /configured API origin/,
  );
  assert.equal(f.requests.length, before);
});
