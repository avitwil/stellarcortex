import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { createApp } from '../src/server.mjs';
import { botComputerAccess } from '../src/environment-computer.mjs';
import { GuestExecution } from '../src/guest-execution.mjs';
import { setComputerMode } from '../src/computer-mode.mjs';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';

class Runtime extends EventEmitter {
  constructor(provider = 'codex') {
    super();
    this.provider = provider;
    this.ready = true;
    this.calls = [];
    this.responses = [];
    this.threads = 0;
    this.turns = 0;
    this.onTurn = async () => ({ text: 'done' });
  }
  async start() {}
  async stop() {}
  respond(id, result) {
    this.responses.push({ id, result });
  }
  reject() {}
  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'account/read')
      return {
        account: {
          type: { codex: 'chatgpt', claude: 'claude', 'openai-api': 'api' }[this.provider],
        },
      };
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'model-a',
            model: 'model-a',
            isDefault: true,
            defaultReasoningEffort: null,
            supportedReasoningEfforts: [],
            serviceTiers: [],
          },
        ],
        nextCursor: null,
      };
    if (method === 'config/read') return { config: { model: 'model-a' } };
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: params.threadId || `${this.provider}-${this.calls.length}` },
        model: 'model-a',
        reasoningEffort: null,
        serviceTier: null,
      };
    if (method === 'turn/start') {
      const turnId = `turn-${++this.turns}`;
      setTimeout(async () => {
        const output = await this.onTurn(params, turnId);
        if (output?.hold) return;
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId: params.threadId,
            item: { type: 'agentMessage', id: turnId, text: output?.text || 'done' },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: { id: turnId, status: 'completed', error: null },
          },
        });
      }, 1);
      return { turn: { id: turnId } };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected runtime method ${method}`);
  }
  started() {
    return this.calls.find(call => call.method === 'thread/start')?.params;
  }
}
const until = async check => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out');
};
const names = params => params.dynamicTools.map(tool => tool.name);
const fakeBrowser = label => ({
  label,
  close: async () => {},
  action: async () => ({ url: 'https://example.com/', label }),
  snapshot: async () => null,
});
function fakeGuest() {
  const calls = [];
  return {
    calls,
    rpc: { generation: 'g1' },
    boundary: 'qemu-kvm-ubuntu-desktop',
    assertReady() {},
    health: async () => {},
    browser: fakeBrowser('guest'),
    desktop: {
      status: async () => ({ mode: 'guest' }),
      acquire: async () => {},
      release() {},
      snapshot: async () => null,
      close: async () => {},
    },
    shell: async (botId, input) => {
      calls.push({ botId, ...input });
      return { ok: true };
    },
  };
}
function fixture(t, { guest = null, guestCodex = null, defaultVm = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-routing-')),
    store = new Store(dir),
    codex = new Runtime(),
    claude = new Runtime('claude'),
    api = new Runtime('openai-api'),
    browser = fakeBrowser('host'),
    desktop = {
      status: async () => ({ mode: 'host' }),
      acquire: async () => {},
      release() {},
      snapshot: async () => null,
      close: async () => {},
    };
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const engine = new Engine(store, codex, browser, desktop, {
    providers: { claude, 'openai-api': api },
    guestExecution: guest,
    guestCodex,
    defaultVm,
  });
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const chat = bot => store.data.chats.find(c => c.botIds?.includes(bot.id) || c.botId === bot.id);
  return { store, engine, codex, claude, api, browser, desktop, chat };
}
const runJob = async (f, bot, text = 'work') => {
  const [job] = f.engine.enqueue(f.chat(bot).id, text, { botIds: [bot.id] });
  f.engine.pump();
  await until(() => ['completed', 'failed'].includes(job.status));
  return job;
};

test('a Codex bot with no computer runs the guest config and is offered no shell or desktop tools', async t => {
  const f = fixture(t),
    bot = f.store.data.bots[0];
  const job = await runJob(f, bot);
  assert.equal(job.status, 'completed');
  assert.equal(job.openShell, false);
  const params = f.codex.started();
  assert.equal(params.sandbox, 'read-only');
  assert.equal(params.config['features.shell_tool'], false);
  assert.equal(params.executionBoundary, undefined);
  assert.ok(names(params).includes('stellarcortex_browser'));
  for (const tool of ['stellarcortex_shell', 'stellarcortex_computer'])
    assert.equal(names(params).includes(tool), false, tool);
  assert.match(params.developerInstructions, /no computer/);
  assert.doesNotMatch(
    params.developerInstructions,
    /Use stellarcortex_shell|controls the enabled host desktop/,
  );
});
test('an existing bot loses its old thread, so a shell it was offered there cannot carry over', async t => {
  const f = fixture(t),
    bot = f.store.data.bots[0],
    chat = f.chat(bot);
  chat.threadIds[bot.id] = 'thread-with-shell';
  f.store.message(chat.id, 'user', 'Earlier context');
  await runJob(f, bot);
  assert.equal(
    f.codex.calls.some(call => call.method === 'thread/resume'),
    false,
  );
  assert.match(
    f.codex.calls.find(call => call.method === 'turn/start').params.input[0].text,
    /Earlier context/,
  );
});
test('a Claude bot with no computer has a boundary, so it runs with no native tools', async t => {
  const f = fixture(t),
    bot = f.store.createBot({ name: 'Claude', provider: 'claude' }).bot;
  await runJob(f, bot);
  const params = f.claude.started();
  assert.equal(params.executionBoundary, 'no-computer');
  assert.equal(names(params).includes('stellarcortex_shell'), false);
});
test('an API bot with no computer is not offered the shell, and the tool refuses it anyway', async t => {
  const f = fixture(t),
    bot = f.store.createBot({ name: 'API', provider: 'openai-api' }).bot;
  await runJob(f, bot);
  assert.equal(names(f.api.started()).includes('stellarcortex_shell'), false);
  const job = {
    id: 'j',
    botId: bot.id,
    chatId: f.chat(bot).id,
    status: 'running',
    provider: 'openai-api',
  };
  for (const [tool, args] of [
    ['stellarcortex_shell', { command: 'node', args: ['--version'] }],
    ['stellarcortex_computer', { action: 'status' }],
  ])
    await assert.rejects(f.engine.tool(job, tool, args), /no computer/, tool);
  assert.equal(f.store.data.approvals.length, 0);
});
test('a native approval from a bot with no computer is declined with no prompt', async t => {
  const f = fixture(t),
    bot = f.store.data.bots[0];
  f.codex.onTurn = async (params, turnId) => {
    await f.engine.request(
      {
        id: 'native',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: params.threadId, turnId },
      },
      'codex',
    );
    return { text: 'done' };
  };
  await runJob(f, bot);
  assert.deepEqual(f.codex.responses.find(r => r.id === 'native').result, {
    decision: 'decline',
  });
  assert.equal(f.store.data.approvals.length, 0);
});
test('host control keeps the open config and the full tool list', async t => {
  const f = fixture(t),
    bot = f.store.data.bots[0];
  bot.computer = 'host';
  f.codex.onTurn = async params => {
    assert.equal(f.engine.findJob(params.threadId).openShell, true);
    return { text: 'done' };
  };
  const job = await runJob(f, bot);
  assert.equal(job.status, 'completed');
  const params = f.codex.started();
  assert.equal(params.sandbox, 'workspace-write');
  assert.equal(params.config['features.shell_tool'], undefined);
  for (const tool of ['stellarcortex_shell', 'stellarcortex_computer'])
    assert.ok(names(params).includes(tool), tool);
  assert.equal(f.engine.desktopFor(bot), f.desktop);
  assert.equal(f.engine.browserFor(bot), f.browser);
});
test('vm with no QEMU still chats, and never falls back to the host', async t => {
  const f = fixture(t),
    bot = f.store.data.bots[0];
  bot.computer = 'vm';
  assert.throws(() => f.engine.browserFor(bot), /no fallback/);
  assert.throws(() => f.engine.desktopFor(bot), /no fallback/);
  const job = await runJob(f, bot);
  assert.equal(job.status, 'completed');
  for (const name of [
    'stellarcortex_shell',
    'stellarcortex_computer',
    'stellarcortex_browser',
    'stellarcortex_files',
    'stellarcortex_artifact',
    'stellarcortex_secret',
  ])
    assert.ok(!names(f.codex.started()).includes(name), name);
  for (const name of ['stellarcortex_shell', 'stellarcortex_files', 'stellarcortex_browser']) {
    const [reply] = await f.engine.tool(job, name, { command: 'node', action: 'list', path: '.' });
    assert.equal(JSON.parse(reply.text).computerReady, false, name);
  }
});
test('on one install each bot uses the browser, desktop and shell of its own mode', async t => {
  const guest = fakeGuest(),
    f = fixture(t, { guest }),
    [vm, host, none] = [
      f.store.data.bots[0],
      f.store.createBot({ name: 'Host' }).bot,
      f.store.createBot({ name: 'None' }).bot,
    ];
  vm.computer = 'vm';
  host.computer = 'host';
  assert.equal(f.engine.browserFor(vm), guest.browser);
  assert.equal(f.engine.browserFor(host), f.browser);
  assert.equal(f.engine.browserFor(none), f.browser);
  assert.equal(f.engine.desktopFor(vm), guest.desktop);
  assert.equal(f.engine.desktopFor(host), f.desktop);
  assert.equal(f.engine.desktopFor(none), null);
  const job = bot => ({
    id: 'j' + bot.id,
    botId: bot.id,
    chatId: f.chat(bot).id,
    status: 'running',
    provider: 'codex',
  });
  const opened = async bot =>
    JSON.parse(
      (
        await f.engine.tool(job(bot), 'stellarcortex_browser', {
          action: 'open',
          url: 'https://example.com/',
        })
      )[0].text,
    ).label;
  assert.equal(await opened(vm), 'guest');
  assert.equal(await opened(host), 'host');
  assert.equal(await opened(none), 'host');
  const vmJob = job(vm);
  f.store.data.jobs.push(vmJob);
  f.engine.active.set(vmJob.id, vmJob);
  const running = f.engine.tool(vmJob, 'stellarcortex_shell', { command: 'node', args: [] });
  await until(() => f.store.data.approvals.some(a => a.jobId === vmJob.id));
  f.engine.resolveApproval(f.store.data.approvals.find(a => a.jobId === vmJob.id).id, {
    approve: true,
  });
  await running;
  assert.equal(guest.calls[0].botId, vm.id);
});
test('with defaultAccess a bot with no setting gets the virtual computer, and an explicit none stays none', async t => {
  const guest = fakeGuest(),
    f = fixture(t, { guest, defaultVm: true }),
    bot = f.store.data.bots[0];
  assert.equal(f.engine.computerOf(bot), 'vm');
  bot.computer = 'none';
  assert.equal(f.engine.computerOf(bot), 'none');
  assert.equal(f.engine.guestFor(bot), null);
});
test('work handed to another bot runs in that bot’s mode', async t => {
  const f = fixture(t),
    sender = f.store.data.bots[0],
    receiver = f.store.createBot({ name: 'No computer' }).bot;
  sender.computer = 'host';
  const job = await runJob(f, sender);
  await f.engine
    .tool(job, 'stellarcortex_handoff', { botId: receiver.id, message: 'Do this' })
    .catch(error => assert.fail(error.message));
  f.engine.pump();
  const handed = f.store.data.jobs.find(j => j.botId === receiver.id);
  await until(() => handed.status === 'completed');
  assert.equal(handed.openShell, false);
  const started = f.codex.calls.filter(call => call.method === 'thread/start').at(-1).params;
  assert.equal(started.sandbox, 'read-only');
  assert.equal(names(started).includes('stellarcortex_shell'), false);
});
test('only a vm Codex bot runs on the guest runtime, and each runtime answers its own requests', async t => {
  const guest = fakeGuest(),
    guestCodex = new Runtime(),
    f = fixture(t, { guest, guestCodex }),
    vm = f.store.data.bots[0],
    host = f.store.createBot({ name: 'Host' }).bot;
  vm.computer = 'vm';
  host.computer = 'host';
  guestCodex.onTurn = async (params, turnId) => {
    guestCodex.emit('request', {
      id: 'guest-native',
      method: 'item/fileChange/requestApproval',
      params: { threadId: params.threadId, turnId },
    });
    await until(() => guestCodex.responses.length > 0);
    return { text: 'done' };
  };
  await runJob(f, vm);
  await runJob(f, host);
  assert.equal(guestCodex.started().executionBoundary, 'qemu-kvm-ubuntu-desktop');
  assert.equal(guestCodex.started().sandbox, 'read-only');
  assert.equal(f.codex.started().sandbox, 'workspace-write');
  assert.deepEqual(guestCodex.responses[0], {
    id: 'guest-native',
    result: { decision: 'decline' },
  });
  assert.equal(f.codex.responses.length, 0);
});
test('a stopped guest runtime fails only the work running on it', async t => {
  const guest = fakeGuest(),
    guestCodex = new Runtime(),
    f = fixture(t, { guest, guestCodex }),
    vm = f.store.data.bots[0],
    host = f.store.createBot({ name: 'Host' }).bot;
  vm.computer = 'vm';
  host.computer = 'host';
  guestCodex.onTurn = async () => ({ hold: true });
  f.codex.onTurn = async () => ({ hold: true });
  const [vmJob] = f.engine.enqueue(f.chat(vm).id, 'work', { botIds: [vm.id] }),
    [hostJob] = f.engine.enqueue(f.chat(host).id, 'work', { botIds: [host.id] });
  f.engine.pump();
  await until(() => vmJob.turnId && hostJob.turnId);
  guestCodex.ready = false;
  guestCodex.emit('offline', 'Guest Codex stopped');
  await until(() => vmJob.status === 'failed');
  assert.equal(hostJob.status, 'running');
  assert.equal(f.engine.runtimeErrors.has('codex'), false);
  await f.engine.cancel(hostJob.id);
  assert.equal(guestCodex.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  assert.equal(f.codex.calls.filter(call => call.method === 'turn/interrupt').length, 1);
  f.codex.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: hostJob.threadId,
      turn: { id: hostJob.turnId, status: 'interrupted', error: null },
    },
  });
  await until(() => hostJob.status === 'interrupted');
});
test('the mode decides who may reach a provisioned virtual computer', () => {
  const policy = {
      environmentId: 'env',
      accountId: 'acct',
      computerId: 'pc',
      defaultAccess: true,
      overrides: {},
    },
    identity = { accountId: 'acct', environmentId: 'env' },
    bot = { id: 'bot-1', environmentId: 'env' };
  assert.equal(botComputerAccess(policy, { ...bot, computer: 'none' }, identity), false);
  assert.equal(botComputerAccess(policy, { ...bot, computer: 'host' }, identity), false);
  assert.equal(
    botComputerAccess({ ...policy, defaultAccess: false }, { ...bot, computer: 'vm' }, identity),
    true,
  );
  assert.equal(botComputerAccess(policy, bot, identity), true);
});
test('the computer routes follow the bot’s mode', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-routing-')),
    taken = [],
    desktopRuntime = {
      status: async () => ({ enabled: true, available: true, mode: 'host' }),
      snapshot: async () => {
        taken.push('host');
        return { available: true };
      },
      setTakeover: async () => {},
      action: async () => ({}),
      release() {},
      close: async () => {},
    };
  const app = await createApp({
    dataDir: dir,
    port: 0,
    runtime: new Runtime(),
    claudeRuntime: new Runtime('claude'),
    startEngine: false,
    desktopRuntime,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`,
    client = { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' },
    bot = app.store.data.bots[0];
  const headers = {
    ...client,
    Cookie: (
      await fetch(base + '/api/session', {
        method: 'POST',
        headers: client,
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0],
  };
  assert.deepEqual(
    await (await fetch(`${base}/api/desktop/status?botId=${bot.id}`, { headers })).json(),
    { enabled: false, available: false, state: 'no-computer' },
  );
  assert.equal((await fetch(`${base}/api/desktop/${bot.id}`, { headers })).status, 400);
  assert.equal(taken.length, 0);
  bot.computer = 'host';
  assert.equal(
    (await (await fetch(`${base}/api/desktop/status?botId=${bot.id}`, { headers })).json()).mode,
    'host',
  );
  assert.equal((await fetch(`${base}/api/desktop/${bot.id}`, { headers })).status, 200);
  assert.deepEqual(taken, ['host']);
  bot.computer = 'vm';
  assert.equal((await fetch(`${base}/api/browser/${bot.id}`, { headers })).status, 400);
});
test('Take control on a vm bot records the site, so a page cannot steer the bot through that account', async t => {
  const guest = fakeGuest(),
    f = fixture(t, { guest }),
    bot = f.store.data.bots[0];
  bot.computer = 'vm';
  guest.browser.snapshot = async () => ({ url: 'https://mail.example/inbox', image: null });
  await f.engine.noteHandBack(bot);
  assert.ok(f.store.data.signedInHosts.includes('mail.example'));
  assert.equal(f.engine.pageUrl(bot.id), 'https://mail.example/inbox');
  const job = {
    id: 'tainted',
    botId: bot.id,
    chatId: f.chat(bot).id,
    status: 'running',
    provider: 'codex',
    external: true,
    ownerHosts: [],
  };
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_browser', { action: 'open', url: 'https://mail.example/' }),
    /signed-in site/,
  );
});
test('a failed read of the guest browser does not fail the hand-back', async t => {
  const guest = fakeGuest(),
    f = fixture(t, { guest }),
    bot = f.store.data.bots[0];
  bot.computer = 'vm';
  guest.browser.snapshot = async () => {
    throw new Error('guest is busy');
  };
  await f.engine.noteHandBack(bot);
  assert.equal((f.store.data.signedInHosts || []).length, 0);
});
test('the app runs the pinned Claude program without any service setting', async t => {
  const guest = fakeGuest();
  guest.providerIsolation = { claude: true };
  guest.claudeExecutable = '/pinned/claude';
  const claudeRuntime = new Runtime('claude');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-routing-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      runtime: new Runtime(),
      claudeRuntime,
      startEngine: false,
      guestExecution: guest,
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(claudeRuntime.command, { bin: '/pinned/claude', prefix: [] });
});
test('both hand-back routes record the site of a vm bot', async t => {
  const guest = fakeGuest();
  guest.providerIsolation = {};
  guest.browser.setTakeover = async () => {};
  guest.desktop.setTakeover = async () => {};
  let url = 'https://first.example/';
  guest.browser.snapshot = async () => ({ url });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-routing-')),
    app = await createApp({
      dataDir: dir,
      port: 0,
      runtime: new Runtime(),
      claudeRuntime: new Runtime('claude'),
      startEngine: false,
      guestExecution: guest,
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`,
    client = { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' },
    bot = app.store.data.bots[0];
  bot.computer = 'vm';
  const headers = {
    ...client,
    Cookie: (
      await fetch(base + '/api/session', {
        method: 'POST',
        headers: client,
        body: JSON.stringify({ key: app.accessKey }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0],
  };
  const handBack = route =>
    fetch(`${base}/api/${route}/${bot.id}/takeover`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
  assert.equal((await handBack('browser')).status, 200);
  assert.ok(app.store.data.signedInHosts.includes('first.example'));
  url = 'https://second.example/';
  assert.equal((await handBack('desktop')).status, 200);
  assert.ok(app.store.data.signedInHosts.includes('second.example'));
});
test('the live control lease records the site before the bot can act again, and on expiry too', async () => {
  const scope = { accountId: 'owner', botId: 'bot', vmId: 'vm-a', generation: 'one' },
    provider = new DesktopProviderRuntime({
      records: [scope],
      broker: { release: async () => ({}) },
      enabled: true,
    }),
    seen = [];
  provider.onHandBack = botId => {
    seen.push({ botId, recovering: provider.coordinator.state(scope).recovering });
  };
  const lease = await provider.coordinator.claim(scope, 'session-one');
  await provider.coordinator.release(scope, lease);
  assert.deepEqual(seen, [{ botId: 'bot', recovering: true }]);
  assert.equal(provider.coordinator.state(scope).recovering, false);
  provider.onHandBack = async () => {
    throw new Error('read failed');
  };
  const next = await provider.coordinator.claim(scope, 'session-one');
  assert.equal(await provider.coordinator.release(scope, next), true);
  let clock = 0;
  provider.coordinator.clock = () => clock;
  seen.length = 0;
  provider.onHandBack = botId => {
    seen.push({ botId });
  };
  await provider.coordinator.claim(scope, 'session-one');
  clock = 1e9;
  await provider.coordinator.expire(scope);
  assert.deepEqual(seen, [{ botId: 'bot' }]);
});
test('Stop cuts a running guest command, and the mode can then change', async t => {
  const calls = [];
  let finish;
  const rpc = {
    generation: 'g',
    call: (method, botId, args) => {
      calls.push(method);
      return method === 'shell.run'
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve({ ok: true });
    },
  };
  const guest = new GuestExecution(rpc, { enabled: true, providerIsolation: { codex: true } }),
    f = fixture(t, { guest }),
    bot = f.store.data.bots[0];
  bot.computer = 'vm';
  const job = {
    id: 'running',
    botId: bot.id,
    chatId: f.chat(bot).id,
    status: 'running',
    provider: 'codex',
  };
  f.store.data.jobs.push(job);
  f.engine.active.set(job.id, job);
  const shell = f.engine.tool(job, 'stellarcortex_shell', { command: 'sleep', args: ['600'] });
  await until(() => f.store.data.approvals.length);
  f.engine.resolveApproval(f.store.data.approvals[0].id, { approve: true });
  await until(() => calls.includes('shell.run'));
  assert.throws(
    () => setComputerMode(f.store, { botId: bot.id, mode: 'none' }, { vm: true }),
    /Wait for this bot/,
  );
  await f.engine.cancel(job.id);
  assert.ok(calls.includes('execution.cancel'));
  finish({ stopped: 'cancelled' });
  await shell;
  job.status = 'interrupted';
  setComputerMode(f.store, { botId: bot.id, mode: 'none' }, { vm: true });
  assert.equal(bot.computer, 'none');
});

test('a bot with no computer cannot reach one through a teammate it creates', async t => {
  const execution = { enabled: true, providerIsolation: { codex: true } },
    f = fixture(t, {
      guest: new GuestExecution(
        {
          generation: 'g',
          uncertain: new Set(),
          ensureBot: async () => {},
          call: async () => ({}),
        },
        execution,
      ),
      defaultVm: true,
    }),
    lead = f.store.data.bots[0],
    create = async (name, computer) => {
      lead.computer = computer;
      const job = {
          id: name,
          rootJobId: name,
          botId: lead.id,
          chatId: f.chat(lead).id,
          provider: 'codex',
          status: 'running',
        },
        [reply] = await f.engine.tool(job, 'stellarcortex_team', { action: 'create', name });
      return f.store.bot(JSON.parse(reply.text).bot.id);
    };
  assert.equal(f.engine.computerOf(await create('From none', 'none')), 'none');
  assert.equal(
    f.engine.computerOf(await create('From vm', 'vm')),
    'vm',
    'a bot with a computer makes a teammate with its own session',
  );
  assert.equal(
    f.engine.computerOf(await create('From host', 'host')),
    'vm',
    "host control is the owner's choice per bot, so it does not pass on",
  );
});
