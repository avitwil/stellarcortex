import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine, TOOLS_VERSION } from '../src/engine.mjs';
import {
  resolveModelSettings,
  ModelCatalog,
  PROVIDERS,
  providerOf,
  isCustomProvider,
  isHttpProvider,
} from '../src/models.mjs';
import { hostBots } from './host-bots.mjs';

const until = async predicate => {
  for (let n = 0; n < 350; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected provider state was not reached');
};
class Runtime extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.ready = true;
    this.calls = [];
    this.responses = [];
    this.rejections = [];
    this.threads = 0;
    this.turns = 0;
    this.authType =
      provider === 'codex'
        ? 'chatgpt'
        : provider === 'claude'
          ? 'claude'
          : provider === 'local'
            ? 'local'
            : 'api';
    this.onTurn = async () => ({ text: `${provider} result` });
  }
  async start() {
    if (this.startError) {
      this.ready = false;
      throw new Error(this.startError);
    }
    this.ready = true;
  }
  async stop() {
    this.ready = false;
  }
  respond(id, result) {
    this.responses.push({ id, result });
  }
  reject(id, error) {
    this.rejections.push({ id, error });
  }
  finish(threadId, turnId, { text, status = 'completed', error } = {}) {
    if (text)
      this.emit('notification', {
        method: 'item/completed',
        params: { threadId, item: { type: 'agentMessage', id: turnId, text } },
      });
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status, error: error ? { message: error } : null } },
    });
  }
  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'account/read') return { account: { type: this.authType } };
    if (method === 'model/list')
      return {
        data: [
          {
            id: `${this.provider}-model`,
            model: `${this.provider}-model`,
            isDefault: true,
            defaultReasoningEffort: this.provider === 'claude' ? null : 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
            serviceTiers: this.provider === 'claude' ? [] : [{ id: 'priority' }],
          },
        ],
      };
    if (method === 'config/read') return { config: { model: `${this.provider}-model` } };
    // Both providers deliberately return the same identifiers to catch missing namespaces.
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: params.threadId || `thread-${++this.threads}` },
        model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort || null,
        serviceTier: params.serviceTier,
      };
    if (method === 'turn/start') {
      const turnId = `turn-${++this.turns}`;
      setTimeout(async () => {
        try {
          const output = await this.onTurn(params, turnId);
          if (!output?.wait) this.finish(params.threadId, turnId, output);
        } catch (error) {
          this.finish(params.threadId, turnId, { status: 'failed', error: error.message });
        }
      }, 5);
      return { turn: { id: turnId } };
    }
    if (method === 'turn/interrupt') {
      this.finish(params.threadId, params.turnId, { status: 'interrupted' });
      return {};
    }
    throw new Error(`Unexpected runtime method ${method}`);
  }
}
function fixture(t, { http = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-provider-test-')),
    store = hostBots(new Store(dir)),
    codex = new Runtime('codex'),
    claude = new Runtime('claude'),
    providers = {
      claude,
      ...(http
        ? Object.fromEntries(['openai-api', 'anthropic-api', 'local'].map(p => [p, new Runtime(p)]))
        : {}),
    },
    engine = new Engine(store, codex, { close: async () => {} }, null, { providers });
  t.after(async () => {
    await engine.close();
    const relative = path.relative(os.tmpdir(), dir);
    if (!relative.startsWith('stellarcortex-provider-test-') || relative.includes(path.sep))
      throw new Error('Invalid cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, codex, claude, engine, providers };
}
test('legacy bots migrate to Codex and provider changes atomically clear incompatible preferences', async t => {
  const { dir, store, engine } = fixture(t),
    bot = store.data.bots[0];
  store.updateBot(bot.id, {
    model: 'codex-model',
    reasoningEffort: 'high',
    serviceTier: 'priority',
  });
  delete bot.provider;
  store.save();
  assert.equal(new Store(dir).bot(bot.id).provider, 'codex');
  await engine.validateBotSettings({ provider: 'claude' }, bot);
  store.updateBot(bot.id, { provider: 'claude' });
  assert.deepEqual(
    [bot.provider, bot.model, bot.reasoningEffort, bot.serviceTier],
    ['claude', '', '', ''],
  );
  store.updateBot(bot.id, { provider: 'codex', model: 'codex-model' });
  assert.deepEqual(
    [bot.provider, bot.model, bot.reasoningEffort, bot.serviceTier],
    ['codex', 'codex-model', '', ''],
  );
  assert.throws(
    () => store.updateBot(bot.id, { provider: 'invalid', name: 'Must not save' }),
    /provider/,
  );
  assert.throws(() => store.updateBot(bot.id, { provider: null }), /provider/);
  assert.equal(bot.name, 'Stellar');
  const imported = store.createBot({ ...store.botTemplate(bot.id).bot, name: 'Imported' }).bot;
  assert.equal(imported.provider, 'codex');
  const other = store.createBot({ name: 'Claude', provider: 'claude' }).bot;
  assert.equal(store.botTemplate(other.id).bot.provider, 'claude');
});

test('provider defaults can be configured offline and Claude never inherits the Codex workspace model', async t => {
  const { store, claude, engine } = fixture(t),
    bot = store.data.bots[0];
  claude.ready = false;
  store.data.settings.model = 'codex-model';
  await engine.validateBotSettings(
    { provider: 'claude', model: '', reasoningEffort: '', serviceTier: '' },
    bot,
  );
  assert.equal(claude.calls.length, 0);
  const catalog = await engine.catalog('claude').get();
  assert.equal(
    resolveModelSettings({ provider: 'claude' }, store.data.settings, catalog).model,
    'claude-model',
  );
  await assert.rejects(
    engine.validateBotSettings({ provider: 'claude', serviceTier: 'priority' }, bot),
    /does not support service tier/,
  );
  await assert.rejects(
    engine.validateBotSettings({ provider: 'claude', model: 'codex-model' }, bot),
    /unavailable/,
  );
});

test('mixed-provider group delegation returns to the owner with visible messages and independent settings', async t => {
  const { store, codex, claude, engine } = fixture(t),
    owner = store.data.bots[0],
    worker = store.createBot({ name: 'Claude reviewer', provider: 'claude' }).bot;
  store.data.settings.concurrency = 1;
  store.data.settings.model = 'codex-model';
  const group = store.createGroup({
    name: 'Mixed team',
    botIds: [owner.id, worker.id],
    managerBotId: owner.id,
  });
  codex.onTurn = async params => {
    const job = engine.findJob(params.threadId, 'codex');
    if (job.source === 'user') {
      await engine.tool(job, 'stellarcortex_handoff', {
        chatId: group.id,
        botId: worker.id,
        message: 'Verify 6 times 7',
      });
      return { text: 'Claude is checking.' };
    }
    assert.equal(job.source, 'handoff-result');
    assert.match(params.input[0].text, /Verified: 42/);
    return { text: 'Final verified answer: 42' };
  };
  claude.onTurn = async params => {
    assert.equal(engine.findJob(params.threadId, 'claude').source, 'handoff');
    return { text: 'Verified: 42' };
  };
  engine.enqueue(group.id, 'Ask the Claude reviewer to verify the result');
  await until(
    () => store.data.jobs.length === 3 && store.data.jobs.every(job => job.status === 'completed'),
  );
  assert.deepEqual(
    store.data.jobs.map(job => job.provider),
    ['codex', 'claude', 'codex'],
  );
  assert.equal(store.data.messages.filter(message => message.kind === 'handoff').length, 1);
  assert.equal(store.data.messages.filter(message => message.kind === 'handoff-result').length, 1);
  assert.match(
    store.data.messages.filter(message => message.role === 'assistant').at(-1).text,
    /Final verified answer/,
  );
  assert.equal(
    claude.calls.find(call => call.method === 'turn/start').params.model,
    'claude-model',
  );
  assert.equal(codex.calls.find(call => call.method === 'turn/start').params.model, 'codex-model');
});

test('matching provider thread IDs cannot cross messages, approvals, native tool results or cancellation', async t => {
  const { store, codex, claude, engine } = fixture(t),
    worker = store.createBot({ name: 'Claude', provider: 'claude' });
  codex.onTurn = claude.onTurn = async () => ({ wait: true });
  const [first] = engine.enqueue(store.data.chats[0].id, 'Codex hold'),
    [second] = engine.enqueue(worker.chat.id, 'Claude hold');
  await until(() => first.turnId && second.turnId);
  assert.equal(first.threadId, second.threadId);
  const codexRequest = engine.request(
    {
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: first.threadId, command: 'codex action' },
    },
    'codex',
  );
  const claudeRequest = engine.request(
    {
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: second.threadId, command: 'claude action' },
    },
    'claude',
  );
  const approvals = store.data.approvals;
  assert.equal(approvals.length, 2);
  engine.resolveApproval(approvals.find(a => a.provider === 'codex').id, { approve: true });
  engine.resolveApproval(approvals.find(a => a.provider === 'claude').id, { approve: false });
  await Promise.all([codexRequest, claudeRequest]);
  assert.equal(codex.responses[0].result.decision, 'accept');
  assert.equal(claude.responses[0].result.decision, 'decline');
  await engine.request(
    {
      id: 2,
      method: 'item/tool/call',
      params: {
        threadId: second.threadId,
        tool: 'stellarcortex_memory',
        arguments: { action: 'save', text: 'Claude memory only' },
      },
    },
    'claude',
  );
  assert.equal(worker.bot.memory[0].text, 'Claude memory only');
  assert.equal(store.data.bots[0].memory.length, 0);
  assert.equal(claude.responses[1].result.success, true);
  // A provider switch while a turn is running must not redirect its cancellation.
  store.updateBot(worker.bot.id, { provider: 'codex' });
  await engine.cancel(second.id);
  await until(() => second.status === 'interrupted');
  assert.equal(claude.calls.filter(c => c.method === 'turn/interrupt').length, 1);
  assert.equal(codex.calls.filter(c => c.method === 'turn/interrupt').length, 0);
  codex.finish(first.threadId, first.turnId, { text: 'Codex stayed alive' });
  await until(() => first.status === 'completed');
  assert.equal(store.data.messages.find(m => m.text === 'Codex stayed alive').chatId, first.chatId);
});

test('provider offline only fails its own running tasks and an unavailable optional runtime does not block startup', async t => {
  const { store, codex, claude, engine } = fixture(t),
    worker = store.createBot({ name: 'Claude', provider: 'claude' });
  codex.onTurn = claude.onTurn = async () => ({ wait: true });
  const [first] = engine.enqueue(store.data.chats[0].id, 'Hold Codex'),
    [second] = engine.enqueue(worker.chat.id, 'Hold Claude');
  await until(() => first.turnId && second.turnId);
  codex.ready = false;
  codex.emit('offline', 'Codex connection ended');
  await until(() => first.status === 'failed');
  assert.equal(second.status, 'running');
  claude.finish(second.threadId, second.turnId, { text: 'Claude completed independently' });
  await until(() => second.status === 'completed');
  claude.startError = 'Install Claude Code first';
  codex.onTurn = async () => ({ text: 'Codex restarted' });
  await engine.start();
  const [codexJob] = engine.enqueue(store.data.chats[0].id, 'Continue'),
    [claudeJob] = engine.enqueue(worker.chat.id, 'Unavailable');
  await until(() => codexJob.status === 'completed' && claudeJob.status === 'failed');
  assert.match(claudeJob.error, /Install Claude Code first/);
});

test('switching providers and restarting retains separate sessions plus visible conversation history', async t => {
  const { store, codex, claude, engine } = fixture(t),
    bot = store.data.bots[0],
    chat = store.data.chats[0];
  const [first] = engine.enqueue(chat.id, 'Remember original context');
  await until(() => first.status === 'completed');
  store.updateBot(bot.id, { provider: 'claude' });
  const [second] = engine.enqueue(chat.id, 'Claude contribution');
  await until(() => second.status === 'completed');
  const [third] = engine.enqueue(chat.id, 'Claude continue');
  await until(() => third.status === 'completed');
  assert.equal(claude.threads, 1);
  assert.equal(chat.threadIds[`claude:${bot.id}`], second.threadId);
  assert.equal(chat.threadIds[bot.id], first.threadId);
  assert.equal(chat.threadToolVersions[`claude:${bot.id}`], TOOLS_VERSION);
  assert.equal(
    claude.calls.find(c => c.method === 'thread/resume').params.dynamicTools.length > 0,
    true,
  );
  assert.match(
    claude.calls.find(c => c.method === 'turn/start').params.input[0].text,
    /Remember original context/,
  );
  store.updateBot(bot.id, { provider: 'codex' });
  const [fourth] = engine.enqueue(chat.id, 'Back to Codex');
  await until(() => fourth.status === 'completed');
  assert.equal(codex.threads, 1);
  assert.match(
    codex.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text,
    /Claude contribution/,
  );
  assert.equal(chat.previousThreadIds, undefined);
  await engine.close();
  const loaded = new Store(store.dir),
    newCodex = new Runtime('codex'),
    newClaude = new Runtime('claude'),
    restarted = new Engine(loaded, newCodex, { close: async () => {} }, null, {
      providers: { claude: newClaude },
    });
  try {
    loaded.updateBot(bot.id, { provider: 'claude' });
    const [resumed] = restarted.enqueue(chat.id, 'Resume Claude after restart');
    await until(() => resumed.status === 'completed');
    assert.equal(newClaude.threads, 0);
    assert.equal(newCodex.turns, 0);
    assert.equal(resumed.threadId, second.threadId);
    assert.ok(
      newClaude.calls
        .find(c => c.method === 'thread/resume')
        .params.dynamicTools.some(tool => tool.name === 'stellarcortex_handoff'),
    );
  } finally {
    await restarted.close();
  }
});

test('Claude runtime readback is honest about confirmed model and does not claim requested effort was echoed', async t => {
  const { store, claude, engine } = fixture(t),
    bot = store.createBot({ name: 'Claude', provider: 'claude', reasoningEffort: 'high' });
  claude.onTurn = async params => {
    claude.emit('notification', {
      method: 'thread/settingsUpdated',
      params: {
        threadId: params.threadId,
        model: 'actual-claude-model',
        reasoningEffort: null,
        serviceTier: 'default',
      },
    });
    return { text: 'Confirmed model' };
  };
  const [job] = engine.enqueue(bot.chat.id, 'Check model');
  await until(() => job.status === 'completed');
  assert.equal(job.reasoningEffort, 'high');
  assert.equal(job.runtimeSettings.reasoningEffort, null);
  assert.equal(job.runtimeSettings.model, 'actual-claude-model');
});

test('resetting Claude effort starts a fresh session once so an old session effort cannot remain sticky', async t => {
  const { store, claude, engine } = fixture(t),
    bot = store.createBot({ name: 'Claude', provider: 'claude', reasoningEffort: 'high' });
  const [first] = engine.enqueue(bot.chat.id, 'Context before effort reset');
  await until(() => first.status === 'completed');
  store.updateBot(bot.bot.id, { reasoningEffort: '' });
  const [second] = engine.enqueue(bot.chat.id, 'Use account default effort');
  await until(() => second.status === 'completed');
  assert.notEqual(second.threadId, first.threadId);
  assert.equal(claude.threads, 2);
  assert.match(
    claude.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text,
    /Context before effort reset/,
  );
  const [third] = engine.enqueue(bot.chat.id, 'Continue');
  await until(() => third.status === 'completed');
  assert.equal(third.threadId, second.threadId);
  assert.equal(claude.threads, 2);
});

test('Claude API credentials cannot silently replace subscription usage and explicit requested child providers persist', async t => {
  const { store, claude, engine } = fixture(t),
    bot = store.createBot({ name: 'Claude', provider: 'claude' });
  claude.authType = 'apiKey';
  const [job] = engine.enqueue(bot.chat.id, 'No separate billing');
  await until(() => job.status === 'failed');
  assert.match(job.error, /API-key billing is not used/);
  assert.equal(claude.turns, 0);
  const origin = { id: 'origin', botId: bot.bot.id, chatId: bot.chat.id, provider: 'claude' };
  const own = JSON.parse(
    (
      await engine.tool(origin, 'stellarcortex_team', { action: 'create', name: 'Same provider' })
    )[0].text,
  );
  assert.equal(store.bot(own.bot.id).provider, 'claude');
  assert.equal(store.bot(own.bot.id).model, '');
  const other = JSON.parse(
    (
      await engine.tool(origin, 'stellarcortex_team', {
        action: 'create',
        name: 'Explicit Codex',
        provider: 'codex',
        model: 'codex-model',
      })
    )[0].text,
  );
  assert.equal(store.bot(other.bot.id).provider, 'codex');
  assert.equal(store.bot(other.bot.id).model, 'codex-model');
});

test('API and local providers persist through templates, default resets and reload without Codex model inheritance', async t => {
  const { store, dir, engine } = fixture(t, { http: true });
  store.data.settings.model = 'codex-model';
  for (const provider of PROVIDERS) {
    const bot = store.createBot({
      name: provider,
      provider,
      model: `${provider}-model`,
      reasoningEffort: 'high',
      serviceTier: 'default',
    }).bot;
    assert.equal(store.botTemplate(bot.id).bot.provider, provider);
    const imported = store.createBot({
      ...store.botTemplate(bot.id).bot,
      name: `${provider} import`,
    }).bot;
    assert.equal(new Store(dir).bot(imported.id).provider, provider);
    assert.equal(
      resolveModelSettings({ provider }, store.data.settings, await engine.catalog(provider).get())
        .model,
      `${provider}-model`,
    );
    const target = provider === 'local' ? 'openai-api' : 'local';
    await engine.validateBotSettings({ provider: target }, bot);
    store.updateBot(bot.id, { provider: target });
    assert.deepEqual([bot.model, bot.reasoningEffort, bot.serviceTier], ['', '', '']);
  }
});

test('Codex, OpenAI API, Anthropic API and local engine coordinate in one visible nested team', async t => {
  const { store, codex, engine, providers } = fixture(t, { http: true }),
    bots = [
      store.data.bots[0],
      ...['openai-api', 'anthropic-api', 'local'].map(
        provider => store.createBot({ name: provider, provider }).bot,
      ),
    ];
  store.data.settings.concurrency = 1;
  store.data.settings.model = 'codex-model';
  const group = store.createGroup({
    name: 'Four runtimes',
    botIds: bots.map(b => b.id),
    managerBotId: bots[0].id,
  });
  for (let index = 0; index < bots.length; index++) {
    const bot = bots[index],
      runtime = bot.provider === 'codex' ? codex : providers[bot.provider];
    runtime.onTurn = async params => {
      const job = engine.findJob(params.threadId, bot.provider);
      if (job.source !== 'handoff-result' && index < bots.length - 1)
        await engine.tool(job, 'stellarcortex_handoff', {
          chatId: group.id,
          botId: bots[index + 1].id,
          message: `Verify stage ${index + 1}`,
        });
      return { text: `Stage ${index} completed with its own provider` };
    };
  }
  engine.enqueue(group.id, 'Coordinate the requested verification');
  // Intermediate replies also wake ancestors; the final nested reply reaches each one again.
  await until(
    () => store.data.jobs.length === 10 && store.data.jobs.every(j => j.status === 'completed'),
  );
  assert.deepEqual(
    store.data.jobs.filter(j => j.source !== 'handoff-result').map(j => j.provider),
    ['codex', 'openai-api', 'anthropic-api', 'local'],
  );
  assert.equal(store.data.jobs.at(-1).provider, 'codex');
  assert.equal(store.data.messages.filter(m => m.kind === 'handoff').length, 3);
  assert.equal(store.data.messages.filter(m => m.kind === 'handoff-result').length, 6);
  for (const provider of ['openai-api', 'anthropic-api'])
    assert.ok(
      providers[provider].calls
        .find(c => c.method === 'thread/resume')
        .params.dynamicTools.some(t => t.name === 'stellarcortex_files'),
    );
});

test('HTTP authentication failure and cancellation do not switch billing modes or interrupt another provider', async t => {
  const { store, engine, providers, codex } = fixture(t, { http: true }),
    api = store.createBot({ name: 'API', provider: 'openai-api' }),
    local = store.createBot({ name: 'Local', provider: 'local' });
  providers['openai-api'].authType = 'chatgpt';
  const [failed] = engine.enqueue(api.chat.id, 'Require API configuration'),
    [healthy] = engine.enqueue(store.data.chats[0].id, 'Continue subscription');
  await until(() => failed.status === 'failed' && healthy.status === 'completed');
  assert.match(failed.error, /API key/);
  assert.equal(providers['openai-api'].turns, 0);
  providers['openai-api'].authType = 'api';
  providers['openai-api'].onTurn = providers.local.onTurn = async () => ({ wait: true });
  const [one] = engine.enqueue(api.chat.id, 'Hold API'),
    [two] = engine.enqueue(local.chat.id, 'Hold local');
  await until(() => one.turnId && two.turnId);
  store.updateBot(api.bot.id, { provider: 'anthropic-api' });
  await engine.cancel(one.id);
  await until(() => one.status === 'interrupted');
  assert.equal(two.status, 'running');
  assert.equal(
    providers['anthropic-api'].calls.some(c => c.method === 'turn/interrupt'),
    false,
  );
  assert.equal(
    codex.calls.some(c => c.method === 'turn/interrupt'),
    false,
  );
  providers.local.finish(two.threadId, two.turnId, { text: 'Independent local result' });
  await until(() => two.status === 'completed');
});

test('connection revisions replace HTTP sessions and block stale catalog defaults across restart', async t => {
  const { store, engine, providers } = fixture(t, { http: true }),
    runtime = providers['openai-api'];
  runtime.configurationVersion = 'account-a';
  const bot = store.createBot({ name: 'API', provider: 'openai-api' });
  const [first] = engine.enqueue(bot.chat.id, 'Remember user-visible context');
  await until(() => first.status === 'completed');
  const [second] = engine.enqueue(bot.chat.id, 'Same account');
  await until(() => second.status === 'completed');
  assert.equal(second.threadId, first.threadId);
  runtime.configurationVersion = 'account-b';
  const [third] = engine.enqueue(bot.chat.id, 'New account');
  await until(() => third.status === 'completed');
  assert.notEqual(third.threadId, first.threadId);
  assert.match(
    runtime.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text,
    /Remember user-visible context/,
  );
  assert.equal(third.modelSettings.configurationVersion, 'account-b');
  await engine.close();
  const loaded = new Store(store.dir),
    next = new Runtime('openai-api');
  next.configurationVersion = 'account-c';
  next.threads = 50;
  const restarted = new Engine(loaded, new Runtime('codex'), { close: async () => {} }, null, {
    providers: { 'openai-api': next },
  });
  try {
    const [fourth] = restarted.enqueue(bot.chat.id, 'New connection after restart');
    await until(() => fourth.status === 'completed');
    assert.notEqual(fourth.threadId, third.threadId);
    assert.equal(
      next.calls.some(c => c.method === 'thread/resume'),
      false,
    );
  } finally {
    await restarted.close();
  }
});

test('catalog reset discards an old connection response even when it resolves after the replacement', async () => {
  let release;
  const old = new Promise(resolve => (release = resolve)),
    runtime = {
      configurationVersion: 'a',
      request: async method => {
        const version = runtime.configurationVersion;
        if (version === 'a') await old;
        return method === 'model/list'
          ? { data: [{ id: version, model: version, isDefault: true }] }
          : { config: { model: version } };
      },
    };
  const catalog = new ModelCatalog(runtime, '/workspace', { provider: 'openai-api' }),
    pending = catalog.get();
  runtime.configurationVersion = 'b';
  catalog.reset();
  const current = await catalog.get();
  assert.equal(current.defaultModel, 'b');
  release();
  assert.equal((await pending).defaultModel, 'b');
  assert.deepEqual(
    catalog.snapshot().models.map(m => m.id),
    ['b'],
  );
});

test('HTTP token usage persists as observed installation counters and rejects stale or malformed quota-like data', t => {
  const { store, dir, engine, providers } = fixture(t, { http: true }),
    runtime = providers['openai-api'];
  runtime.configurationVersion = 'revision-1';
  let emitted;
  engine.on('account', event => (emitted = event));
  const usage = {
    source: 'api-runtime',
    kind: 'tokens',
    provider: 'openai-api',
    scope: 'this-installation',
    available: true,
    configurationVersion: 'revision-1',
    observedAt: new Date().toISOString(),
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    requests: 2,
    usedPercent: 99,
    secret: 'must not persist',
  };
  runtime.emit('notification', { method: 'account/rateLimits/updated', params: { usage } });
  const saved = store.data.providerUsage['openai-api'];
  assert.equal(saved.totalTokens, 18);
  assert.equal(saved.usedPercent, undefined);
  assert.equal(saved.secret, undefined);
  assert.equal(emitted.usage, saved);
  assert.equal(new Store(dir).data.providerUsage['openai-api'].totalTokens, 18);
  runtime.emit('notification', {
    method: 'account/rateLimits/updated',
    params: { usage: { ...usage, totalTokens: 900, configurationVersion: 'old' } },
  });
  assert.equal(store.data.providerUsage['openai-api'], saved);
  runtime.emit('notification', {
    method: 'account/rateLimits/updated',
    params: { usage: { ...usage, inputTokens: -1 } },
  });
  assert.equal(store.data.providerUsage['openai-api'], saved);
  runtime.configurationVersion = 'revision-2';
  runtime.emit('notification', {
    method: 'account/rateLimits/updated',
    params: {
      usage: {
        ...usage,
        configurationVersion: 'revision-2',
        reset: true,
        observedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
        reportedRequests: 0,
      },
    },
  });
  assert.equal(store.data.providerUsage['openai-api'].reset, true);
  assert.equal(store.data.providerUsage['openai-api'].observedAt, null);
  assert.equal(store.data.providerUsage['openai-api'].totalTokens, 0);
  assert.equal(store.data.providerUsage.codex, undefined);
});

function toolJob(store, engine) {
  const job = {
    id: `tool-${Date.now()}`,
    botId: store.data.bots[0].id,
    chatId: store.data.chats[0].id,
    provider: 'codex',
    status: 'running',
  };
  store.data.jobs.push(job);
  engine.active.set(job.id, job);
  return job;
}
const toolValue = result => JSON.parse(result[0].text);
async function decide(engine, store, approve) {
  await until(() => store.data.approvals.some(a => a.status === 'pending'));
  const approval = store.data.approvals.findLast(a => a.status === 'pending');
  engine.resolveApproval(approval.id, { approve });
  return approval;
}

test('workspace files require exact write approval, reject traversal and symlinks, and bound text reads', async t => {
  const { dir, store, engine } = fixture(t),
    job = toolJob(store, engine),
    workspace = path.join(dir, 'workspace');
  let pending = engine.tool(job, 'stellarcortex_files', {
    action: 'write',
    path: 'draft/hello.txt',
    text: 'Hello שלום',
  });
  const approved = await decide(engine, store, true);
  assert.equal(approved.kind, 'item/fileChange/requestApproval');
  assert.equal(toolValue(await pending).written, true);
  assert.equal(
    toolValue(
      await engine.tool(job, 'stellarcortex_files', { action: 'read', path: 'draft/hello.txt' }),
    ).text,
    'Hello שלום',
  );
  assert.equal(
    toolValue(await engine.tool(job, 'stellarcortex_files', { action: 'list' })).entries[0].name,
    'draft',
  );
  pending = engine.tool(job, 'stellarcortex_files', {
    action: 'write',
    path: 'draft/hello.txt',
    text: 'Denied replacement',
  });
  const denied = assert.rejects(pending, /declined/);
  await decide(engine, store, false);
  await denied;
  assert.equal(fs.readFileSync(path.join(workspace, 'draft', 'hello.txt'), 'utf8'), 'Hello שלום');
  for (const action of ['read', 'write', 'list'])
    await assert.rejects(
      engine.tool(job, 'stellarcortex_files', { action, path: '../state.json', text: 'bad' }),
      /outside the workspace/,
    );
  fs.symlinkSync(
    dir,
    path.join(workspace, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    engine.tool(job, 'stellarcortex_files', { action: 'read', path: 'escape/state.json' }),
    /Symlink leaves/,
  );
  fs.symlinkSync(
    path.join(dir, 'missing-outside'),
    path.join(workspace, 'dangling'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    engine.tool(job, 'stellarcortex_files', {
      action: 'write',
      path: 'dangling/new.txt',
      text: 'outside',
    }),
  );
  assert.equal(fs.existsSync(path.join(dir, 'missing-outside')), false);
  fs.linkSync(path.join(dir, 'state.json'), path.join(workspace, 'hardlink.json'));
  await assert.rejects(
    engine.tool(job, 'stellarcortex_files', { action: 'read', path: 'hardlink.json' }),
    /hard links/,
  );
  fs.writeFileSync(path.join(workspace, 'large.txt'), 'a'.repeat(256 * 1024 + 1));
  await assert.rejects(
    engine.tool(job, 'stellarcortex_files', { action: 'read', path: 'large.txt' }),
    /256 KiB/,
  );
  pending = engine.tool(job, 'stellarcortex_files', {
    action: 'write',
    path: 'draft/hello.txt',
    text: 'Stale overwrite',
  });
  const changed = assert.rejects(pending, /changed while awaiting/);
  fs.writeFileSync(path.join(workspace, 'draft', 'hello.txt'), 'User changed this');
  await decide(engine, store, true);
  await changed;
  assert.equal(
    fs.readFileSync(path.join(workspace, 'draft', 'hello.txt'), 'utf8'),
    'User changed this',
  );
});

test('shell runs only after approval, confines cwd and removes inherited credentials and startup hooks', async t => {
  const { dir, store, engine } = fixture(t),
    job = toolJob(store, engine),
    workspace = path.join(dir, 'workspace');
  const previous = process.env.STELLARCORTEX_ENGINE_SECRET_TEST;
  process.env.STELLARCORTEX_ENGINE_SECRET_TEST = 'sensitive-value';
  t.after(() => {
    if (previous === undefined) delete process.env.STELLARCORTEX_ENGINE_SECRET_TEST;
    else process.env.STELLARCORTEX_ENGINE_SECRET_TEST = previous;
  });
  const input = {
    command: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,secret:process.env.STELLARCORTEX_ENGINE_SECRET_TEST||null}))',
    ],
  };
  let pending = engine.tool(job, 'stellarcortex_shell', input),
    denied = assert.rejects(pending, /declined/);
  await decide(engine, store, false);
  await denied;
  assert.equal(engine.toolProcesses.size, 0);
  pending = engine.tool(job, 'stellarcortex_shell', input);
  const approval = await decide(engine, store, true);
  const output = toolValue(await pending),
    reported = JSON.parse(output.stdout);
  assert.equal(approval.kind, 'item/commandExecution/requestApproval');
  assert.match(approval.details.reason, /not an OS sandbox/);
  assert.equal(output.exitCode, 0);
  assert.equal(reported.cwd, workspace);
  assert.equal(reported.home, workspace);
  assert.equal(reported.secret, null);
  await assert.rejects(
    engine.tool(job, 'stellarcortex_shell', { ...input, cwd: '../' }),
    /outside/,
  );
});

test('approved shell processes stop on timeout, output overflow, and task cancellation', async t => {
  const { store, engine } = fixture(t),
    job = toolJob(store, engine);
  let pending = engine.tool(job, 'stellarcortex_shell', {
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 100,
  });
  await decide(engine, store, true);
  assert.equal(toolValue(await pending).timedOut, true);
  pending = engine.tool(job, 'stellarcortex_shell', {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("a".repeat(100000));setInterval(()=>{},1000)'],
  });
  await decide(engine, store, true);
  const limited = toolValue(await pending);
  assert.equal(limited.truncated, true);
  assert.equal(Buffer.byteLength(limited.stdout), 64 * 1024);
  pending = engine.tool(job, 'stellarcortex_shell', {
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
  });
  await decide(engine, store, true);
  await until(() => engine.toolProcesses.size === 1);
  await engine.cancel(job.id);
  assert.equal(toolValue(await pending).cancelled, true);
  assert.equal(engine.toolProcesses.size, 0);
});

test('registered custom connections retain independent runtime, catalogs, sessions and usage under identical remote IDs', async t => {
  const { dir, store, engine } = fixture(t),
    first = new Runtime('custom-nvidia-one'),
    second = new Runtime('custom-zen-two');
  first.displayName = 'NVIDIA personal';
  second.displayName = 'OpenCode Zen';
  assert.equal(engine.registerProvider('custom-nvidia-one', first), first);
  assert.equal(engine.registerProvider('custom-zen-two', second), second);
  assert.equal(engine.registerProvider('custom-nvidia-one', first), first);
  assert.equal(first.listenerCount('notification'), 1);
  assert.throws(
    () => engine.registerProvider('custom-nvidia-one', new Runtime('custom-nvidia-one')),
    /already registered/,
  );
  await assert.rejects(
    engine.validateBotSettings({ provider: 'custom-missing', name: 'Unregistered' }),
    /unavailable/,
  );
  first.onTurn = second.onTurn = async () => ({ wait: true });
  const one = store.createBot({ name: 'NVIDIA', provider: 'custom-nvidia-one' }),
    two = store.createBot({ name: 'Zen', provider: 'custom-zen-two' });
  assert.equal(store.botTemplate(one.bot.id).bot.provider, 'custom-nvidia-one');
  assert.equal(new Store(dir).bot(two.bot.id).provider, 'custom-zen-two');
  const [job1] = engine.enqueue(one.chat.id, 'Hold first custom provider'),
    [job2] = engine.enqueue(two.chat.id, 'Hold second custom provider');
  await until(() => job1.turnId && job2.turnId);
  assert.equal(job1.threadId, job2.threadId);
  assert.equal(job1.model, 'custom-nvidia-one-model');
  assert.equal(job2.model, 'custom-zen-two-model');
  const usage = {
    source: 'api-runtime',
    kind: 'tokens',
    scope: 'this-installation',
    available: true,
    observedAt: new Date().toISOString(),
    inputTokens: 10,
    outputTokens: 3,
    totalTokens: 13,
    requests: 1,
  };
  first.emit('notification', {
    method: 'account/rateLimits/updated',
    params: { usage: { ...usage, provider: 'custom-nvidia-one' } },
  });
  second.emit('notification', {
    method: 'account/rateLimits/updated',
    params: { usage: { ...usage, provider: 'custom-zen-two', totalTokens: 22 } },
  });
  assert.equal(store.data.providerUsage['custom-nvidia-one'].totalTokens, 13);
  assert.equal(store.data.providerUsage['custom-zen-two'].totalTokens, 22);
  first.emit('offline', 'First custom endpoint stopped');
  await until(() => job1.status === 'failed');
  assert.equal(job2.status, 'running');
  second.finish(job2.threadId, job2.turnId, { text: 'Second endpoint remained healthy' });
  await until(() => job2.status === 'completed');
  const origin = {
      id: 'custom-origin',
      botId: two.bot.id,
      chatId: two.chat.id,
      provider: 'custom-zen-two',
    },
    team = JSON.parse(
      (await engine.tool(origin, 'stellarcortex_team', { action: 'list' }))[0].text,
    );
  assert.ok(team.providers.some(p => p.id === 'custom-nvidia-one' && p.name === 'NVIDIA personal'));
  assert.ok(team.providers.some(p => p.id === 'custom-zen-two' && p.name === 'OpenCode Zen'));
  const child = JSON.parse(
    (
      await engine.tool(origin, 'stellarcortex_team', {
        action: 'create',
        name: 'Requested custom child',
      })
    )[0].text,
  );
  assert.equal(store.bot(child.bot.id).provider, 'custom-zen-two');
});

test('dynamic provider identifiers are validated without silently falling back to a subscription provider', () => {
  for (const provider of ['custom-nvidia', 'custom-zen-123', 'custom-' + 'a'.repeat(80)]) {
    assert.equal(isCustomProvider(provider), true);
    assert.equal(isHttpProvider(provider), true);
    assert.equal(providerOf(provider), provider);
  }
  for (const provider of [
    'custom-',
    'custom-UPPER',
    'custom-a/../b',
    'custom-' + 'a'.repeat(81),
    '__proto__',
    null,
  ]) {
    assert.equal(isCustomProvider(provider), false);
    assert.throws(() => providerOf(provider), /provider/);
  }
  assert.equal(providerOf(undefined), 'codex');
  assert.equal(isHttpProvider('codex'), false);
  assert.equal(isHttpProvider('openai-api'), true);
});
