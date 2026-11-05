import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { GuestExecution } from '../src/guest-execution.mjs';
class Fake extends EventEmitter {
  ready = false;
  stop() {}
}
const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-guest-engine-')),
    store = new Store(dir),
    calls = [],
    rpc = {
      generation: 'test-epoch',
      call: async (method, botId, args) => {
        calls.push({ method, botId, args });
        return { ok: true, stdout: 'injected fake guest result', exitCode: 0 };
      },
    },
    guest = new GuestExecution(rpc, { enabled: true, providerIsolation: {} }),
    engine = new Engine(store, new Fake(), { close: async () => {} }, null, {
      guestExecution: guest,
      defaultVm: true,
    }),
    job = { id: 'fake-job', botId: store.data.bots[0].id, chatId: store.data.chats[0].id };
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, calls, guest, engine, job };
};
test('unverified native provider can chat, but no tool call reaches the computer or the host', async t => {
  const f = setup(t),
    [reply] = await f.engine.tool(f.job, 'stellarcortex_shell', { command: 'node', args: [] });
  const result = JSON.parse(reply.text);
  assert.equal(result.computerReady, false);
  assert.match(result.status, /no host fallback/);
  assert.equal(f.calls.length, 0);
  assert.doesNotThrow(() => f.engine.enqueue(f.job.chatId, 'Hello'));
});
test('guest shell/files keep existing approvals and route only through guest RPC after approval', async t => {
  const f = setup(t);
  f.guest.providerIsolation.codex = true;
  f.engine.approval = async () => ({ approve: false });
  await assert.rejects(
    f.engine.tool(f.job, 'stellarcortex_shell', { command: 'fake', args: [] }),
    /declined/,
  );
  assert.equal(f.calls.filter(c => c.method !== 'execution.ping').length, 0);
  f.engine.approval = async () => ({ approve: true });
  await f.engine.tool(f.job, 'stellarcortex_shell', {
    command: 'fake',
    args: ['not a real process'],
  });
  await f.engine.tool(f.job, 'stellarcortex_files', {
    action: 'write',
    path: 'fixture.txt',
    text: 'safe synthetic text',
  });
  assert.deepEqual(
    f.calls.map(c => c.method).filter(m => m !== 'execution.ping'),
    ['shell.run', 'files.inspect', 'files.write'],
  );
  await assert.rejects(
    f.engine.tool(f.job, 'stellarcortex_artifact', {
      path: 'host-file',
      title: 'No such guest file',
    }),
    /not found/,
  );
  assert(!fs.existsSync(path.join(f.store.dir, 'workspace', 'fixture.txt')));
});

test('guest model tool descriptions and command budgets refer to guest capabilities rather than host sudo', async () => {
  const { toolsForExecution, TOOLS } = await import('../src/engine.mjs');
  const guest = toolsForExecution(true);
  assert.match(guest.find(t => t.name === 'stellarcortex_shell').description, /INSIDE/);
  assert.equal(
    guest.find(t => t.name === 'stellarcortex_shell').inputSchema.properties.timeoutMs.maximum,
    300000,
  );
  assert.equal(
    TOOLS.find(t => t.name === 'stellarcortex_shell').inputSchema.properties.timeoutMs.maximum,
    60000,
  );
});

test('agent computer status carries the job identity into guest RPC', async t => {
  const f = setup(t);
  f.guest.providerIsolation.codex = true;
  await f.engine.tool(f.job, 'stellarcortex_computer', { action: 'status' });
  assert.deepEqual(
    f.calls
      .filter(c => c.method !== 'execution.ping')
      .map(({ method, botId }) => ({ method, botId })),
    [{ method: 'desktop.status', botId: f.job.botId }],
  );
});
test('global desktop status never dispatches an identity-less guest request', async t => {
  const f = setup(t);
  const status = await f.guest.desktop.status();
  assert.equal(status.state, 'unselected');
  assert.equal(status.available, false);
  assert.equal(f.calls.length, 0);
});
test('uncertain effects stop computer tools with the actual blocker, not the chat, and keep provider verification', async t => {
  const f = setup(t);
  f.guest.providerIsolation.codex = true;
  f.guest.rpc.uncertain = new Set(['unknown-effect']);
  const [reply] = await f.engine.tool(f.job, 'stellarcortex_shell', { command: 'fake', args: [] });
  assert.match(JSON.parse(reply.text).status, /Guest effects require explicit review/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.guest.providerIsolation.codex, true);
  assert.doesNotThrow(() => f.engine.enqueue(f.job.chatId, 'Hello'));
});
test('admission uses verified capability for every provider without a name-based exclusion', t => {
  const f = setup(t);
  for (const provider of [
    'codex',
    'claude',
    'openai-api',
    'anthropic-api',
    'local',
    'custom-fixture',
  ]) {
    f.guest.providerIsolation[provider] = true;
    assert.doesNotThrow(() => f.guest.assertReady(provider));
    f.guest.providerIsolation[provider] = false;
    assert.throws(() => f.guest.assertReady(provider), /no host fallback/);
  }
});

test('original tool dispatcher persists guest request correlation in app audit', async t => {
  const f = setup(t);
  let reply;
  f.engine.findJob = () => f.job;
  f.engine.runtimeFor = () => ({
    respond: (id, result) => {
      reply = result;
    },
  });
  f.engine.tool = async () => {
    throw Object.assign(Error('Guest effect requires reconciliation'), {
      guestRequestId: 'guest-request-fixture',
      guestMethod: 'browser.action',
      guestBotId: f.job.botId,
      guestSubmitted: true,
    });
  };
  await f.engine.request({
    id: 'provider-call-fixture',
    method: 'item/tool/call',
    params: { tool: 'stellarcortex_browser', arguments: { action: 'open', url: 'about:blank' } },
  });
  assert.equal(reply.success, false);
  const saved = JSON.parse(fs.readFileSync(path.join(f.store.dir, 'state.json'))).messages.find(
    m => m.kind === 'guestToolFailure',
  );
  assert.equal(saved.jobId, f.job.id);
  assert.deepEqual(JSON.parse(saved.detail), {
    tool: 'stellarcortex_browser',
    toolCallId: 'provider-call-fixture',
    requestId: 'guest-request-fixture',
    method: 'browser.action',
    botId: f.job.botId,
    submitted: true,
    error: 'Guest effect requires reconciliation',
  });
});

test('invalid browser URL is rejected before any guest RPC is submitted', async t => {
  const f = setup(t);
  await assert.rejects(
    f.guest.browser.action(f.job.botId, { action: 'open', url: 'file:///etc/passwd' }),
    /public HTTP/,
  );
  assert.equal(f.calls.length, 0);
  await f.guest.browser.action(f.job.botId, { action: 'open', url: 'about:blank' });
  assert.equal(f.calls[0].method, 'browser.action');
});

test('reading a taught skill supplies the reviewed action outline without executing it or crossing bot scope', async t => {
  const f = setup(t);
  f.store.data.skills.push({
    id: 'taught-actions',
    botId: f.job.botId,
    name: 'Scroll and return',
    instructions: 'Inspect current page, scroll once, then return.',
    frameIds: [],
    demonstration: {
      format: 'safe-action-outline-v1',
      mode: 'desktop',
      objective: 'Inspect lower page',
      steps: [
        { action: 'scroll', amount: 120 },
        { action: 'key', key: 'Control+Home' },
      ],
    },
  });
  const result = await f.engine.tool(f.job, 'stellarcortex_skill', {
    action: 'read',
    skillId: 'taught-actions',
  });
  assert.match(JSON.stringify(result), /safe-action-outline-v1/);
  assert.match(JSON.stringify(result), /Control\+Home/);
  assert.equal(f.calls.length, 0);
  f.store.data.bots.push({ ...f.store.data.bots[0], id: 'other-fixture' });
  await assert.rejects(
    f.engine.tool({ ...f.job, botId: 'other-fixture' }, 'stellarcortex_skill', {
      action: 'read',
      skillId: 'taught-actions',
    }),
    /not available/,
  );
});
