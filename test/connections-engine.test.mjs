import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine, TOOLS, TOOLS_VERSION } from '../src/engine.mjs';

const until = async check => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Connection test timed out');
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-connections-engine-')),
    store = new Store(dir),
    runtime = new EventEmitter();
  runtime.stop = async () => {};
  const connections = {
      mcp: {
        id: 'mcp',
        name: 'External MCP',
        kind: 'mcp',
        revision: 'one',
        connected: true,
        secret: 'never-model',
      },
      google: { id: 'google', name: 'Google', kind: 'google', revision: 'one', connected: true },
    },
    calls = [];
  const manager = {
    list: () => Object.values(connections),
    getPublic: id => {
      if (!connections[id]) throw new Error('Unknown connection');
      return connections[id];
    },
    listTools: async id => ({
      revision: connections[id].revision,
      tools: [
        {
          name: 'read',
          description: 'Read a resource',
          annotations: { readOnlyHint: true },
          inputSchema: { type: 'object' },
        },
        { name: 'write', description: 'Update a resource', inputSchema: { type: 'object' } },
      ],
    }),
    requiresApproval: async (_id, name) => name !== 'read',
    callTool: async (id, name, args, options) => {
      calls.push({ id, name, args, options });
      return {
        content: [
          { type: 'text', text: 'External result' },
          { type: 'image', mimeType: 'image/png', data: 'eA==' },
        ],
        structuredContent: { ok: true },
      };
    },
  };
  const engine = new Engine(store, runtime, { close: async () => {} }, null, {
      connections: manager,
    }),
    job = {
      id: 'manual-tool-job',
      botId: store.data.bots[0].id,
      chatId: store.data.chats[0].id,
      status: 'running',
      provider: 'codex',
    };
  store.data.jobs.push(job);
  engine.active.set(job.id, job);
  t.after(async () => {
    await engine.close();
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith('stellarcortex-connections-engine-')
    )
      throw new Error('Unsafe test cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, engine, manager, connections, calls, job };
}
const approve = async (f, allow) => {
  await until(() => f.store.data.approvals.some(a => a.status === 'pending'));
  const approval = f.store.data.approvals.findLast(a => a.status === 'pending');
  f.engine.resolveApproval(approval.id, { approve: allow });
  return approval;
};
test('all model providers receive a fixed connector discovery tool without exposing credentials or trusting MCP annotations', async t => {
  const f = fixture(t);
  assert.ok(TOOLS.some(tool => tool.name === 'stellarcortex_connections'));
  assert.match(TOOLS_VERSION, /v13-computer-modes-secret$/);
  const list = JSON.parse(
    (await f.engine.tool(f.job, 'stellarcortex_connections', { action: 'list' }))[0].text,
  );
  assert.equal(list.connections.length, 2);
  assert.equal(JSON.stringify(list).includes('never-model'), false);
  const schemas = JSON.parse(
    (
      await f.engine.tool(f.job, 'stellarcortex_connections', {
        action: 'tools',
        connectionId: 'mcp',
      })
    )[0].text,
  );
  assert.equal(schemas.tools[0].inputSchema.type, 'object');
  assert.equal(f.calls.length, 0);
  for (const provider of [
    'codex',
    'claude',
    'openai-api',
    'anthropic-api',
    'local',
    'custom-test',
  ]) {
    f.job.provider = provider;
    const pending = f.engine.tool(f.job, 'stellarcortex_connections', {
      action: 'call',
      connectionId: 'mcp',
      toolName: 'read',
      arguments: { provider },
    });
    await approve(f, true);
    const result = await pending;
    assert.ok(result.some(item => item.type === 'inputImage'));
    assert.match(result[0].text, /External source data/);
  }
  assert.equal(f.calls.length, 6);
  assert.ok(f.calls.every(call => call.options.expectedRevision === 'one'));
  assert.equal(f.store.data.approvals.length, 6);
});
test('exact arguments are snapshotted, denial performs no action, and trusted built-in reads alone can skip approval', async t => {
  const f = fixture(t),
    args = { text: 'Approved text' },
    pending = f.engine.tool(f.job, 'stellarcortex_connections', {
      action: 'call',
      connectionId: 'mcp',
      toolName: 'write',
      arguments: args,
    });
  await until(() => f.store.data.approvals.length === 1);
  args.text = 'Changed after review';
  await approve(f, true);
  await pending;
  assert.equal(f.calls[0].args.text, 'Approved text');
  const denied = f.engine.tool(f.job, 'stellarcortex_connections', {
      action: 'call',
      connectionId: 'mcp',
      toolName: 'write',
    }),
    rejection = assert.rejects(denied, /declined/);
  await approve(f, false);
  await rejection;
  assert.equal(f.calls.length, 1);
  await f.engine.tool(f.job, 'stellarcortex_connections', {
    action: 'call',
    connectionId: 'google',
    toolName: 'read',
  });
  assert.equal(f.store.data.approvals.length, 2);
  assert.equal(f.calls.length, 2);
  const write = f.engine.tool(f.job, 'stellarcortex_connections', {
    action: 'call',
    connectionId: 'google',
    toolName: 'write',
  });
  await approve(f, true);
  await write;
  assert.equal(f.store.data.approvals.length, 3);
});
test('changing connection revision while waiting invalidates approval before execution', async t => {
  const f = fixture(t),
    pending = f.engine.tool(f.job, 'stellarcortex_connections', {
      action: 'call',
      connectionId: 'mcp',
      toolName: 'write',
    }),
    rejected = assert.rejects(pending, /changed after review/);
  await until(() => f.store.data.approvals.length === 1);
  f.connections.mcp.revision = 'two';
  await approve(f, true);
  await rejected;
  assert.equal(f.calls.length, 0);
});
test('cancelling an approved external call aborts its transport and records interruption', async t => {
  const f = fixture(t);
  f.manager.callTool = async (id, name, args, options) => {
    f.calls.push({ options });
    return new Promise((resolve, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
    );
  };
  const pending = f.engine.tool(f.job, 'stellarcortex_connections', {
      action: 'call',
      connectionId: 'mcp',
      toolName: 'write',
    }),
    rejected = assert.rejects(pending, /stopped/);
  await approve(f, true);
  await until(() => f.calls.length === 1);
  await f.engine.cancel(f.job.id);
  await rejected;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.engine.externalCalls.size, 0);
  assert.equal(f.store.data.messages.findLast(m => m.kind === 'mcpToolCall').status, 'interrupted');
});
test('the elevation rule does not disconnect or strip existing MCP tools; their original explicit approvals still apply', async t => {
  const f = fixture(t);
  const pending = f.engine.tool(f.job, 'stellarcortex_connections', {
    action: 'call',
    connectionId: 'mcp',
    toolName: 'write',
    arguments: { command: 'sudo fixture-text-only' },
  });
  await approve(f, true);
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.command, 'sudo fixture-text-only');
  assert.equal(f.connections.mcp.connected, true);
});
