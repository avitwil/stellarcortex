import test from 'node:test';
import assert from 'node:assert/strict';
import { codexGuestParams, denyNativeGuestRequest } from '../src/codex-guest-policy.mjs';
import { Engine } from '../src/engine.mjs';
test('Codex guest policy removes native shell/browser/image paths and writable host roots', () => {
  const p = codexGuestParams({
    sandbox: 'workspace-write',
    config: { 'features.shell_tool': true },
    runtimeWorkspaceRoots: ['/host'],
  });
  assert.equal(p.sandbox, 'read-only');
  assert.equal(p.config['features.shell_tool'], false);
  assert.equal(p.config['tools.view_image'], false);
  assert.deepEqual(p.runtimeWorkspaceRoots, []);
  assert.deepEqual(p.environments, []);
  assert.equal(denyNativeGuestRequest('item/tool/call'), false);
});
test('guest native Codex approvals cannot be approved even by owner; dynamic tools stay separate', async () => {
  const replies = [],
    runtime = { respond: (id, result) => replies.push(result) };
  const receiver = {
    store: { bot: () => ({}) },
    computerOf: () => 'vm',
    runtimeFor: () => runtime,
    findJob: () => ({ botId: 'b' }),
    approval: () => {
      throw Error('Must not request host approval');
    },
  };
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
  ])
    await Engine.prototype.request.call(
      receiver,
      { id: 1, method, params: { threadId: 't' } },
      'codex',
    );
  assert.deepEqual(replies, [
    { decision: 'decline' },
    { decision: 'decline' },
    { permissions: {}, scope: 'turn' },
    { action: 'decline', content: null },
  ]);
});
