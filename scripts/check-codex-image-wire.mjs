// Manual isolated runtime integration test. Never uses live app data or provider credentials.
import assert from 'node:assert/strict';
import { showVisualResult } from '../src/codex-image-results.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import zlib from 'node:zlib';
const { CODEX_GUEST_CONFIG } = await import('../src/codex-guest-policy.mjs');
const dir = fs.mkdtempSync('/tmp/scx-image-wire-'),
  bodies = [];
const server = http.createServer(async (req, res) => {
  let chunks = [];
  for await (const b of req) chunks.push(b);
  let raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
  if (req.headers['content-encoding'] === 'zstd') raw = zlib.zstdDecompressSync(raw);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  bodies.push(body);
  fs.writeFileSync(dir + '/requests.json', JSON.stringify(bodies, null, 2));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const response = {
    id: 'resp_fixture_' + bodies.length,
    object: 'response',
    status: 'completed',
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const emit = (type, v) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...v })}\n\n`);
  emit('response.created', { response: { ...response, status: 'in_progress' } });
  const item =
    bodies.length === 1
      ? {
          type: 'custom_tool_call',
          id: 'call_item_fixture',
          call_id: 'call_fixture',
          name: 'exec',
          namespace: 'functions',
          input:
            process.argv[2] === 'broken'
              ? 'text(await tools.stellarcortex_fixture({}));'
              : showVisualResult.toString() +
                ';showVisualResult(await tools.stellarcortex_fixture({}));',
        }
      : {
          type: 'message',
          id: 'msg_fixture',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Local fixture complete.', annotations: [] }],
        };
  emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
  if (item.type === 'message')
    emit('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'Local fixture complete.',
    });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { ...response, output: [item] } });
  res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const exe = process.env.SCX_CODEX_FIXTURE_BIN;
if (!exe?.startsWith('/'))
  throw Error('Set SCX_CODEX_FIXTURE_BIN to the installed executable being verified');
const cfg = {
  ...CODEX_GUEST_CONFIG,
  model_provider: 'fixture',
  model: 'gpt-6.1-sol',
  'model_providers.fixture.name': 'Local fixture',
  'model_providers.fixture.base_url': `http://127.0.0.1:${server.address().port}/v1`,
  'model_providers.fixture.wire_api': 'responses',
  'model_providers.fixture.requires_openai_auth': false,
};
const child = spawn(
  exe,
  [
    ...Object.entries(cfg).flatMap(([k, v]) => ['-c', k + '=' + JSON.stringify(v)]),
    'app-server',
    '--listen',
    'stdio://',
  ],
  {
    env: { PATH: '/usr/bin:/bin', HOME: dir, CODEX_HOME: dir, LANG: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let seq = 0,
  pending = new Map();
const send = v => child.stdin.write(JSON.stringify(v) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
let completed;
const done = new Promise(r => (completed = r));
let errors = '';
child.stderr.on('data', x => (errors = (errors + x).slice(-3000)));
createInterface({ input: child.stdout }).on('line', line => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method) {
    if (m.id !== undefined) {
      if (m.method === 'item/tool/call')
        send({
          id: m.id,
          result: {
            success: true,
            contentItems: [
              { type: 'inputText', text: 'Synthetic image metadata only' },
              {
                type: 'inputImage',
                imageUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURf8AABniCTcAAAAHdElNRQfqCwMVCRtfJB+FAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTExLTAzVDIxOjA5OjI3KzAwOjAwok88jwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMS0wM1QyMTowOToyNyswMDowMNMShDMAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTEtMDNUMjE6MDk6MjcrMDA6MDCEB6XsAAAADElEQVQI12NgGNwAAACgAAFhJX1HAAAAAElFTkSuQmCC',
              },
            ],
          },
        });
    }
    if (m.method === 'turn/completed') completed(m.params);
    return;
  }
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const timer = setTimeout(() => {
  console.log('TIMEOUT', errors);
  child.kill();
  completed(null);
}, 30000);
try {
  await request('initialize', {
    clientInfo: { name: 'scx_local_fixture', version: '1' },
    capabilities: { experimentalApi: true },
  });
  send({ method: 'initialized' });
  const result = await request('thread/start', {
    cwd: dir,
    model: 'gpt-6.1-sol',
    modelProvider: 'fixture',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    dynamicTools: [
      {
        name: 'stellarcortex_fixture',
        description: 'Returns one synthetic test image.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  });
  await request('turn/start', {
    threadId: result.thread.id,
    input: [{ type: 'text', text: 'Local protocol fixture only.' }],
  });
  await done;
  const output = bodies.at(-1).input.find(x => x.type === 'custom_tool_call_output')?.output || [];
  const imageCount = output.filter(x => x.type === 'input_image').length;
  const base64InText = output.some(x => x.type === 'input_text' && x.text.includes('data:image/'));
  assert.equal(imageCount, process.argv[2] === 'broken' ? 0 : 1);
  assert.equal(base64InText, process.argv[2] === 'broken');
  console.log(
    JSON.stringify({
      localMockOnly: true,
      mode: process.argv[2] || 'fixed',
      imageCount,
      base64InText,
      evidenceDirectory: dir,
    }),
  );
} finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  server.close();
}
