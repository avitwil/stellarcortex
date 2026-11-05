import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine, TOOLS, toolsForExecution } from '../src/engine.mjs';
import {
  ELEVATION_POLICY,
  SUDO_DENY_RULES,
  recognizedElevation,
} from '../src/elevation-policy.mjs';
import { claudePermissionArgs } from '../src/claude-permissions.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-elevation-')),
    store = new Store(dir),
    runtime = new EventEmitter();
  runtime.stop = async () => {};
  runtime.responses = [];
  runtime.respond = (id, result) => runtime.responses.push({ id, result });
  runtime.reject = () => {};
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const engine = new Engine(store, runtime, { close: async () => {} });
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const job = {
    id: 'job',
    botId: store.data.bots[0].id,
    chatId: store.data.chats[0].id,
    status: 'running',
    provider: 'codex',
    threadId: 'thread',
  };
  store.data.jobs.push(job);
  engine.active.set(job.id, job);
  return { dir, store, runtime, engine, job };
}
test('no bot has a sudo tool, on the host or in a guest', () => {
  for (const tools of [TOOLS, toolsForExecution(false), toolsForExecution(true)])
    assert.equal(
      tools.some(tool => /sudo/.test(tool.name)),
      false,
    );
});
test('recognized elevation is refused on the shell tool before any approval, for every bot', async t => {
  const f = fixture(t);
  f.store.data.bots[0].computer = 'host';
  for (const [command, args] of [
    ['sudo', ['id']],
    ['/usr/bin/sudo', ['id']],
    ['su', ['-']],
    ['pkexec', ['id']],
    ['doas', ['id']],
    ['bash', ['-c', 'sudo id']],
  ])
    await assert.rejects(
      f.engine.tool(f.job, 'stellarcortex_shell', { command, args }),
      /elevation command denied/,
      command,
    );
  assert.equal(f.store.data.approvals.length, 0);
  assert.equal(recognizedElevation('node', ['--version']), false);
});
test('native elevation requests are declined without a prompt', async t => {
  const f = fixture(t);
  await f.engine.request({
    id: 'native',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', command: 'sudo id' },
  });
  assert.deepEqual(f.runtime.responses, [{ id: 'native', result: { decision: 'decline' } }]);
  assert.equal(f.store.data.approvals.length, 0);
});
test('Claude always gets the deny rules, in every mode', () => {
  const settings = args => JSON.parse(args[args.indexOf('--settings') + 1]);
  for (const mode of ['manual', 'automatic'])
    assert.deepEqual(settings(claudePermissionArgs(mode)).permissions.deny, [...SUDO_DENY_RULES]);
});
test('saved sudo settings are dropped on load', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-elevation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.data.settings.sudoMode = 'full';
  store.data.bots[0].sudoMode = 'full';
  store.save();
  const loaded = new Store(dir);
  assert.equal('sudoMode' in loaded.data.settings, false);
  assert.equal('sudoMode' in loaded.data.bots[0], false);
});
test('the policy line says elevation is not permitted', () => {
  assert.match(ELEVATION_POLICY, /not permitted/);
});
