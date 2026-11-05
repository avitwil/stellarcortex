import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  Claude,
  claudeModels,
  claudeModelsFromInitialization,
  claudePackageCommand,
  descendantPids,
} from '../src/claude.mjs';
import { SUDO_DENY_RULES } from '../src/elevation-policy.mjs';
import { createClaudeBridge, mcpContent } from '../src/claude-mcp.mjs';

const fake = fileURLToPath(new URL('./fixtures/claude-cli.mjs', import.meta.url));
const tools = [
  {
    name: 'stellarcortex_memory',
    description: 'Test',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
  },
];
function fixture(t, mode = 'normal') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-claude-test-')),
    log = path.join(dir, 'calls.jsonl');
  const runtime = new Claude({
    command: { bin: process.execPath, prefix: [fake] },
    environment: {
      ...process.env,
      STELLARCORTEX_FAKE_CLAUDE_MODE: mode,
      STELLARCORTEX_FAKE_CLAUDE_LOG: log,
    },
  });
  t.after(async () => {
    await runtime.stop();
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith('stellarcortex-claude-test-')
    )
      throw new Error('Invalid test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, dir, log };
}
const completion = runtime =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fake Claude timed out')), 10000);
    const listen = m => {
      if (m.method === 'turn/completed') {
        clearTimeout(timer);
        runtime.off('notification', listen);
        resolve(m.params.turn);
      }
    };
    runtime.on('notification', listen);
  });
async function run(
  runtime,
  dir,
  threadId,
  model = 'sonnet',
  claudePermissionMode = 'manual',
  executionBoundary = null,
) {
  const started = await runtime.request(threadId ? 'thread/resume' : 'thread/start', {
    threadId,
    cwd: dir,
    developerInstructions: 'StellarCortex instructions',
    model,
    dynamicTools: tools,
    claudePermissionMode,
    executionBoundary,
  });
  const done = completion(runtime);
  await runtime.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'Test' }],
    effort: 'low',
    serviceTier: 'default',
  });
  return { threadId: started.thread.id, result: await done };
}

test('Claude package discovery honors native .exe names on every OS and guards package paths', t => {
  const { dir } = fixture(t),
    pkg = path.join(dir, 'package');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  const binary = path.join(pkg, 'bin', 'claude.exe');
  fs.writeFileSync(binary, 'native executable');
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ bin: { claude: 'bin/claude.exe' } }),
  );
  assert.deepEqual(claudePackageCommand(pkg), { bin: binary, prefix: [] });
  const wrapper = path.join(pkg, 'wrapper.cjs');
  fs.writeFileSync(wrapper, '');
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ bin: { claude: 'wrapper.cjs' } }),
  );
  assert.deepEqual(claudePackageCommand(pkg), { bin: process.execPath, prefix: [wrapper] });
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(dir, 'outside.cjs'), '');
  fs.writeFileSync(
    path.join(empty, 'package.json'),
    JSON.stringify({ bin: { claude: '../outside.cjs' } }),
  );
  assert.equal(claudePackageCommand(empty), null);
  fs.writeFileSync(path.join(empty, 'cli.js'), '');
  assert.deepEqual(claudePackageCommand(empty), {
    bin: process.execPath,
    prefix: [path.join(empty, 'cli.js')],
  });
});
test('Claude auth exposes safe subscription fields and never accepts silent API billing', async t => {
  for (const mode of ['normal', 'api', 'noauth']) {
    const { runtime } = fixture(t, mode);
    const account = await runtime.request('account/read');
    assert.equal(account.account?.type, mode === 'normal' ? 'claude' : undefined);
    assert.equal(JSON.stringify(account).includes('must-never-escape'), false);
    if (mode !== 'normal') assert.ok(account.error);
  }
});
test('Claude stream is deduplicated, reports actual model, and resumes its own persisted session', async t => {
  const { runtime, dir, log } = fixture(t),
    events = [];
  runtime.on('notification', m => events.push(m));
  const first = await run(runtime, dir);
  assert.equal(first.result.status, 'completed');
  assert.equal(
    events.filter(m => m.method === 'item/completed' && m.params.item.type === 'agentMessage')
      .length,
    1,
  );
  assert.equal(
    events
      .filter(m => m.method === 'item/agentMessage/delta')
      .map(m => m.params.delta)
      .join(''),
    'Hello Claude',
  );
  assert.equal(
    events.find(m => m.method === 'thread/settingsUpdated').params.model,
    'claude-fake-model',
  );
  const second = await run(runtime, dir, first.threadId);
  assert.equal(second.result.status, 'completed');
  const pinned = await run(runtime, dir, first.threadId, 'claude-sonnet-5-5');
  assert.equal(pinned.result.status, 'completed');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].args.includes('--session-id'));
  assert.ok(calls[1].args.includes('--resume'));
  assert.equal(calls[2].args[calls[2].args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.ok(calls[0].args.includes('--restricted'));
  assert.equal(calls[0].args.includes('--dangerously-skip-permissions'), false);
  const { hooks, ...settings } = JSON.parse(calls[0].args[calls[0].args.indexOf('--settings') + 1]);
  assert.deepEqual(settings, {
    fastMode: false,
    permissions: { ask: ['Bash', 'Write', 'Edit'], deny: [...SUDO_DENY_RULES] },
  });
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash|Write|Edit|NotebookEdit');
});
test('Claude StellarCortex tools and native denied approvals round-trip through the per-turn MCP bridge', async t => {
  const { runtime, dir } = fixture(t, 'mcp'),
    requests = [];
  runtime.on('request', m => {
    requests.push(m);
    runtime.respond(
      m.id,
      m.method === 'item/tool/call'
        ? {
            success: true,
            contentItems: [
              { type: 'inputText', text: '[]' },
              { type: 'inputImage', imageUrl: 'data:image/png;base64,eA==' },
            ],
          }
        : { decision: 'decline' },
    );
  });
  const result = await run(runtime, dir);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(
    requests.map(m => m.method),
    ['item/commandExecution/requestApproval', 'item/tool/call'],
  );
  assert.equal(requests[1].params.tool, 'stellarcortex_memory');
});
test('Claude native elevation callback denies without a user prompt', async t => {
  const f = fixture(t, 'mcp-elevation'),
    requests = [];
  f.runtime.on('request', message => {
    requests.push(message);
    f.runtime.respond(
      message.id,
      message.method === 'item/tool/call'
        ? {
            success: true,
            contentItems: [
              { type: 'inputText', text: '[]' },
              { type: 'inputImage', imageUrl: 'data:image/png;base64,eA==' },
            ],
          }
        : { decision: 'accept' },
    );
  });
  assert.equal(
    (await run(f.runtime, f.dir, undefined, 'sonnet', 'automatic')).result.status,
    'completed',
  );
  assert.equal(
    requests.filter(message => message.method === 'item/commandExecution/requestApproval').length,
    0,
  );
});
test('Claude failures and cancellation terminate the task and release its bridge', async t => {
  const { runtime, dir } = fixture(t, 'fail');
  const failed = await run(runtime, dir);
  assert.equal(failed.result.status, 'failed');
  assert.match(
    failed.result.error.message,
    /^Claude Code exited \(\d+\)\. Details are in the server log\.$/,
  );
  assert.equal(runtime.turns.size, 0);
  const hanging = fixture(t, 'hang');
  const started = await hanging.runtime.request('thread/start', {
    cwd: hanging.dir,
    dynamicTools: tools,
  });
  const done = completion(hanging.runtime);
  const initialized = new Promise(resolve =>
    hanging.runtime.on('notification', m => {
      if (m.method === 'thread/settingsUpdated') resolve();
    }),
  );
  const turn = await hanging.runtime.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'Test' }],
  });
  await initialized;
  await hanging.runtime.request('turn/interrupt', {
    threadId: started.thread.id,
    turnId: turn.turn.id,
  });
  assert.equal((await done).status, 'interrupted');
  assert.equal(hanging.runtime.turns.size, 0);
});
test('Claude refuses missing authentication and unsupported speed before inference', async t => {
  const { runtime, dir, log } = fixture(t, 'noauth');
  const result = await run(runtime, dir);
  assert.equal(result.result.status, 'failed');
  assert.match(result.result.error.message, /Sign in/);
  assert.equal(fs.existsSync(log), false);
  const { runtime: connected, dir: cwd } = fixture(t);
  const started = await connected.request('thread/start', { cwd });
  await assert.rejects(
    connected.request('turn/start', { threadId: started.thread.id, serviceTier: 'priority' }),
    /Standard/,
  );
});

test('Claude uses auto on new and resumed turns; unavailable auto never retries or bypasses', async t => {
  const f = fixture(t);
  const first = await run(f.runtime, f.dir, undefined, 'sonnet', 'automatic');
  assert.equal(first.result.status, 'completed');
  await run(f.runtime, f.dir, first.threadId, 'sonnet', 'manual');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls[0].args[calls[0].args.indexOf('--permission-mode') + 1], 'auto');
  assert(calls[0].args.includes('--restricted'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--permission-mode') + 1], 'default');
  for (const mode of ['noauto', 'wrongmode']) {
    const unsupported = fixture(t, mode),
      result = await run(unsupported.runtime, unsupported.dir, undefined, 'sonnet', 'automatic');
    assert.equal(result.result.status, 'failed');
    const attempts = fs.readFileSync(unsupported.log, 'utf8').trim().split('\n');
    assert.equal(attempts.length, 1);
    assert(!attempts[0].includes('bypassPermissions'));
  }
  const blocked = fixture(t);
  assert.equal(
    (await run(blocked.runtime, blocked.dir, undefined, 'sonnet', 'free')).result.status,
    'failed',
  );
  assert.equal(fs.existsSync(blocked.log), false);
});
test('Claude catalog separates pinned versions from rolling aliases with per-model effort capabilities', () => {
  const models = claudeModels(),
    find = model => models.find(m => m.model === model);
  assert.deepEqual(
    models.filter(m => m.selectionKind === 'alias').map(m => m.model),
    ['opus', 'sonnet', 'haiku'],
  );
  assert.equal(models.filter(m => m.selectionKind === 'version').length, 11);
  assert.equal(find('claude-sonnet-5-5').displayName, 'Claude Sonnet 5.5');
  assert.equal(find('claude-haiku-4-5-20251001').version, '4.5');
  assert.deepEqual(
    find('claude-opus-4-6').supportedReasoningEfforts.map(e => e.reasoningEffort),
    ['low', 'medium', 'high', 'max'],
  );
  assert.deepEqual(find('claude-haiku-4-5-20251001').supportedReasoningEfforts, []);
  assert.deepEqual(find('default').supportedReasoningEfforts, []);
  assert.equal(
    models.some(m => /fable|mythos|sonnet-4-5/.test(m.model)),
    false,
  );
  for (const model of models) {
    assert.equal(model.availability, 'unverified');
    assert.deepEqual(model.serviceTiers, []);
    assert.equal(model.defaultReasoningEffort, null);
  }
});
test('Claude discovers resolved versions and actual effort caps without a user prompt or inference', async t => {
  const { runtime, log } = fixture(t);
  const catalog = await runtime.request('model/list');
  assert.equal(fs.existsSync(log), false);
  const sonnet = catalog.data.find(model => model.model === 'claude-sonnet-5-5');
  assert.equal(sonnet.displayName, 'Claude Sonnet 5.5');
  assert.equal(sonnet.selectionKind, 'version');
  assert.equal(sonnet.availability, 'cli-listed');
  assert.deepEqual(
    sonnet.supportedReasoningEfforts.map(e => e.reasoningEffort),
    ['low', 'medium', 'high'],
  );
  assert.equal(catalog.data.find(model => model.model === 'sonnet').resolvedModel, sonnet.model);
  assert.equal(
    catalog.data.some(model => /fable/.test(model.model)),
    false,
  );
  const creditDefault = claudeModelsFromInitialization([
    { value: 'default', resolvedModel: 'claude-fable-5-1' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
  ]);
  assert.equal(
    creditDefault.some(model => model.model === 'default'),
    false,
  );
  assert.throws(() => claudeModelsFromInitialization([]), /did not list/);
});
test('Claude native usage refresh caches safely, preserves stale errors, and clears another account', async t => {
  const { runtime, dir } = fixture(t),
    usageLog = path.join(dir, 'usage.log');
  runtime.environment.STELLARCORTEX_FAKE_CLAUDE_USAGE_LOG = usageLog;
  const first = await runtime.request('account/rateLimits/read');
  assert.equal(first.rateLimitsByLimitId.five_hour.primary.usedPercent, 2);
  assert.equal(first.stale, false);
  await runtime.request('account/rateLimits/read');
  assert.equal(fs.readFileSync(usageLog, 'utf8').trim().split('\n').length, 1);
  await runtime.request('account/rateLimits/read', { force: true });
  assert.equal(fs.readFileSync(usageLog, 'utf8').trim().split('\n').length, 2);
  runtime.environment.STELLARCORTEX_FAKE_CLAUDE_MODE = 'usagefail';
  const stale = await runtime.request('account/rateLimits/read', { force: true });
  assert.equal(stale.rateLimitsByLimitId.five_hour.primary.usedPercent, 2);
  assert.equal(stale.stale, true);
  assert.ok(stale.error);
  runtime.environment.STELLARCORTEX_FAKE_CLAUDE_EMAIL = 'different@example.test';
  const changed = await runtime.request('account/rateLimits/read', { force: true });
  assert.equal(changed.available, false);
  assert.deepEqual(changed.rateLimitsByLimitId, {});
});
test('Claude keeps persisted quota only after its account fingerprint matches the current login', async t => {
  const source = fixture(t);
  const saved = await source.runtime.request('account/rateLimits/read');
  assert.match(saved.accountKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(saved).includes('test@example.test'), false);
  const same = fixture(t, 'usagefail');
  same.runtime.hydrateUsage(saved);
  assert.equal(same.runtime.usage, null);
  const stale = await same.runtime.request('account/rateLimits/read');
  assert.equal(stale.rateLimitsByLimitId.five_hour.primary.usedPercent, 2);
  assert.equal(stale.stale, true);
  const changed = fixture(t, 'usagefail');
  changed.runtime.environment.STELLARCORTEX_FAKE_CLAUDE_EMAIL = 'different@example.test';
  changed.runtime.hydrateUsage(saved);
  const events = [];
  changed.runtime.on('notification', event => events.push(event));
  const cleared = await changed.runtime.request('account/rateLimits/read');
  assert.equal(cleared.available, false);
  assert.equal(events[0].params.usage.reset, true);
  assert.notEqual(events[0].params.usage.accountKey, saved.accountKey);
});
test('Claude runtime forwards official rate limit events without confusing token totals for quota', t => {
  const { runtime } = fixture(t),
    events = [];
  runtime.on('notification', event => events.push(event));
  runtime.handle(
    { id: 'thread' },
    { closed: false },
    {
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.02, status: 'allowed' },
    },
  );
  assert.equal(events[0].method, 'account/rateLimits/updated');
  assert.equal(events[0].params.usage.rateLimitsByLimitId.five_hour.primary.usedPercent, 2);
});
test('Claude MCP bridge rejects unauthorized browsers and unknown tools, and preserves image output', async () => {
  const bridge = await createClaudeBridge({
    tools,
    call: async () => ({ success: true, contentItems: [] }),
    approve: async () => false,
  });
  try {
    const config = bridge.config.mcpServers.stellarcortex;
    assert.equal((await fetch(config.url, { method: 'POST' })).status, 401);
    assert.equal(
      (
        await fetch(config.url, {
          method: 'POST',
          headers: { ...config.headers, Origin: 'https://example.test' },
        })
      ).status,
      403,
    );
    const response = await fetch(config.url, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'missing' },
      }),
    });
    assert.match((await response.json()).error.message, /Unknown/);
    assert.deepEqual(mcpContent([{ type: 'inputImage', imageUrl: 'data:image/png;base64,eA==' }]), [
      { type: 'image', mimeType: 'image/png', data: 'eA==' },
    ]);
  } finally {
    await bridge.close();
  }
});

test('thinking stream index and compact final text index refer to the same stable text item', async t => {
  const { runtime, dir } = fixture(t, 'thinking'),
    events = [];
  runtime.on('notification', m => events.push(m));
  await run(runtime, dir);
  const completed = events.filter(
    m => m.method === 'item/completed' && m.params.item.type === 'agentMessage',
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].params.item.id, 'msg-test:text:0');
  assert.equal(completed[0].params.item.text, 'Hello Claude');
  assert(
    events
      .filter(m => m.method === 'item/agentMessage/delta')
      .every(m => m.params.itemId === completed[0].params.item.id),
  );
});

for (const boundary of ['qemu-kvm-ubuntu-desktop', 'no-computer'])
  test(`guest Claude adapter (${boundary}) has no native tools/hooks and denies native callbacks`, async t => {
    const f = fixture(t, 'mcp-elevation'),
      requests = [];
    f.runtime.on('request', message => {
      requests.push(message);
      f.runtime.respond(
        message.id,
        message.method === 'item/tool/call'
          ? {
              success: true,
              contentItems: [
                { type: 'inputText', text: '[]' },
                { type: 'inputImage', imageUrl: 'data:image/png;base64,eA==' },
              ],
            }
          : { decision: 'accept' },
      );
    });
    const result = await run(f.runtime, f.dir, undefined, 'sonnet', 'automatic', boundary);
    assert.equal(result.result.status, 'completed');
    const call = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse)[0];
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert(call.args.includes('--restricted'));
    assert(call.args.includes('--strict-mcp-config'));
    assert(call.args.includes('--disable-slash-commands'));
    assert.equal(JSON.parse(call.args[call.args.indexOf('--settings') + 1]).disableAllHooks, true);
    assert.equal(requests.filter(r => r.method !== 'item/tool/call').length, 0);
    assert.equal(requests.filter(r => r.method === 'item/tool/call').length, 1);
  });
const procStat = (dir, pid, parent, start) =>
  fs.writeFileSync(
    path.join(dir, String(pid), 'stat'),
    `${pid} (odd) name) ${['S', parent, pid, pid, ...Array(15).fill(0), start, 0].join(' ')}`,
  );
function procFixture(t, parents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [pid, parent] of Object.entries(parents)) {
    fs.mkdirSync(path.join(dir, pid));
    procStat(dir, pid, parent, `${pid}00`);
  }
  fs.mkdirSync(path.join(dir, 'sys'));
  return dir;
}
function asLinux(t, fn) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'),
    sent = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    sent.push([pid, signal]);
    return true;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  return Promise.resolve()
    .then(() => fn(sent))
    .finally(() => Object.defineProperty(process, 'platform', platform));
}
test('the process tree is read to any depth and leaves out other processes', t => {
  const proc = procFixture(t, { 10: 1, 20: 10, 30: 20, 40: 20, 50: 1 });
  assert.deepEqual(descendantPids(10, proc).sort(), [20, 30, 40]);
  assert.deepEqual(descendantPids(50, proc), []);
  assert.deepEqual(descendantPids(10, path.join(proc, 'missing')), []);
});
test('on Linux Stop signals the CLI group and every descendant, then kills what ignored it when the CLI closes', t =>
  asLinux(t, async sent => {
    const child = Object.assign(new EventEmitter(), {
        pid: 10,
        exitCode: null,
        signalCode: null,
        kill() {},
      }),
      runtime = new Claude({ procDir: procFixture(t, { 10: 1, 20: 10, 30: 20, 50: 1 }) });
    const stopped = runtime.kill({ child });
    child.emit('close');
    await stopped;
    assert.deepEqual(sent.map(([pid, signal]) => `${signal} ${pid}`).sort(), [
      'SIGKILL -10',
      'SIGKILL 20',
      'SIGKILL 30',
      'SIGTERM -10',
      'SIGTERM 20',
      'SIGTERM 30',
    ]);
    assert.deepEqual(
      sent.slice(0, 3).map(([, signal]) => signal),
      ['SIGTERM', 'SIGTERM', 'SIGTERM'],
    );
  }));
test('a torn process list with a loop does not hang the walk', t => {
  assert.deepEqual(descendantPids(10, procFixture(t, { 10: 30, 20: 10, 30: 20 })).sort(), [20, 30]);
});
test('on Linux a saved PID that now belongs to another process gets no SIGKILL', t =>
  asLinux(t, async sent => {
    const proc = procFixture(t, { 10: 1, 20: 10, 30: 10 }),
      child = Object.assign(new EventEmitter(), {
        pid: 10,
        exitCode: null,
        signalCode: null,
        kill() {},
      }),
      runtime = new Claude({ procDir: proc });
    const stopped = runtime.kill({ child });
    procStat(proc, 10, 1, '999');
    procStat(proc, 20, 1, '999');
    child.emit('close');
    await stopped;
    assert.deepEqual(sent.map(([pid, signal]) => `${signal} ${pid}`).sort(), [
      'SIGKILL 30',
      'SIGTERM -10',
      'SIGTERM 20',
      'SIGTERM 30',
    ]);
  }));
test('on Linux a descendant holding the output open is still killed after the wait', t =>
  asLinux(t, async sent => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = Object.assign(new EventEmitter(), {
        pid: 10,
        exitCode: null,
        signalCode: null,
        kill() {},
      }),
      runtime = new Claude({ procDir: procFixture(t, { 10: 1, 20: 10 }) });
    const stopped = runtime.kill({ child });
    child.exitCode = 0;
    t.mock.timers.tick(2000);
    await stopped;
    assert.deepEqual(
      sent.map(([pid, signal]) => `${signal} ${pid}`),
      ['SIGTERM -10', 'SIGTERM 20', 'SIGKILL -10', 'SIGKILL 20'],
    );
  }));
// Real signals, so this one needs Linux.
test(
  'Stop ends a real CLI and its descendants, even ones in their own group that ignore SIGTERM',
  { skip: process.platform !== 'linux' },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-tree-')),
      script = path.join(dir, 'cli.mjs');
    let pids = [];
    const running = pid => {
      try {
        return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'latin1'));
      } catch {
        return false;
      }
    };
    t.after(() => {
      for (const pid of pids)
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
    fs.writeFileSync(
      script,
      `import {spawn} from 'node:child_process';
const stubborn="process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",start=detached=>spawn(process.execPath,['-e',stubborn],{detached,stdio:'ignore'}).pid;
console.log(JSON.stringify([start(true),start(false)]));setInterval(()=>{},1000);
`,
    );
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    pids = await new Promise(resolve =>
      child.stdout.once('data', data => resolve(JSON.parse(data.toString()))),
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(pids.map(running), [true, true]);
    await new Claude().kill({ child });
    for (let tries = 0; tries < 40 && pids.some(running); tries++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pids.map(running), [false, false]);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  },
);
test('a Claude login the service cannot see shows as not connected, and the next read after signing in finds it', async () => {
  const claude = new Claude();
  let signedIn = false;
  claude.account = async () => (signedIn ? { account: { type: 'claude' } } : { account: null });
  assert.equal((await claude.request('account/read', { cached: true })).account, null);
  signedIn = true;
  assert.equal(
    (await claude.request('account/read', { cached: true })).account.type,
    'claude',
    'no answer of "not connected" is kept',
  );
});
