import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import {
  permissionMode,
  resolveClaudePermission,
  claudePermissionArgs,
  setClaudePermission,
  CLAUDE_PERMISSION_MODES,
} from '../src/claude-permissions.mjs';

test('documented mappings keep automatic distinct from bypass and preserve restricted boundary', () => {
  assert.deepEqual(CLAUDE_PERMISSION_MODES, {
    manual: 'default',
    automatic: 'auto',
    free: 'bypassPermissions',
  });
  assert.equal(resolveClaudePermission().cliMode, 'default');
  assert.equal(claudePermissionArgs('automatic')[1], 'auto');
  assert.equal(JSON.parse(claudePermissionArgs('automatic')[3]).permissions.ask, undefined);
  assert.deepEqual(JSON.parse(claudePermissionArgs('manual')[3]).permissions.ask, [
    'Bash',
    'Write',
    'Edit',
  ]);
  assert.throws(() => claudePermissionArgs('free'), /restricted/);
  assert.throws(() => permissionMode('bypass'), /Unknown/);
});
test('migration, independent overrides, dangerous confirmation and restart persistence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-permission-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert(path.basename(dir).startsWith('stellar-permission-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let store = new Store(dir);
  delete store.data.settings.claudePermissionMode;
  store.save();
  store = new Store(dir);
  assert.equal(store.data.settings.claudePermissionMode, 'manual');
  const a = store.createBot({ name: 'A', provider: 'claude' }).bot,
    b = store.createBot({ name: 'B', provider: 'claude' }).bot;
  setClaudePermission(store, { mode: 'automatic' });
  setClaudePermission(store, { botId: a.id, mode: 'manual' });
  assert.equal(resolveClaudePermission(a, store.data.settings).mode, 'manual');
  assert.equal(resolveClaudePermission(b, store.data.settings).mode, 'automatic');
  assert.throws(() => setClaudePermission(store, { botId: a.id, mode: 'free' }), /confirmation/);
  assert.equal(a.claudePermissionMode, 'manual');
  setClaudePermission(store, { botId: a.id, mode: 'free', confirmDangerous: true });
  assert.equal(resolveClaudePermission(a, store.data.settings).available, false);
  store = new Store(dir);
  assert.equal(store.bot(a.id).claudePermissionMode, 'free');
  assert.equal(store.bot(b.id).claudePermissionMode, undefined);
  assert.equal(store.botTemplate(a.id).bot.claudePermissionMode, undefined);
  const imported = store.createBot({
    name: 'Imported',
    provider: 'claude',
    claudePermissionMode: 'free',
    confirmDangerous: true,
  }).bot;
  assert.equal(imported.claudePermissionMode, undefined);
  store.updateBot(b.id, { claudePermissionMode: 'free', confirmDangerous: true });
  assert.equal(store.bot(b.id).claudePermissionMode, undefined);
  setClaudePermission(store, { mode: 'free', confirmDangerous: true });
  assert.throws(() => setClaudePermission(store, { botId: a.id, mode: 'inherit' }), /confirmation/);
  setClaudePermission(store, { botId: a.id, mode: 'inherit', confirmDangerous: true });
  assert.equal(store.bot(a.id).claudePermissionMode, null);
  store.data.jobs.push({ botId: a.id, status: 'waiting' });
  assert.throws(() => setClaudePermission(store, { mode: 'manual' }), /work/);
  assert.throws(() => setClaudePermission(store, { botId: a.id, mode: 'manual' }), /work/);
  setClaudePermission(store, { botId: b.id, mode: 'manual' });
  assert.equal(store.bot(b.id).claudePermissionMode, 'manual');
});
