import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { Kanban } from '../src/kanban.mjs';
import { createKanbanEngineExecutor } from '../src/kanban-engine.mjs';
import { hostBots } from './host-bots.mjs';
const until = async fn => {
  for (let n = 0; n < 300; n++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw Error('Expected fake engine state');
};
class Runtime extends EventEmitter {
  constructor(provider = 'codex') {
    super();
    this.provider = provider;
    this.ready = true;
    this.calls = [];
    this.turns = [];
    this.index = 0;
  }
  async start() {}
  stop() {}
  async request(method, p = {}) {
    this.calls.push({ method, p: structuredClone(p) });
    if (method === 'account/read')
      return { account: { type: this.provider === 'claude' ? 'claude' : 'chatgpt' } };
    if (method === 'model/list')
      return {
        data: [
          { id: 'test-model', model: 'test-model', isDefault: true, supportedReasoningEfforts: [] },
        ],
      };
    if (method === 'config/read') return { config: { model: 'test-model' } };
    if (method === 'thread/start' || method === 'thread/resume')
      return { thread: { id: p.threadId || `${this.provider}-${++this.index}` }, model: p.model };
    if (method === 'turn/start') {
      const turn = { id: 'turn-' + this.turns.length, threadId: p.threadId };
      this.turns.push(turn);
      return { turn: { id: turn.id } };
    }
    throw Error('Unexpected fake runtime call ' + method);
  }
  finish(turn = this.turns.at(-1), status = 'completed') {
    this.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: turn.threadId,
        item: { type: 'agentMessage', id: turn.id, text: 'Synthetic result' },
      },
    });
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId: turn.threadId, turn: { id: turn.id, status } },
    });
  }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-kanban-engine-')),
    store = hostBots(new Store(dir)),
    codex = new Runtime(),
    claude = new Runtime('claude'),
    engine = new Engine(store, codex, { close: async () => {} }, null, { providers: { claude } });
  const engines = [engine];
  t.after(async () => {
    for (const e of engines) await e.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, codex, claude, engine, engines };
}
function board(
  f,
  bots,
  executor = createKanbanEngineExecutor({ engine: f.engine, enabled: true }),
) {
  const k = new Kanban(f.store, { executor, resources: () => ({ cores: 2, memory: 2 ** 30 }) }),
    p = k.createProject({ name: 'Scoped project' });
  k.configure(p.id, { team: bots, stages: { 'in-progress': { mode: 'manual', botIds: bots } } });
  const c = k.createCard({ projectId: p.id, title: 'Scoped card' });
  k.move(c.id, 'in-progress');
  k.control(p.id, 'play');
  return { k, p, c };
}
const drain = k => Promise.all([...k.pending.values()]);
test('Engine adapter is disabled by default and does not create chats/jobs or provider turns', async t => {
  const f = fixture(t),
    a = createKanbanEngineExecutor({ engine: f.engine }),
    before = f.store.data.chats.length;
  await assert.rejects(
    a({ run: { botIds: [f.store.data.bots[0].id] }, card: {}, context: {} }),
    /disabled/,
  );
  assert.equal(f.store.data.jobs.length, 0);
  assert.equal(f.store.data.chats.length, before);
  assert.equal(f.codex.turns.length, 0);
});
test('sequential engine units preserve provider policies and tool approval denial', async t => {
  const f = fixture(t),
    a = f.store.data.bots[0],
    b = f.store.createBot({ name: 'Second', provider: 'claude' }).bot,
    { k, p, c } = board(f, [a.id, b.id]);
  const r = k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  assert.equal(f.claude.turns.length, 0);
  const job = f.store.data.jobs[0],
    write = f.engine.tool(job, 'stellarcortex_files', {
      action: 'write',
      path: 'blocked.txt',
      text: 'synthetic',
    });
  await until(() => f.store.data.approvals.some(a => a.status === 'pending'));
  f.engine.resolveApproval(f.store.data.approvals.at(-1).id, { approve: false });
  await assert.rejects(write, /declined|denied/i);
  assert.equal(fs.existsSync(path.join(f.store.dir, 'workspace', 'blocked.txt')), false);
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_handoff', { botId: b.id, message: 'Hidden work' }),
    /No implicit handoffs/,
  );
  k.control(p.id, 'pause');
  assert.equal(p.control, 'pausing');
  f.codex.finish();
  await drain(k);
  assert.equal(r.status, 'checkpointed');
  assert.equal(f.claude.turns.length, 0);
  assert.equal(r.progress.units.length, 1);
  k.control(p.id, 'resume');
  k.start(c.id);
  await until(() => f.claude.turns.length === 1);
  assert.equal(f.codex.turns.length, 1);
  f.claude.finish();
  await drain(k);
  assert.equal(r.status, 'completed');
  assert.equal(f.store.data.jobs.length, 2);
  const cp = f.codex.calls.find(x => x.method === 'thread/start').p,
    cl = f.claude.calls.find(x => x.method === 'thread/start').p;
  assert.equal(cp.approvalPolicy, 'on-request');
  assert.equal(cp.sandbox, 'workspace-write');
  assert.equal(cl.claudePermissionMode, 'manual');
  assert.match(cp.developerInstructions, /sudo|elevation/i);
});
test('persisted completed Engine unit is reused after restart reconciliation without replay', async t => {
  const f = fixture(t),
    a = f.store.data.bots[0],
    { k, p, c } = board(f, [a.id]);
  const r = k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  f.codex.finish();
  await drain(k);
  r.status = 'running';
  k.save();
  await f.engine.close();
  const store = new Store(f.dir),
    runtime = new Runtime(),
    engine = new Engine(store, runtime, { close: async () => {} });
  f.engines.push(engine);
  const recovered = new Kanban(store, {
    executor: createKanbanEngineExecutor({ engine, enabled: true }),
    resources: () => ({ cores: 2, memory: 2 ** 30 }),
  });
  assert.equal(recovered.data.runs[0].status, 'uncertain');
  recovered.reconcile(r.id, { checkpoint: 'Local completed unit inspected', retry: true });
  recovered.start(c.id);
  await drain(recovered);
  assert.equal(runtime.turns.length, 0);
  assert.equal(store.data.jobs.length, 1);
  assert.equal(recovered.data.runs[0].status, 'completed');
});
test('interrupted provider outcome is never automatically replayed', async t => {
  const f = fixture(t),
    { k, c } = board(f, [f.store.data.bots[0].id]),
    r = k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  f.codex.finish(undefined, 'interrupted');
  await drain(k);
  assert.equal(r.status, 'uncertain');
  assert.throws(
    () => k.reconcile(r.id, { checkpoint: 'Unknown external effects', retry: true }),
    /uncertain/,
  );
  assert.equal(f.codex.turns.length, 1);
  assert.equal(k.start(c.id).id, r.id);
  assert.equal(f.store.data.jobs.length, 1);
});
test('paused queued workflow job is guarded and reused when admission resumes', async t => {
  const f = fixture(t),
    bot = f.store.data.bots[0],
    { k, p, c } = board(f, [bot.id]);
  f.codex.ready = false;
  const r = k.start(c.id);
  await until(() => f.store.data.jobs.length === 1);
  assert.equal(f.codex.turns.length, 0);
  k.control(p.id, 'pause');
  await drain(k);
  assert.equal(r.status, 'checkpointed');
  f.codex.ready = true;
  f.engine.pump();
  assert.equal(f.codex.turns.length, 0);
  k.control(p.id, 'resume');
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  f.codex.finish();
  await drain(k);
  assert.equal(f.store.data.jobs.length, 1);
});
test('resource-admitted workflow units do not inherit a fixed global bot count', async t => {
  const f = fixture(t);
  f.store.data.settings.concurrency = 1;
  const bots = [
      f.store.data.bots[0].id,
      ...Array.from({ length: 2 }, (_, i) => f.store.createBot({ name: 'Parallel ' + i }).bot.id),
    ],
    k = new Kanban(f.store, {
      executor: createKanbanEngineExecutor({ engine: f.engine, enabled: true }),
      resources: () => ({ cores: 4, memory: 2 ** 32 }),
    });
  for (const bot of bots) {
    const c = k.createCard({ title: 'Independent admitted unit', botIds: [bot] });
    k.move(c.id, 'in-progress');
    k.start(c.id);
  }
  await until(() => f.codex.turns.length === 3);
  assert.equal(f.engine.active.size, 3);
  for (const turn of f.codex.turns) f.codex.finish(turn);
  await drain(k);
  assert.equal(
    k.data.runs.every(r => r.status === 'completed'),
    true,
  );
});
test('explicit abandonment retires unsubmitted units and blocks silent stage advancement', async t => {
  const f = fixture(t),
    { k, p, c } = board(f, [f.store.data.bots[0].id]);
  f.codex.ready = false;
  const run = k.start(c.id);
  await until(() => f.store.data.jobs.length === 1);
  k.control(p.id, 'stop');
  await drain(k);
  assert.equal(run.status, 'checkpointed');
  assert.equal(f.store.data.jobs[0].status, 'deferred');
  assert.throws(() => k.move(c.id, 'approval'), /Finish|reconcile/);
  k.reconcile(run.id, { checkpoint: 'Abandon remaining unsubmitted work', retry: false });
  assert.equal(f.store.data.jobs[0].status, 'interrupted');
  f.codex.ready = true;
  f.engine.pump();
  assert.equal(f.codex.turns.length, 0);
  k.move(c.id, 'approval');
  assert.equal(c.stage, 'approval');
});
test('pause during provider initialization defers before turn submission', async t => {
  const f = fixture(t),
    { k, p, c } = board(f, [f.store.data.bots[0].id]),
    request = f.codex.request.bind(f.codex);
  let release;
  f.codex.request = async (method, params) => {
    if (method === 'account/read') await new Promise(r => (release = r));
    return request(method, params);
  };
  const run = k.start(c.id);
  await until(() => !!release);
  k.control(p.id, 'pause');
  release();
  await drain(k);
  assert.equal(f.codex.turns.length, 0);
  assert.equal(run.status, 'checkpointed');
  assert.equal(f.store.data.jobs[0].status, 'deferred');
  f.codex.request = request;
  k.control(p.id, 'resume');
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  f.codex.finish();
  await drain(k);
  assert.equal(f.store.data.jobs.length, 1);
});
test('operational adapter routes structured results through Engine and preserves final approval', async t => {
  const f = fixture(t),
    { k, p, c } = board(
      f,
      [f.store.data.bots[0].id],
      createKanbanEngineExecutor({ engine: f.engine, enabled: true, requireReports: true }),
    );
  const r = k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  const job = f.store.data.jobs[0];
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_kanban_result', {
      kind: 'validation-passed',
      evidence: 'Prose is not proof',
    }),
    /Invalid outcome/,
  );
  await f.engine.tool(job, 'stellarcortex_kanban_result', {
    kind: 'task-completed',
    evidence: 'Explicit fake-provider task report; user must review',
  });
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_memory', { action: 'save', text: 'No more effects' }),
    /finish the turn/,
  );
  f.codex.finish();
  await drain(k);
  assert.equal(c.stage, 'approval');
  assert.equal(r.simulated, false);
  assert.equal(k.data.approvals[0].status, 'pending');
  await k.tick();
  assert.equal(f.codex.turns.length, 1);
  k.decide(k.data.approvals[0].id, true);
  assert.equal(c.stage, 'done');
});
test('validation cannot pass from prose, invented or failed receipts; approved command receipt is required', async t => {
  const f = fixture(t),
    { k, p, c } = board(
      f,
      [f.store.data.bots[0].id],
      createKanbanEngineExecutor({ engine: f.engine, enabled: true, requireReports: true }),
    );
  c.kind = 'idea';
  k.enter(c, 'testing');
  k.configure(p.id, { stages: { testing: { mode: 'manual', botIds: [f.store.data.bots[0].id] } } });
  let calls = 0;
  f.engine.runProcess = async () => {
    calls++;
    return {
      exitCode: 0,
      stdout: 'Fake approved check',
      stderr: '',
      timedOut: false,
      cancelled: false,
      truncated: false,
    };
  };
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  const job = f.store.data.jobs[0];
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_kanban_result', {
      kind: 'validation-passed',
      evidence: 'All tests passed',
    }),
    /receipts/,
  );
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_kanban_result', {
      kind: 'validation-passed',
      evidence: 'x',
      receiptIds: ['invented'],
    }),
    /exact stage job/,
  );
  const check = f.engine.tool(job, 'stellarcortex_shell', { command: 'fake-check', args: [] });
  await until(() => f.store.data.approvals.some(a => a.status === 'pending'));
  assert.equal(calls, 0);
  f.engine.resolveApproval(f.store.data.approvals.at(-1).id, { approve: true });
  const output = JSON.parse((await check)[0].text);
  assert.equal(calls, 1);
  await f.engine.tool(job, 'stellarcortex_kanban_result', {
    kind: 'validation-passed',
    evidence: 'Only the approved fake check exited 0',
    receiptIds: [output.receiptId],
  });
  f.codex.finish();
  await drain(k);
  assert.equal(c.stage, 'approval');
  assert.match(c.lastProgress.evidence, /coverage require user review/);
  assert.equal(k.data.approvals[0].status, 'pending');
});
test('missing structured result creates explicit failed work and never fabricates a successful transition', async t => {
  const f = fixture(t),
    { k, c } = board(
      f,
      [f.store.data.bots[0].id],
      createKanbanEngineExecutor({ engine: f.engine, enabled: true, requireReports: true }),
    );
  const entry = c.entryId,
    r = k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  f.codex.finish();
  await drain(k);
  assert.equal(c.stage, 'in-progress');
  assert.equal(c.lastProgress.kind, 'work-failed');
  assert.equal(c.requiresUserStart, true);
  assert.equal(k.data.approvals.length, 0);
  assert.equal(k.start(c.id, { entryId: entry }).id, r.id);
  await k.tick();
  assert.equal(f.codex.turns.length, 1);
});
test('pause rechecks pending operation approval and blocks further effects without killing the turn', async t => {
  const f = fixture(t),
    { k, p, c } = board(
      f,
      [f.store.data.bots[0].id],
      createKanbanEngineExecutor({ engine: f.engine, enabled: true, requireReports: true }),
    );
  let processes = 0;
  f.engine.runProcess = async () => {
    processes++;
    return { exitCode: 0 };
  };
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  const job = f.store.data.jobs[0],
    check = f.engine.tool(job, 'stellarcortex_shell', { command: 'fake-check' });
  await until(() => f.store.data.approvals.some(a => a.status === 'pending'));
  k.control(p.id, 'pause');
  assert.equal(p.control, 'pausing');
  assert.equal(f.store.data.approvals.at(-1).status, 'expired');
  await assert.rejects(check, /declined/);
  assert.equal(processes, 0);
  await assert.rejects(
    f.engine.tool(job, 'stellarcortex_files', { action: 'write', path: 'x', text: 'blocked' }),
    /paused/,
  );
  await f.engine.tool(job, 'stellarcortex_kanban_result', {
    kind: 'work-failed',
    evidence: 'Paused; action was not executed',
  });
  f.codex.finish();
  await drain(k);
  assert.equal(p.control, 'paused');
  assert.equal(f.codex.turns.length, 1);
});
test('real adapter never auto-dispatches configured automatic work', async t => {
  const f = fixture(t),
    { k, p, c } = board(
      f,
      [f.store.data.bots[0].id],
      createKanbanEngineExecutor({ engine: f.engine, enabled: true, requireReports: true }),
    );
  k.configure(p.id, {
    stages: { 'in-progress': { mode: 'automatic', botIds: [f.store.data.bots[0].id] } },
  });
  await k.tick();
  assert.equal(f.codex.turns.length, 0);
  assert.equal(k.data.runs.length, 0);
});
test('structured completed report survives restart and reconciliation without a second provider turn', async t => {
  const f = fixture(t),
    { k, c } = board(
      f,
      [f.store.data.bots[0].id],
      createKanbanEngineExecutor({ engine: f.engine, enabled: true, requireReports: true }),
    );
  const r = k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  await f.engine.tool(f.store.data.jobs[0], 'stellarcortex_kanban_result', {
    kind: 'task-completed',
    evidence: 'Fake recorded result before restart',
  });
  f.codex.finish();
  await drain(k);
  c.stage = r.stage;
  c.entryId = r.entryId;
  k.data.approvals = [];
  r.status = 'running';
  delete r.transitionApplied;
  k.save();
  await f.engine.close();
  const store = new Store(f.dir),
    runtime = new Runtime(),
    engine = new Engine(store, runtime, { close: async () => {} });
  f.engines.push(engine);
  const recovered = new Kanban(store, {
    executor: createKanbanEngineExecutor({ engine, enabled: true, requireReports: true }),
    resources: () => ({ cores: 2, memory: 2 ** 30 }),
  });
  recovered.reconcile(r.id, {
    checkpoint: 'Reviewed persisted completed report and real effects',
    retry: true,
  });
  recovered.start(c.id);
  await drain(recovered);
  assert.equal(runtime.turns.length, 0);
  assert.equal(store.data.jobs.length, 1);
  assert.equal(recovered.card(c.id).stage, 'approval');
  assert.equal(recovered.data.approvals.length, 1);
});
test('assignment explicitly selects existing agents and never starts work by itself', t => {
  const f = fixture(t),
    k = new Kanban(f.store, {
      executor: createKanbanEngineExecutor({
        engine: f.engine,
        enabled: true,
        requireReports: true,
      }),
    }),
    p = k.createProject({ name: 'Empty board' }),
    c = k.createCard({
      projectId: p.id,
      title: 'Selected agent',
      botIds: [f.store.data.bots[0].id],
    });
  assert.equal(c.assignmentMode, 'card');
  assert(p.team.includes(f.store.data.bots[0].id));
  assert.equal(k.data.runs.length, 0);
  assert.equal(f.codex.turns.length, 0);
  assert.throws(() => k.assignCard(c.id, ['missing']), /existing/);
  k.assignCard(c.id, []);
  assert.equal(c.assignmentMode, 'stage');
});
test('automatic email eligibility inspects only existing local capability metadata and grants nothing', t => {
  const f = fixture(t),
    bot = f.store.data.bots[0],
    executor = createKanbanEngineExecutor({ engine: f.engine, enabled: true });
  let reads = 0;
  f.engine.connections = {
    google: {
      permittedTools: () => {
        reads++;
        return [];
      },
    },
  };
  assert.equal(executor.routingEligibility(bot, 'email').allowed, false);
  assert.equal(f.codex.calls.length, 0);
  f.engine.connections.google.permittedTools = () => [{ name: 'gmail_get_message' }];
  assert.equal(executor.routingEligibility(bot, 'email').allowed, true);
  assert.equal(reads, 1);
  assert.equal(f.codex.calls.length, 0);
});
test('a tainted stage unit taints later units and later runs of the card, in other bots too', async t => {
  const f = fixture(t),
    a = f.store.data.bots[0],
    b = f.store.createBot({ name: 'Second' }).bot,
    { k, c } = board(f, [a.id, b.id]);
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  await f.engine.taint(f.store.data.jobs[0]);
  f.codex.finish();
  await until(() => f.codex.turns.length === 2);
  const second = f.store.data.jobs[1];
  assert.equal(second.botId, b.id);
  assert.equal(second.external, true);
  assert.equal(f.store.chat(second.chatId).externalContent, true);
  assert.equal(
    f.codex.calls.filter(call => call.method === 'thread/start').at(-1).p.sandbox,
    'read-only',
  );
  f.codex.finish();
  await drain(k);
});
test('a clean card keeps its stage units clean', async t => {
  const f = fixture(t),
    a = f.store.data.bots[0],
    b = f.store.createBot({ name: 'Second' }).bot,
    { k, c } = board(f, [a.id, b.id]);
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  f.codex.finish();
  await until(() => f.codex.turns.length === 2);
  assert.equal(f.store.data.jobs[1].external, undefined);
  f.codex.finish();
  await drain(k);
});
test('a page in one stage carries to the next unit, so its mail read closes navigation, and hosts come only from the card', async t => {
  const f = fixture(t),
    a = f.store.data.bots[0],
    b = f.store.createBot({ name: 'Second' }).bot,
    { k, c } = board(f, [a.id, b.id]);
  c.initialText = 'Use trusted.example';
  k.save();
  k.start(c.id);
  await until(() => f.codex.turns.length === 1);
  const first = f.store.data.jobs[0];
  assert.deepEqual(first.ownerHosts, ['trusted.example']);
  await f.engine.taint(first);
  f.engine.markSensitive(first);
  f.codex.finish();
  await until(() => f.codex.turns.length === 2);
  const second = f.store.data.jobs[1];
  assert.equal(second.pageRead, true);
  assert.equal(second.sensitive, true);
  assert.deepEqual(second.ownerHosts, ['trusted.example']);
  f.engine.markSensitive(second);
  assert.equal(second.navClosed, true);
  f.codex.finish();
  await drain(k);
});
