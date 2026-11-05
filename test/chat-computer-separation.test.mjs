import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { GuestExecution } from '../src/guest-execution.mjs';
import { ModelCatalog } from '../src/models.mjs';
// What the app may add before the model is called. The model's own speed is not part of this.
const BUDGET_MS = 250,
  never = new Promise(() => {});
class Model extends EventEmitter {
  constructor(provider, slow = {}) {
    super();
    Object.assign(this, { provider, slow, ready: true, stages: {}, turns: 0, calls: [] });
  }
  async start() {}
  async stop() {}
  respond() {}
  reject() {}
  async request(method, params = {}) {
    this.calls.push({ method, params });
    this.stages[method] ??= performance.now();
    if (method === 'account/read')
      return {
        account: {
          type: { codex: 'chatgpt', claude: 'claude', 'openai-api': 'api' }[this.provider],
        },
      };
    if (method === 'model/list') {
      if (this.slow.catalog) await never;
      return {
        data: [
          {
            id: 'model-a',
            model: 'model-a',
            isDefault: true,
            supportedReasoningEfforts: [],
            serviceTiers: [],
          },
        ],
        nextCursor: null,
      };
    }
    if (method === 'config/read') {
      if (this.slow.catalog) await never;
      return { config: { model: 'model-a' } };
    }
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: params.threadId || this.provider + '-thread' },
        model: 'model-a',
        reasoningEffort: null,
        serviceTier: null,
      };
    if (method === 'turn/start') {
      const turnId = 'turn-' + ++this.turns;
      setTimeout(() => {
        this.emit('notification', {
          method: 'item/agentMessage/delta',
          params: { threadId: params.threadId, turnId, itemId: turnId, delta: 'hi' },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: { id: turnId, status: 'completed', items: [] },
          },
        });
      }, 0);
      return { turn: { id: turnId } };
    }
    return {};
  }
}
const hungRpc = () => ({
  generation: 'g',
  uncertain: new Set(),
  ensureBot: () => never,
  call: () => never,
});
function setup(t, { guest = null, slow, computerCheckMs = 60 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-chat-')),
    store = new Store(dir),
    models = {
      codex: new Model('codex', slow),
      claude: new Model('claude', slow),
      'openai-api': new Model('openai-api', slow),
    };
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const host = {
    action: async () => {
      throw Error('host browser used');
    },
    snapshot: async () => {
      throw Error('host browser used');
    },
    close: async () => {},
  };
  const engine = new Engine(store, models.codex, host, null, {
    providers: { claude: models.claude, 'openai-api': models['openai-api'] },
    guestExecution: guest,
    computerCheckMs,
  });
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    engine,
    models,
    chat: bot => store.data.chats.find(c => c.botIds?.includes(bot.id) || c.botId === bot.id),
  };
}
const until = async check => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Timed out');
};
async function send(f, provider, text = 'hi') {
  const bot = f.store.data.bots[0];
  bot.provider = provider;
  bot.computer = 'vm';
  let first;
  f.engine.on('delta', () => {
    first ??= performance.now();
  });
  const sent = performance.now(),
    [job] = f.engine.enqueue(f.chat(bot).id, text, { botIds: [bot.id] });
  f.engine.pump();
  await until(() => ['completed', 'failed'].includes(job.status));
  return { job, bot, model: f.models[provider], sent, first };
}
for (const provider of ['claude', 'codex', 'openai-api']) {
  test(
    provider +
      ': a bot gets its reply while the computer hangs, within the budget, with nothing on the host',
    async t => {
      const guest = new GuestExecution(hungRpc(), {
          enabled: true,
          providerIsolation: { [provider]: true },
        }),
        f = setup(t, { guest }),
        { job, model, sent, first } = await send(f, provider);
      assert.equal(job.status, 'completed', job.error);
      assert.ok(
        model.stages['turn/start'] - sent < BUDGET_MS,
        'the app added ' + (model.stages['turn/start'] - sent) + ' ms',
      );
      assert.ok(first);
      // The call that needs the computer gets a clear answer, in time. It does not fail the turn or reach the host.
      const start = performance.now();
      for (const name of ['stellarcortex_shell', 'stellarcortex_files', 'stellarcortex_browser']) {
        const [reply] = await f.engine.tool(job, name, {
          command: 'node',
          action: 'list',
          path: '.',
          url: 'https://example.com/',
        });
        assert.deepEqual(JSON.parse(reply.text), {
          computerReady: false,
          status: 'The computer did not answer in time.',
        });
      }
      assert.ok(performance.now() - start < 1000);
    },
  );
  test(
    provider +
      ': a bot set to a computer that is not ready answers, and its tools report the status',
    async t => {
      const guest = new GuestExecution(
          {
            generation: 'g',
            uncertain: new Set(),
            ensureBot: async () => {
              throw Error('The computer is being built: step 3 of 5.');
            },
            call: () => never,
          },
          { enabled: true, providerIsolation: { [provider]: true } },
        ),
        f = setup(t, { guest }),
        { job, model } = await send(f, provider);
      assert.equal(job.status, 'completed', job.error);
      const start = model.calls.find(call => call.method === 'thread/start').params;
      assert.match(start.developerInstructions, /computerReady:false/);
      const [reply] = await f.engine.tool(job, 'stellarcortex_shell', {
        command: 'node',
        args: [],
      });
      assert.deepEqual(JSON.parse(reply.text), {
        computerReady: false,
        status: 'The computer is being built: step 3 of 5.',
      });
    },
  );
  test(provider + ': a slow model list does not delay the first message', async t => {
    const f = setup(t, { slow: { catalog: true } }),
      { job, model, sent } = await send(f, provider);
    assert.equal(job.status, 'completed', job.error);
    assert.ok(
      model.stages['turn/start'] - sent < BUDGET_MS + 150,
      'the app added ' + (model.stages['turn/start'] - sent) + ' ms',
    );
  });
}
test('tools come back on the next call once the computer is ready, with no restart', async t => {
  let ready = false;
  const rpc = {
      generation: 'g',
      uncertain: new Set(),
      ensureBot: async () => {
        if (!ready) throw Error('Not ready yet.');
      },
      call: async method =>
        method === 'execution.ping' ? { available: true } : { exitCode: 0, stdout: 'ok' },
    },
    guest = new GuestExecution(rpc, { enabled: true, providerIsolation: { codex: true } }),
    f = setup(t, { guest }),
    { bot } = await send(f, 'codex');
  assert.equal(await f.engine.computerProblem(bot), 'Not ready yet.');
  ready = true;
  assert.equal(await f.engine.computerProblem(bot), null);
});
test('a tool answered "not ready" read nothing, so the chat stays clean and later work is not blocked', async t => {
  const guest = new GuestExecution(
      {
        generation: 'g',
        uncertain: new Set(),
        ensureBot: async () => {
          throw Error('Not ready yet.');
        },
        call: () => never,
      },
      { enabled: true, providerIsolation: { codex: true } },
    ),
    f = setup(t, { guest }),
    { job, bot } = await send(f, 'codex'),
    chat = f.chat(bot);
  for (const [name, input] of [
    ['stellarcortex_browser', { action: 'open', url: 'https://example.com/' }],
    ['stellarcortex_computer', { action: 'click' }],
  ]) {
    const [reply] = await f.engine.tool(job, name, input);
    assert.equal(JSON.parse(reply.text).computerReady, false);
  }
  assert.ok(!job.external, 'nothing external reached this job');
  assert.ok(!chat.externalContent, 'nothing external reached this chat');
});
test('a stopped task cannot raise the login dialog', async t => {
  const f = setup(t),
    { job, bot } = await send(f, 'codex');
  bot.computer = 'none';
  let asked = false;
  f.engine.secretLogin = async () => {
    asked = true;
    return [];
  };
  job.cancelled = true;
  await assert.rejects(f.engine.tool(job, 'stellarcortex_secret', {}), /stopped/);
  assert.equal(asked, false);
});
test('a turn uses the model list on hand, and only a first read waits, briefly', async () => {
  let answer = false,
    reads = 0;
  const runtime = {
      async request(method) {
        reads++;
        if (answer)
          return method === 'model/list'
            ? { data: [{ id: 'a', model: 'a' }], nextCursor: null }
            : { config: {} };
        return never;
      },
    },
    catalog = new ModelCatalog(runtime, '.', { provider: 'codex' }),
    start = performance.now(),
    cold = await catalog.quick(20);
  assert.ok(performance.now() - start < 500);
  assert.equal(cold.defaultModelKnown, true);
  catalog.pending = null;
  answer = true;
  await catalog.get({ force: true });
  catalog.invalidate();
  const before = reads,
    warm = await catalog.quick();
  assert.equal(warm.models.length, 1);
  assert.ok(reads > before, 'it refreshes behind the turn');
});
