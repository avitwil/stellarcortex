import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine, TOOLS_VERSION } from '../src/engine.mjs';

const directories = [];
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-team-test-'));
  directories.push(dir);
  return new Store(dir);
}
after(() => {
  for (const dir of directories) {
    const relative = path.relative(os.tmpdir(), dir);
    if (!relative.startsWith('stellarcortex-team-test-') || relative.includes(path.sep))
      throw new Error('Unsafe cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected team state not reached');
}
const result = items => JSON.parse(items[0].text);
class Runtime extends EventEmitter {
  constructor() {
    super();
    this.ready = true;
    this.calls = [];
    this.threads = 0;
    this.turns = 0;
    this.active = 0;
    this.peak = 0;
    this.onTurn = async () => ({ text: 'Done' });
  }
  async start() {
    this.ready = true;
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start') return { thread: { id: `team-thread-${++this.threads}` } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      const turnId = `team-turn-${++this.turns}`;
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      setTimeout(async () => {
        let output;
        try {
          output = await this.onTurn(params);
        } catch (error) {
          output = { error: error.message };
        }
        if (output.text)
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId: params.threadId,
              item: { type: 'agentMessage', id: turnId, text: output.text },
            },
          });
        this.active--;
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: {
              id: turnId,
              status: output.error ? 'failed' : 'completed',
              error: output.error ? { message: output.error } : null,
            },
          },
        });
      }, 5);
      return { turn: { id: turnId } };
    }
    return {};
  }
  stop() {
    this.ready = false;
  }
}
const browser = { close: async () => {} };
function origin(s) {
  return {
    id: 'origin',
    rootJobId: 'origin',
    botId: s.data.bots[0].id,
    chatId: s.data.chats[0].id,
    depth: 0,
    lineageBotIds: [],
    text: 'User asked for a team and a verified answer',
    status: 'completed',
  };
}

test('a bot can create and update the explicitly requested persistent team and group', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const job = origin(s);
  const a = result(
    await e.tool(job, 'stellarcortex_team', {
      action: 'create',
      name: 'Analyst',
      title: 'Data analysis',
      instructions: 'Check the supplied figures',
    }),
  );
  assert.equal(a.created, true);
  assert.equal(s.bot(a.bot.id).managerBotId, job.botId);
  assert.equal(s.bot(a.bot.id).scope, 'persistent');
  const same = result(
    await e.tool(job, 'stellarcortex_team', { action: 'create', name: 'Analyst' }),
  );
  assert.equal(same.reused, true);
  assert.equal(s.data.bots.length, 2);
  await e.tool(job, 'stellarcortex_team', {
    action: 'update',
    botId: a.bot.id,
    title: 'Verified data analysis',
  });
  assert.equal(s.bot(a.bot.id).title, 'Verified data analysis');
  const group = result(
    await e.tool(job, 'stellarcortex_team', {
      action: 'group',
      name: 'Requested team',
      botIds: [job.botId, a.bot.id],
    }),
  ).group;
  assert.equal(group.managerBotId, job.botId);
  assert.deepEqual(group.botIds, [job.botId, a.bot.id]);
  const list = result(await e.tool(job, 'stellarcortex_team', { action: 'list' }));
  assert.equal(list.groups.length, 1);
  assert.equal(list.bots.length, 2);
});

test('delegation returns the actual result and wakes the origin even with concurrency one', async t => {
  const s = store(),
    c = new Runtime(),
    e = new Engine(s, c, browser);
  t.after(() => e.close());
  s.data.settings.concurrency = 1;
  const worker = s.createBot({ name: 'Analyst' }),
    chat = s.data.chats[0];
  c.onTurn = async params => {
    const job = e.findJob(params.threadId);
    if (job.source === 'user') {
      await e.tool(job, 'stellarcortex_handoff', {
        botId: worker.bot.id,
        message: 'Calculate six times seven',
      });
      return { text: 'The analyst is working.' };
    }
    if (job.source === 'handoff') return { text: 'The checked result is 42.' };
    assert.equal(job.source, 'handoff-result');
    assert.match(params.input[0].text, /checked result is 42/);
    return { text: 'Final answer: 42, verified by the analyst.' };
  };
  e.enqueue(chat.id, 'Ask the analyst to calculate six times seven');
  await until(() => s.data.jobs.length === 3 && s.data.jobs.every(j => j.status === 'completed'));
  assert.equal(c.peak, 1);
  const delegated = s.data.jobs.find(j => j.source === 'handoff'),
    callback = s.data.jobs.find(j => j.source === 'handoff-result');
  assert.equal(callback.resultForJobId, delegated.id);
  assert.equal(callback.chatId, chat.id);
  assert.equal(callback.botId, s.data.bots[0].id);
  assert.match(delegated.result, /42/);
  assert.ok(delegated.reportedAt);
  assert.equal(s.data.messages.filter(m => m.kind === 'handoff-result').length, 1);
  assert.match(
    s.data.messages.filter(m => m.chatId === chat.id && m.role === 'assistant').at(-1).text,
    /Final answer: 42/,
  );
});

test('nested handoffs return to each delegator without circular delegation', async t => {
  const s = store(),
    c = new Runtime(),
    e = new Engine(s, c, browser);
  t.after(() => e.close());
  s.data.settings.concurrency = 1;
  const b = s.createBot({ name: 'Coordinator' }),
    d = s.createBot({ name: 'Verifier' });
  c.onTurn = async params => {
    const job = e.findJob(params.threadId);
    if (job.source === 'user') {
      await e.tool(job, 'stellarcortex_handoff', {
        botId: b.bot.id,
        message: 'Obtain a verified result',
      });
      return { text: 'Assigned.' };
    }
    if (job.botId === b.bot.id && job.source === 'handoff') {
      await assert.rejects(
        e.tool(job, 'stellarcortex_handoff', {
          botId: s.data.bots[0].id,
          message: 'Do my assignment',
        }),
        /ancestor/,
      );
      await e.tool(job, 'stellarcortex_handoff', { botId: d.bot.id, message: 'Verify 2 + 2' });
      return { text: 'Verification pending.' };
    }
    if (job.botId === d.bot.id) return { text: 'Verified: 2 + 2 = 4.' };
    return {
      text:
        job.botId === b.bot.id
          ? 'Final coordinator result: 4.'
          : 'Received the coordinator result.',
    };
  };
  e.enqueue(s.data.chats[0].id, 'Coordinate a verified calculation');
  await until(() => s.data.jobs.length === 6 && s.data.jobs.every(j => j.status === 'completed'));
  const sourceResults = s.data.messages.filter(
    m => m.chatId === s.data.chats[0].id && m.kind === 'handoff-result',
  );
  assert.equal(sourceResults.length, 2);
  assert.match(sourceResults.at(-1).text, /Final coordinator result: 4/);
  assert.equal(c.peak, 1);
});

test('failed delegated jobs report failure and duplicate deliveries survive restart recovery', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const parent = origin(s);
  s.data.jobs.push(parent);
  const worker = s.createBot({ name: 'Worker' }),
    first = result(
      await e.tool(parent, 'stellarcortex_handoff', {
        botId: worker.bot.id,
        message: 'Read the supplied file',
      }),
    );
  const repeated = result(
    await e.tool(parent, 'stellarcortex_handoff', {
      botId: worker.bot.id,
      message: 'Read   the supplied file',
    }),
  );
  assert.equal(first.jobId, repeated.jobId);
  assert.equal(repeated.reused, true);
  const child = s.data.jobs.find(j => j.id === first.jobId);
  Object.assign(child, { status: 'failed', error: 'File was not provided' });
  e.finishResult(child);
  assert.equal(s.data.jobs.filter(j => j.source === 'handoff-result').length, 1);
  assert.match(child.result, /not provided/);
  delete child.reportedAt;
  delete child.callbackJobId;
  delete child.resultMessageId;
  s.save();
  const reloaded = new Store(s.dir),
    other = new Runtime();
  other.ready = false;
  const resumed = new Engine(reloaded, other, browser);
  t.after(() => resumed.close());
  resumed.recoverResults();
  resumed.recoverResults();
  assert.equal(reloaded.data.jobs.filter(j => j.source === 'handoff-result').length, 1);
  assert.equal(reloaded.data.messages.filter(m => m.kind === 'handoff-result').length, 1);
  const status = result(await resumed.tool(parent, 'stellarcortex_tasks', { jobId: child.id }));
  assert.equal(status.tasks[0].status, 'failed');
  assert.match(status.tasks[0].result, /not provided/);
});

test('old chats migrate dynamic tools once and retain saved conversation context', async t => {
  const s = store(),
    c = new Runtime(),
    e = new Engine(s, c, browser);
  t.after(() => e.close());
  const chat = s.data.chats[0],
    bot = s.data.bots[0];
  bot.computer = 'host';
  chat.threadIds[bot.id] = 'legacy-thread';
  s.message(chat.id, 'user', 'Keep my existing project context');
  e.enqueue(chat.id, 'Create the requested team');
  await until(() => s.data.jobs[0].status === 'completed');
  const start = c.calls.find(call => call.method === 'thread/start');
  assert.ok(start.params.dynamicTools.some(tool => tool.name === 'stellarcortex_team'));
  assert.ok(start.params.dynamicTools.some(tool => tool.name === 'stellarcortex_computer'));
  assert.match(start.params.developerInstructions, /only at the user's explicit request/);
  assert.equal(chat.previousThreadIds[bot.id][0].threadId, 'legacy-thread');
  assert.equal(chat.threadToolVersions[bot.id], TOOLS_VERSION);
  assert.match(
    c.calls.find(call => call.method === 'turn/start').params.input[0].text,
    /existing project context/,
  );
  e.enqueue(chat.id, 'Continue');
  await until(() => s.data.jobs[1].status === 'completed');
  assert.equal(c.threads, 1);
  assert.equal(c.calls.filter(call => call.method === 'thread/resume').length, 1);
});

test('deleting a bot stops queued work, pauses routines and preserves recoverable history', async t => {
  const s = store(),
    c = new Runtime(),
    removed = [];
  c.ready = false;
  const e = new Engine(s, c, browser, {
    removeBot: async id => removed.push(id),
    close: async () => {},
  });
  t.after(() => e.close());
  const worker = s.createBot({ name: 'Recoverable' });
  s.message(worker.chat.id, 'user', 'Keep this history');
  const routine = s.createRoutine({ botId: worker.bot.id, name: 'Daily', prompt: 'Report' });
  const group = s.createGroup({ name: 'Group', botIds: [s.data.bots[0].id, worker.bot.id] });
  const [queued] = e.enqueue(worker.chat.id, 'Pending task');
  const deleted = await e.deleteBot(worker.bot.id);
  assert.deepEqual(removed, [worker.bot.id]);
  assert.equal(deleted.stoppedTasks, 1);
  assert.equal(queued.status, 'interrupted');
  assert.equal(routine.enabled, false);
  assert.ok(worker.bot.deletedAt);
  assert.throws(() => e.enqueue(worker.chat.id, 'More'), /no active bots/);
  const remaining = e.enqueue(group.id, 'Continue with available teammates');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].botId, s.data.bots[0].id);
  s.restoreBot(worker.bot.id);
  assert.equal(worker.bot.deletedAt, undefined);
  assert.equal(worker.bot.hidden, false);
  assert.equal(routine.enabled, false);
  assert.ok(s.data.messages.some(m => m.text === 'Keep this history'));
});

test('a deleted origin receives history but is never awakened by a late result', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const parent = origin(s);
  s.data.jobs.push(parent);
  const worker = s.createBot({ name: 'Worker' });
  const task = result(
    await e.tool(parent, 'stellarcortex_handoff', {
      botId: worker.bot.id,
      message: 'Finish the work',
    }),
  );
  s.deleteBot(parent.botId);
  const child = s.data.jobs.find(j => j.id === task.jobId);
  Object.assign(child, { status: 'completed', result: 'Finished' });
  e.deliverResult(child);
  assert.ok(child.reportSuppressed);
  assert.equal(s.data.jobs.filter(j => j.source === 'handoff-result').length, 0);
  assert.equal(s.data.messages.filter(m => m.kind === 'handoff-result').length, 1);
});

test('desktop input waits for approval and a completed task releases desktop ownership', async t => {
  const s = store(),
    c = new Runtime(),
    actions = [],
    released = [];
  const desktop = {
    status: async () => ({ enabled: true }),
    acquire: async () => {},
    release: id => released.push(id),
    snapshot: async () => ({
      image: 'aGVsbG8=',
      mimeType: 'image/png',
      frameId: 'frame-1',
      width: 100,
      height: 100,
    }),
    action: async (_bot, args) => actions.push(args),
    close: async () => {},
  };
  s.data.bots[0].computer = 'host';
  const e = new Engine(s, c, browser, desktop);
  t.after(() => e.close());
  c.onTurn = async params => {
    const job = e.findJob(params.threadId);
    if (job.openShell) {
      await assert.rejects(
        e.tool(job, 'stellarcortex_computer', { action: 'screenshot' }),
        /restarts automatically/,
      );
      return { text: 'Restarting' };
    }
    const pending = e.tool(job, 'stellarcortex_computer', {
      action: 'click',
      x: 20,
      y: 30,
      frameId: 'frame-1',
    });
    await until(() => s.data.approvals.some(a => a.status === 'pending'));
    assert.equal(actions.length, 0);
    e.resolveApproval(s.data.approvals.at(-1).id, { approve: true });
    const shot = await pending;
    assert.equal(shot[1].type, 'inputImage');
    return { text: 'Clicked and inspected the desktop' };
  };
  const [job] = e.enqueue(s.data.chats[0].id, 'Click the specified desktop control');
  await until(() => job.status === 'completed' && released.includes(job.id));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].frameId, 'frame-1');
});

test('plain group messages select one owner, then last speaker, then first available member', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const a = s.data.bots[0],
    b = s.createBot({ name: 'Second' }).bot,
    d = s.createBot({ name: 'Third' }).bot;
  const group = s.createGroup({ name: 'Owners', botIds: [a.id, b.id, d.id], managerBotId: b.id });
  s.message(group.id, 'assistant', 'Previous reply', { botId: d.id });
  assert.deepEqual(
    e.enqueue(group.id, 'Plain message').map(j => j.botId),
    [b.id],
  );
  delete group.managerBotId;
  assert.deepEqual(
    e.enqueue(group.id, 'Follow up').map(j => j.botId),
    [d.id],
  );
  const empty = s.createGroup({ name: 'New group', botIds: [b.id, a.id] });
  assert.deepEqual(
    e.enqueue(empty.id, 'Start').map(j => j.botId),
    [b.id],
  );
  assert.equal(s.data.messages.find(m => m.text === 'Plain message').recipientBotIds.length, 1);
});

test('group replies target their author while explicit recipients and everyone remain supported', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const a = s.data.bots[0],
    b = s.createBot({ name: 'Second' }).bot,
    d = s.createBot({ name: 'Third' }).bot,
    group = s.createGroup({ name: 'Replies', botIds: [a.id, b.id, d.id], managerBotId: a.id });
  const message = s.message(group.id, 'assistant', 'Review my draft', { botId: b.id });
  const reply = e.enqueue(group.id, 'Revise this section', { replyTo: message.id });
  assert.equal(reply.length, 1);
  assert.equal(reply[0].botId, b.id);
  assert.equal(reply[0].replyTo, message.id);
  assert.deepEqual(
    e
      .enqueue(group.id, 'Both review', { botIds: [a.id, d.id], replyTo: message.id })
      .map(j => j.botId),
    [a.id, d.id],
  );
  assert.deepEqual(
    e.enqueue(group.id, 'Everyone report', { everyone: true }).map(j => j.botId),
    [a.id, b.id, d.id],
  );
  const foreign = s.message(s.data.chats[0].id, 'assistant', 'Private reply', { botId: a.id });
  assert.throws(
    () => e.enqueue(group.id, 'Wrong quote', { replyTo: foreign.id }),
    /must belong to this conversation/,
  );
  assert.throws(
    () => e.enqueue(group.id, 'Missing quote', { replyTo: 'missing' }),
    /must belong to this conversation/,
  );
  s.deleteBot(d.id);
  assert.deepEqual(
    e.enqueue(group.id, 'Everyone still here', { everyone: true }).map(j => j.botId),
    [a.id, b.id],
  );
});

test('bot-to-group messages wake one owner and preserve a visible reply-linked transfer', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const parent = origin(s);
  s.data.jobs.push(parent);
  const b = s.createBot({ name: 'Group owner' }).bot,
    d = s.createBot({ name: 'Reviewer' }).bot,
    group = s.createGroup({ name: 'Destination', botIds: [b.id, d.id], managerBotId: b.id });
  const sent = result(
    await e.tool(parent, 'stellarcortex_handoff', {
      chatId: group.id,
      message: 'Please review the proposal',
    }),
  );
  assert.equal(sent.recipientBotId, b.id);
  const task = s.data.jobs.find(j => j.id === sent.jobId);
  assert.equal(task.parentJobId, parent.id);
  assert.equal(task.chatId, group.id);
  assert.equal(task.requestText, 'Please review the proposal');
  const transfer = s.data.messages.find(m => m.chatId === group.id && m.kind === 'handoff');
  assert.equal(transfer.fromBotId, parent.botId);
  assert.equal(transfer.toBotId, b.id);
  assert.equal(transfer.requestText, 'Please review the proposal');
  const question = s.message(group.id, 'assistant', 'Which proposal version?', { botId: d.id });
  const answered = result(
    await e.tool(parent, 'stellarcortex_handoff', {
      chatId: group.id,
      inReplyTo: question.id,
      message: 'Use version two',
    }),
  );
  assert.equal(answered.recipientBotId, d.id);
  assert.equal(s.data.jobs.find(j => j.id === answered.jobId).replyTo, question.id);
  Object.assign(task, { status: 'completed', result: 'Group review is complete' });
  e.deliverResult(task);
  assert.equal(
    s.data.messages.filter(m => m.chatId === parent.chatId && m.kind === 'handoff-result').length,
    1,
  );
});

test('in-group delegation stays visible once and cannot route back to itself or an ancestor', async t => {
  const s = store(),
    c = new Runtime();
  c.ready = false;
  const e = new Engine(s, c, browser);
  t.after(() => e.close());
  const a = s.data.bots[0],
    b = s.createBot({ name: 'Member' }).bot,
    group = s.createGroup({ name: 'Shared', botIds: [a.id, b.id], managerBotId: a.id });
  const parent = { ...origin(s), chatId: group.id };
  s.data.jobs.push(parent);
  const sent = result(
    await e.tool(parent, 'stellarcortex_handoff', {
      chatId: group.id,
      message: 'Handle the review',
    }),
  );
  assert.equal(sent.recipientBotId, b.id);
  assert.equal(
    s.data.messages.filter(m => m.kind === 'handoff' && m.jobId === sent.jobId).length,
    1,
  );
  const child = s.data.jobs.find(j => j.id === sent.jobId);
  await assert.rejects(
    e.tool(child, 'stellarcortex_handoff', {
      chatId: group.id,
      botId: a.id,
      message: 'Return the task',
    }),
    /ancestor/,
  );
  await assert.rejects(
    e.tool(child, 'stellarcortex_handoff', { chatId: group.id, message: 'Someone do the task' }),
    /no active bots/,
  );
});
