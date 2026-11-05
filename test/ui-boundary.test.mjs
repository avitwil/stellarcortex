import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { ERROR_FIELDS, uiJson } from '../src/ui-json.mjs';
import { PROGRAM_OUTPUT } from '../public/chat-errors.js';

const stack = `Codex stopped (1). file:///tmp/app/node_modules/@openai/codex/bin/codex.js:107
  throw new Error(
Error: Missing optional dependency @openai/codex-linux-x64
    at findCodexExecutable (file:///tmp/app/node_modules/@openai/codex/bin/codex.js:107:9)`;
const virsh = 'Command failed: /usr/bin/virsh --connect qemu:///system domstate abc\nerror: no';
const raw = /file:\/\/|throw new Error|node_modules|Command failed|qemu:/;
class Runtime extends EventEmitter {
  async stop() {}
  async request() {
    throw new Error(stack);
  }
}
// Every route named in the source, so a new one is checked without changing this test.
function routes() {
  const folder = new URL('../src/', import.meta.url),
    found = new Set();
  for (const name of fs.readdirSync(folder).filter(file => file.endsWith('.mjs')))
    for (const [, route] of fs
      .readFileSync(new URL(name, folder), 'utf8')
      .matchAll(/'(\/api\/[\w/-]+)'/g))
      found.add(route);
  found.delete('/api/events');
  // The owner's backup, which is the data as saved.
  found.delete('/api/export');
  return [...found];
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-boundary-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      runtime: new Runtime(),
      claudeRuntime: new Runtime(),
      startEngine: false,
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`,
    login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'X-StellarCortex-Client': '1' },
      body: JSON.stringify({ key: app.accessKey }),
    }),
    headers = {
      'X-StellarCortex-Client': '1',
      Cookie: login.headers.get('set-cookie')?.split(';')[0] || '',
    };
  return { app, base, headers };
}
test('error fields lose a stack, at any depth, and keep their shape', () => {
  const sent = JSON.parse(
    uiJson({
      jobs: [{ error: stack, text: 'kept' }],
      runtime: { connected: false, error: virsh },
      account: { usageError: stack, lastError: stack, reason: stack },
      messages: [
        { role: 'system', kind: 'error', text: stack },
        { role: 'assistant', text: stack },
      ],
      fine: { error: 'Choose a model first.' },
    }),
  );
  assert.doesNotMatch(JSON.stringify([sent.runtime, sent.account, sent.messages[0]]), raw);
  assert.doesNotMatch(sent.jobs[0].error, raw);
  assert.equal(sent.jobs[0].text, 'kept');
  assert.match(sent.messages[0].text, /not fully installed/);
  assert.match(sent.runtime.error, /A program on the server stopped/);
  assert.equal(sent.fine.error, 'Choose a model first.');
  // A bot may explain a stack to the owner. Its answer is not an error field.
  assert.equal(sent.messages[1].text, stack);
});
test('content that looks like a stack stays as written', () => {
  const tool = JSON.stringify({ command: 'cat src/server.mjs', aggregatedOutput: stack }),
    sent = JSON.parse(
      uiJson({
        messages: [{ role: 'tool', kind: 'commandExecution', status: 'completed', detail: tool }],
        approvals: [
          {
            kind: 'item/commandExecution/requestApproval',
            details: {
              reason: 'Command failed with permission denied, so I need write access',
              message: stack,
              error: stack,
              nested: { reason: stack, list: [{ error: stack }] },
            },
          },
        ],
        build: { message: stack },
      }),
    );
  assert.equal(sent.messages[0].detail, tool);
  const { details } = sent.approvals[0];
  assert.match(details.reason, /^Command failed with permission denied/);
  assert.equal(details.message, stack);
  assert.equal(details.error, stack);
  assert.equal(details.nested.reason, stack);
  assert.equal(details.nested.list[0].error, stack);
  assert.equal(sent.build.message, stack);
});
test('a real error beside approval details is still cleaned', () => {
  const sent = JSON.parse(uiJson({ approvals: [{ details: { error: stack } }], error: stack }));
  assert.equal(sent.approvals[0].details.error, stack);
  assert.doesNotMatch(sent.error, raw);
});
test('every saved error field a screen reads is on the list', () => {
  // These hold what a failed api() call said, and api() filters that.
  const local = /^(plain|form|new[A-Z]\w*|connections|claude|task|account)Error$|^onError$/,
    folder = new URL('../public/', import.meta.url),
    read = new Set();
  for (const name of fs.readdirSync(folder).filter(file => file.endsWith('.js')))
    for (const [, field] of fs
      .readFileSync(new URL(name, folder), 'utf8')
      .matchAll(/\.(\w*Error)\b/g))
      if (!local.test(field) && field !== 'Error') read.add(field);
  assert.deepEqual(
    [...read].filter(field => !ERROR_FIELDS.has(field)),
    [],
  );
});
test('a huge error of blank lines does not stall the server', () => {
  const started = performance.now();
  assert.equal(PROGRAM_OUTPUT.test('\n'.repeat(200000) + 'done'), false);
  assert.ok(performance.now() - started < 500);
});
test('the backup is the data as saved', async t => {
  const { app, base, headers } = await fixture(t),
    detail = JSON.stringify({ aggregatedOutput: stack }),
    chat = app.store.data.chats[0],
    at = new Date().toISOString();
  app.store.data.messages.push(
    { id: 'tool', chatId: chat.id, role: 'tool', kind: 'x', detail, createdAt: at },
    { id: 'failed', chatId: chat.id, role: 'system', kind: 'error', text: stack, createdAt: at },
  );
  app.store.data.jobs.push({ id: 'job', chatId: chat.id, status: 'failed', error: stack });
  app.store.data.routines.push({ id: 'r', name: 'r', webhookKey: 'hidden', lastError: stack });
  const response = await fetch(base + '/api/export', { headers }),
    backup = await response.json();
  assert.match(response.headers.get('content-disposition'), /stellarcortex-backup\.json/);
  assert.equal(backup.messages.find(m => m.id === 'tool').detail, detail);
  assert.equal(backup.messages.find(m => m.id === 'failed').text, stack);
  assert.equal(backup.jobs.find(job => job.id === 'job').error, stack);
  const routine = backup.routines.find(r => r.id === 'r');
  assert.equal(routine.lastError, stack);
  assert.equal(routine.webhookKey, undefined);
});
test('no UI response carries a stack that was saved or thrown', async t => {
  const { app, base, headers } = await fixture(t),
    chat = app.store.data.chats[0],
    at = new Date().toISOString();
  app.store.data.jobs.push({
    id: 'old-job',
    chatId: chat.id,
    botId: chat.botIds[0],
    status: 'failed',
    text: 'hello',
    error: stack,
    createdAt: at,
    completedAt: at,
  });
  app.store.data.messages.push({
    id: 'old-message',
    chatId: chat.id,
    role: 'system',
    kind: 'error',
    text: 'Codex is unavailable: ' + stack,
    createdAt: at,
  });
  app.store.data.routines.push({ id: 'old-routine', name: 'r', lastError: stack });
  app.store.save();
  const checked = [];
  for (const route of routes()) {
    const response = await fetch(base + route, {
      headers,
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (!response) continue;
    const text = await response.text();
    assert.doesNotMatch(text, raw, route);
    checked.push(route);
  }
  assert.ok(checked.includes('/api/state'));
  assert.ok(checked.length > 20, checked.join());
  const state = await (await fetch(base + '/api/state', { headers })).json();
  assert.match(state.jobs.find(job => job.id === 'old-job').error, /not fully installed/);
});
test('live events carry no stack either', async t => {
  const { app, base, headers } = await fixture(t),
    controller = new AbortController();
  t.after(() => controller.abort());
  const reader = (
    await fetch(base + '/api/events', { headers, signal: controller.signal })
  ).body.getReader();
  await reader.read();
  app.engine.emit('runtime', { provider: 'codex', connected: false, error: stack });
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /not fully installed/);
  assert.doesNotMatch(text, raw);
});
