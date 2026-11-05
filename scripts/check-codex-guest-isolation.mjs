import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toolsForExecution } from '../src/engine.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CODEX_GUEST_CONFIG } from '../src/codex-guest-policy.mjs';
const home = fs.mkdtempSync('/tmp/scx-codex-noauth-');
const bin = fileURLToPath(
  new URL(
    '../node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
    import.meta.url,
  ),
);
let captured;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    try {
      captured = JSON.parse(body);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const response = {
      id: 'resp_fixture',
      object: 'response',
      status: 'completed',
      output: [
        {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Synthetic fixture complete.' }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    res.end(
      'event: response.completed\ndata: ' +
        JSON.stringify({ type: 'response.completed', response }) +
        '\n\n',
    );
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const args = [
  '-c',
  'model_provider="scx_fixture"',
  '-c',
  'model_providers.scx_fixture.name="scx_fixture"',
  '-c',
  'model_providers.scx_fixture.base_url=' +
    JSON.stringify('http://127.0.0.1:' + server.address().port + '/v1'),
  '-c',
  'model_providers.scx_fixture.wire_api="responses"',
  '-c',
  'model_providers.scx_fixture.requires_openai_auth=false',
  ...Object.entries(CODEX_GUEST_CONFIG).flatMap(([k, v]) => ['-c', k + '=' + JSON.stringify(v)]),
  'app-server',
  '--listen',
  'stdio://',
];
const child = spawn(bin, args, {
  cwd: home,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
    USER: os.userInfo().username,
    LANG: 'C.UTF-8',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', d => (stderr += d));
const pending = new Map();
let seq = 0;
readline.createInterface({ input: child.stdout }).on('line', l => {
  try {
    const r = JSON.parse(l);
    if (r.id && pending.has(r.id)) {
      pending.get(r.id)(r);
      pending.delete(r.id);
    }
  } catch {}
});
function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error('probe timeout ' + method)), 10000);
    pending.set(id, r => {
      clearTimeout(t);
      r.error ? reject(Error(r.error.message)) : resolve(r.result);
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await request('initialize', {
    clientInfo: { name: 'scx_offline_isolation_probe', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const policy = (await import('../src/codex-guest-policy.mjs')).codexGuestParams({
    cwd: home,
    model: 'scx-fixture-model',
    ephemeral: true,
    dynamicTools: toolsForExecution(true),
  });
  const started = await request('thread/start', policy);
  await request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'Return a greeting; do not use tools.' }],
  });
  for (let i = 0; i < 50 && !captured; i++) await new Promise(r => setTimeout(r, 100));
  if (!captured) throw Error('No fixture request observed');
  const names = (captured.tools || []).map(t => t.name || t.type);
  const internal = ['request_user_input', 'get_goal', 'create_goal', 'update_goal'];
  const approved = toolsForExecution(true).map(t => t.name);
  assert.deepEqual(
    names.filter(n => !internal.includes(n) && !approved.includes(n)),
    [],
    'Unexpected native tool; do not activate',
  );
  assert(
    approved.every(n => names.includes(n)),
    'Missing Cortex tools',
  );
  const report = {
    syntheticEndpointOnly: true,
    noCredentialsProvided: true,
    codexExecutable: bin,
    codexRuntimeSha256: createHash('sha256').update(fs.readFileSync(bin)).digest('hex'),
    codexPolicySha256: createHash('sha256')
      .update(JSON.stringify(CODEX_GUEST_CONFIG))
      .digest('hex'),
    toolNames: names,
    allowedControlPlaneTools: internal,
    hostComputerTools: [],
    home,
  };
  fs.writeFileSync('/tmp/scx-codex-tool-catalogue.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.close();
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 1000).unref();
}
