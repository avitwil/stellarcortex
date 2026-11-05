import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { ModelCatalog, resolveModelSettings } from '../src/models.mjs';
import { createApp } from '../src/server.mjs';

const models = [
  {
    id: 'test-deep',
    model: 'test-deep',
    isDefault: true,
    defaultReasoningEffort: 'deep',
    supportedReasoningEfforts: [{ reasoningEffort: 'deep' }, { reasoningEffort: 'ultra' }],
    serviceTiers: [
      { id: 'priority', name: 'Fast' },
      { id: 'economy', name: 'Economy' },
    ],
    defaultServiceTier: null,
  },
  {
    id: 'test-small',
    model: 'test-small',
    isDefault: false,
    defaultReasoningEffort: 'light',
    supportedReasoningEfforts: [{ reasoningEffort: 'light' }, { reasoningEffort: 'deep' }],
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
    defaultServiceTier: null,
  },
];
const until = async check => {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for model test');
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-model-test-')),
    store = new Store(dir),
    runtime = new Runtime(),
    engine = new Engine(store, runtime, { close: async () => {} });
  t.after(async () => {
    await engine.close();
    const rel = path.relative(os.tmpdir(), dir);
    if (!rel.startsWith('stellarcortex-model-test-') || rel.includes(path.sep))
      throw new Error('Invalid test cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, runtime, engine };
}
class Runtime extends EventEmitter {
  ready = true;
  calls = [];
  threads = 0;
  turns = 0;
  failCatalog = false;
  failConfig = false;
  configuredModel = 'test-small';
  onTurn = async () => {};
  async start() {
    this.ready = true;
  }
  async stop() {
    this.ready = false;
  }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'config/read') {
      if (this.failConfig) throw new Error('Configuration temporarily offline');
      return {
        config: {
          model: this.configuredModel,
          model_reasoning_effort: 'not-the-model-default',
          private_key: 'never-expose-this',
        },
      };
    }
    if (method === 'model/list') {
      if (this.failCatalog) throw new Error('Catalog temporarily offline');
      return params.cursor
        ? { data: [models[1]], nextCursor: null }
        : { data: [models[0]], nextCursor: 'second-page' };
    }
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: params.threadId || `thread-${++this.threads}` },
        model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort,
        serviceTier: params.serviceTier,
      };
    if (method === 'turn/start') {
      const turnId = `turn-${++this.turns}`;
      setTimeout(async () => {
        try {
          await this.onTurn(params);
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId: params.threadId,
              item: { type: 'agentMessage', id: turnId, text: 'Verified result' },
            },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } },
          });
        } catch (error) {
          this.emit('notification', {
            method: 'turn/completed',
            params: {
              threadId: params.threadId,
              turn: { id: turnId, status: 'failed', error: { message: error.message } },
            },
          });
        }
      }, 5);
      return { turn: { id: turnId } };
    }
    return {};
  }
}

test('catalog paginates, coalesces requests, caches failure and exposes only the configured default model', async () => {
  const runtime = new Runtime(),
    catalog = new ModelCatalog(runtime, '/workspace');
  const [first, second] = await Promise.all([catalog.get(), catalog.get()]);
  assert.deepEqual(first.models, models);
  assert.equal(first.defaultModel, 'test-small');
  assert.equal(first, second);
  assert.equal(runtime.calls.filter(c => c.method === 'model/list').length, 2);
  assert.equal(runtime.calls.find(c => c.method === 'config/read').params.cwd, '/workspace');
  assert.equal(JSON.stringify(first).includes('private_key'), false);
  await catalog.get();
  assert.equal(runtime.calls.length, 3);
  runtime.failCatalog = true;
  const stale = await catalog.get({ force: true });
  assert.deepEqual(stale.models, models);
  assert.equal(stale.modelsStale, true);
  assert.match(stale.modelsError, /offline/);
});

test('dynamic reasoning and tier validation does not substitute unavailable selections', () => {
  const catalog = { models, defaultModel: 'test-small' };
  assert.deepEqual(resolveModelSettings({}, {}, catalog), {
    model: 'test-small',
    reasoningEffort: 'light',
    serviceTier: 'default',
    requested: { model: '', reasoningEffort: '', serviceTier: '' },
    catalogKnown: true,
  });
  assert.equal(
    resolveModelSettings({ model: 'test-deep', serviceTier: 'economy' }, {}, catalog).serviceTier,
    'economy',
  );
  assert.equal(resolveModelSettings({}, { model: 'test-deep' }, catalog).reasoningEffort, 'deep');
  assert.throws(() => resolveModelSettings({ model: 'missing' }, {}, catalog), /unavailable/);
  assert.throws(
    () => resolveModelSettings({ model: 'test-small', reasoningEffort: 'ultra' }, {}, catalog),
    /does not support reasoning/,
  );
  assert.throws(
    () => resolveModelSettings({ model: 'test-small', serviceTier: 'economy' }, {}, catalog),
    /does not support service tier/,
  );
});

test('failed config read never substitutes the catalog recommendation for the configured default', async () => {
  const runtime = new Runtime();
  runtime.failConfig = true;
  const catalog = await new ModelCatalog(runtime, '/workspace').get();
  assert.equal(catalog.defaultModelKnown, false);
  assert.equal(catalog.defaultModel, null);
  assert.match(catalog.defaultModelError, /Configuration temporarily offline/);
  assert.match(catalog.modelsError, /default model unavailable/);
  assert.throws(() => resolveModelSettings({}, {}, catalog), /default model could not be read/);
  assert.equal(resolveModelSettings({ model: 'test-small' }, {}, catalog).model, 'test-small');
  assert.equal(resolveModelSettings({}, { model: 'test-deep' }, catalog).model, 'test-deep');
});

test('bot model fields persist through update, restart and template import; invalid types are atomic', t => {
  const { store, dir } = fixture(t),
    selected = { model: 'test-deep', reasoningEffort: 'ultra', serviceTier: 'priority' };
  const { bot } = store.createBot({ name: 'Model bot', ...selected });
  const template = store.botTemplate(bot.id);
  assert.equal('memory' in template.bot, false);
  assert.deepEqual(
    Object.fromEntries(Object.keys(selected).map(k => [k, template.bot[k]])),
    selected,
  );
  const imported = store.createBot({ ...template.bot, name: 'Imported' }).bot;
  store.updateBot(imported.id, { serviceTier: 'default' });
  const reloaded = new Store(dir);
  assert.equal(reloaded.bot(bot.id).reasoningEffort, 'ultra');
  assert.equal(reloaded.bot(imported.id).serviceTier, 'default');
  for (const value of [null, 42, {}, [], true, 'x'.repeat(201)])
    assert.throws(() => store.updateBot(bot.id, { name: 'Must not change', model: value }));
  assert.equal(store.bot(bot.id).name, 'Model bot');
  store.updateBot(bot.id, { model: '', reasoningEffort: '', serviceTier: '' });
  assert.equal(store.bot(bot.id).model, '');
});

test('existing threads reset model, reasoning and Fast to resolved defaults without losing their history', async t => {
  const { store, runtime, engine } = fixture(t),
    bot = store.data.bots[0],
    chat = store.data.chats[0];
  store.updateBot(bot.id, {
    model: 'test-deep',
    reasoningEffort: 'ultra',
    serviceTier: 'priority',
  });
  const [first] = engine.enqueue(chat.id, 'First');
  await until(() => first.status === 'completed');
  store.updateBot(bot.id, { model: '', reasoningEffort: '', serviceTier: 'default' });
  const [second] = engine.enqueue(chat.id, 'Continue');
  await until(() => second.status === 'completed');
  assert.equal(second.threadId, first.threadId);
  assert.equal(runtime.threads, 1);
  const resume = runtime.calls.find(c => c.method === 'thread/resume').params;
  assert.equal(resume.model, 'test-small');
  assert.equal(resume.config.model_reasoning_effort, 'light');
  assert.equal(resume.serviceTier, 'default');
  const turns = runtime.calls.filter(c => c.method === 'turn/start').map(c => c.params);
  assert.deepEqual(
    turns.map(p => [p.model, p.effort, p.serviceTier, p.serviceTierForTurn]),
    [
      ['test-deep', 'ultra', 'priority', 'priority'],
      ['test-small', 'light', 'default', 'default'],
    ],
  );
  assert.equal(second.model, 'test-small');
  assert.equal(second.reasoningEffort, 'light');
  assert.equal(second.modelSettings.requested.model, '');
  await engine.close();
  const restored = new Store(store.dir),
    nextRuntime = new Runtime(),
    nextEngine = new Engine(restored, nextRuntime, { close: async () => {} });
  try {
    const [resumed] = nextEngine.enqueue(chat.id, 'Continue after restart');
    await until(() => resumed.status === 'completed');
    assert.equal(resumed.threadId, first.threadId);
    assert.equal(nextRuntime.threads, 0);
    const turn = nextRuntime.calls.find(c => c.method === 'turn/start').params;
    assert.deepEqual(
      [turn.model, turn.effort, turn.serviceTier],
      ['test-small', 'light', 'default'],
    );
  } finally {
    await nextEngine.close();
  }
});

test('queued runs and routines resolve their own bot settings and active turns keep their captured configuration', async t => {
  const { store, runtime, engine } = fixture(t),
    first = store.data.bots[0],
    firstChat = store.data.chats[0];
  store.updateBot(first.id, {
    model: 'test-deep',
    reasoningEffort: 'ultra',
    serviceTier: 'priority',
  });
  const second = store.createBot({
    name: 'Small',
    model: 'test-small',
    reasoningEffort: 'light',
    serviceTier: 'default',
  });
  let release;
  const held = new Promise(r => (release = r));
  runtime.onTurn = async params => {
    if (params.model === 'test-deep') await held;
  };
  const [running] = engine.enqueue(firstChat.id, 'Hold first');
  await until(() => runtime.turns === 1);
  store.updateBot(first.id, {
    model: 'test-small',
    reasoningEffort: 'deep',
    serviceTier: 'default',
  });
  const [queued] = engine.enqueue(firstChat.id, 'Next');
  const routine = store.createRoutine({
    botId: second.bot.id,
    name: 'Scheduled',
    prompt: 'Check',
    minutes: 5,
  });
  routine.nextRun = new Date(0).toISOString();
  engine.tick();
  await until(() => store.data.jobs.some(j => j.source === 'routine' && j.status === 'completed'));
  release();
  await until(() => running.status === 'completed' && queued.status === 'completed');
  assert.equal(running.model, 'test-deep');
  assert.equal(running.reasoningEffort, 'ultra');
  assert.equal(queued.model, 'test-small');
  assert.equal(queued.reasoningEffort, 'deep');
  const scheduled = store.data.jobs.find(j => j.source === 'routine');
  assert.equal(scheduled.reasoningEffort, 'light');
  assert.equal(scheduled.serviceTier, 'default');
});

test('cold catalog outage reuses prior resolved settings and conversation until requested workspace settings change', async t => {
  const { store, engine } = fixture(t),
    chat = store.data.chats[0];
  const [first] = engine.enqueue(chat.id, 'Remember the conversation');
  await until(() => first.status === 'completed');
  assert.equal(first.model, 'test-small');
  assert.equal(first.modelSettings.workspaceModel, '');
  await engine.close();
  const restored = new Store(store.dir),
    runtime = new Runtime();
  runtime.failCatalog = true;
  runtime.failConfig = true;
  const resumed = new Engine(restored, runtime, { close: async () => {} });
  try {
    for (const text of ['Continue while offline', 'Keep this same thread']) {
      const [job] = resumed.enqueue(chat.id, text);
      await until(() => job.status === 'completed');
      assert.equal(job.threadId, first.threadId);
      assert.equal(job.model, 'test-small');
      assert.equal(job.reasoningEffort, 'light');
      assert.equal(job.serviceTier, 'default');
    }
    assert.equal(runtime.calls.filter(c => c.method === 'thread/start').length, 0);
    assert.equal(runtime.calls.filter(c => c.method === 'thread/resume').length, 2);
    restored.data.settings.model = 'test-deep';
    restored.save();
    const [changed] = resumed.enqueue(chat.id, 'Use the newly requested workspace model');
    await until(() => changed.status === 'completed');
    assert.equal(changed.model, 'test-deep');
    assert.equal(changed.modelSettings.workspaceModel, 'test-deep');
    assert.equal(runtime.calls.filter(c => c.method === 'thread/start').length, 1);
    assert.notEqual(
      runtime.calls.filter(c => c.method === 'turn/start').at(-1).params.effort,
      'light',
    );
  } finally {
    await resumed.close();
  }
});

test('delegation uses the recipient configuration and the result callback returns to the managers configuration', async t => {
  const { store, runtime, engine } = fixture(t),
    manager = store.data.bots[0];
  store.updateBot(manager.id, {
    model: 'test-deep',
    reasoningEffort: 'ultra',
    serviceTier: 'priority',
  });
  const worker = store.createBot({
    name: 'Worker',
    model: 'test-small',
    reasoningEffort: 'light',
    serviceTier: 'default',
  });
  runtime.onTurn = async params => {
    const job = engine.findJob(params.threadId);
    if (job.source === 'user')
      await engine.tool(job, 'stellarcortex_handoff', {
        botId: worker.bot.id,
        message: 'Verify the result',
      });
  };
  engine.enqueue(store.data.chats[0].id, 'Delegate the check');
  await until(
    () => store.data.jobs.length === 3 && store.data.jobs.every(j => j.status === 'completed'),
  );
  assert.deepEqual(
    store.data.jobs.map(j => [j.source, j.model, j.reasoningEffort, j.serviceTier]),
    [
      ['user', 'test-deep', 'ultra', 'priority'],
      ['handoff', 'test-small', 'light', 'default'],
      ['handoff-result', 'test-deep', 'ultra', 'priority'],
    ],
  );
});

test('catalog outages and unavailable saved selections do not block unrelated bot edits', async t => {
  const { store, runtime, engine } = fixture(t),
    bot = store.data.bots[0];
  store.updateBot(bot.id, { model: 'removed-model', reasoningEffort: 'legacy-effort' });
  await engine.models.get();
  await engine.validateBotSettings(
    { name: 'Renamed', model: 'removed-model', reasoningEffort: 'legacy-effort' },
    bot,
  );
  await assert.rejects(engine.validateBotSettings({ serviceTier: 'priority' }, bot), /unavailable/);
  runtime.failCatalog = true;
  engine.models.models = [];
  engine.models.invalidate();
  await engine.validateBotSettings({ title: 'Changed role' }, bot);
  store.updateBot(bot.id, { title: 'Changed role' });
  assert.equal(bot.model, 'removed-model');
  await assert.rejects(engine.validateBotSettings({ model: null }, bot), /must be text/);
});

test('HTTP validates combinations and exports model settings without leaking runtime config', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-model-http-')),
    runtime = new Runtime();
  const app = await createApp({ dataDir: dir, port: 0, runtime, startEngine: false });
  t.after(async () => {
    await app.close();
    const rel = path.relative(os.tmpdir(), dir);
    if (!rel.startsWith('stellarcortex-model-http-') || rel.includes(path.sep))
      throw new Error('Invalid cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.port}`,
    headers = { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' };
  const login = await fetch(base + '/api/session', {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: app.accessKey }),
  });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const account = await (await fetch(base + '/api/account', { headers })).json();
  assert.equal(account.defaultModel, 'test-small');
  assert.equal(account.models.length, 2);
  assert.equal(JSON.stringify(account).includes('never-expose-this'), false);
  const invalid = await fetch(base + '/api/bots', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Invalid', model: 'test-small', reasoningEffort: 'ultra' }),
  });
  assert.equal(invalid.status, 400);
  const created = await (
    await fetch(base + '/api/bots', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Configured',
        model: 'test-deep',
        reasoningEffort: 'ultra',
        serviceTier: 'priority',
      }),
    })
  ).json();
  const template = await (
    await fetch(base + `/api/bots/${created.bot.id}/template`, { headers })
  ).json();
  assert.equal(template.bot.serviceTier, 'priority');
  const updated = await fetch(base + `/api/bots/${created.bot.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ model: 'test-small' }),
  });
  assert.equal(updated.status, 400);
});
