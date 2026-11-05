import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Claude } from '../src/claude.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-message-id-')),
    store = new Store(dir),
    runtime = new Claude({ command: { bin: 'not-used', prefix: [] }, environment: {} }),
    codex = new EventEmitter();
  codex.stop = async () => {};
  const engine = new Engine(store, codex, { close: async () => {} }, null, {
      providers: { claude: runtime },
    }),
    bot = store.data.bots[0],
    chat = store.data.chats[0],
    job = {
      id: 'job',
      botId: bot.id,
      chatId: chat.id,
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      status: 'running',
    },
    turn = {
      id: 'turn',
      closed: false,
      items: new Map(),
      messages: new Set(),
      nativeTools: new Map(),
    };
  store.data.jobs.push(job);
  engine.active.set(job.id, job);
  t.after(async () => {
    engine.active.clear();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const feed = message => runtime.handle({ id: 'thread' }, turn, message),
    event = e => feed({ type: 'stream_event', event: e });
  return { store, runtime, engine, job, turn, feed, event };
}
test('actual Claude parser -> Engine stores one message across thinking stream, final snapshot/replay and late deltas', t => {
  const f = fixture(t);
  f.event({ type: 'message_start', message: { id: 'message' } });
  f.event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  f.event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ha' } });
  f.event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ha' } });
  f.event({ type: 'content_block_stop', index: 1 });
  const final = {
    type: 'assistant',
    message: { id: 'message', content: [{ type: 'text', text: 'haha' }] },
  };
  f.feed(final);
  f.feed(final);
  f.event({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'late replay' },
  });
  const messages = f.store.data.messages.filter(m => m.role === 'assistant');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'haha');
  assert.equal(messages[0].itemId, 'message:text:0');
});
test('final-before-stop reconciles corrected content to the existing streamed message', t => {
  const f = fixture(t);
  f.event({ type: 'message_start', message: { id: 'message' } });
  f.event({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
  f.event({
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'text_delta', text: 'partial' },
  });
  f.feed({
    type: 'assistant',
    message: { id: 'message', content: [{ type: 'text', text: 'authoritative final' }] },
  });
  f.event({ type: 'content_block_stop', index: 2 });
  assert.equal(f.store.data.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(f.store.data.messages.at(-1).text, 'authoritative final');
});
test('identical legitimate blocks/messages and concurrent bots retain separate identities', t => {
  const f = fixture(t);
  f.feed({
    type: 'assistant',
    message: {
      id: 'one',
      content: [
        { type: 'text', text: 'Same' },
        { type: 'text', text: 'Same' },
      ],
    },
  });
  f.feed({ type: 'assistant', message: { id: 'two', content: [{ type: 'text', text: 'Same' }] } });
  const other = { ...f.job, id: 'other-job', threadId: 'other-thread', turnId: 'other-turn' };
  f.store.data.jobs.push(other);
  f.engine.active.set(other.id, other);
  f.engine.event(
    {
      method: 'item/completed',
      params: {
        threadId: 'other-thread',
        turnId: 'other-turn',
        item: { id: 'one:text:0', type: 'agentMessage', text: 'Same' },
      },
    },
    'claude',
  );
  assert.equal(f.store.data.messages.filter(m => m.role === 'assistant').length, 4);
  assert.equal(new Set(f.store.data.messages.map(m => m.id)).size, 4);
});
test('completed item replay is idempotent; stale prior-turn events cannot attach to a new job', t => {
  const f = fixture(t),
    p = {
      threadId: 'thread',
      turnId: 'turn',
      item: { id: 'stable', type: 'agentMessage', text: 'Final' },
    };
  f.engine.event({ method: 'item/completed', params: p }, 'claude');
  f.engine.event({ method: 'item/completed', params: p }, 'claude');
  f.engine.event(
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'stable', delta: 'replay' },
    },
    'claude',
  );
  assert.equal(f.store.data.messages.length, 1);
  assert.equal(f.store.data.messages[0].text, 'Final');
  f.job.status = 'completed';
  const next = { ...f.job, id: 'next-job', turnId: 'next-turn', status: 'running' };
  f.store.data.jobs.push(next);
  f.engine.active.delete(f.job.id);
  f.engine.active.set(next.id, next);
  f.engine.event(
    { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } },
    'claude',
  );
  f.engine.event({ method: 'item/completed', params: p }, 'claude');
  assert.equal(f.store.data.messages.length, 1);
  assert.equal(next.turnId, 'next-turn');
});
test('Engine close detaches only its own runtime listeners', async t => {
  const f = fixture(t),
    external = () => {};
  f.runtime.on('notification', external);
  const before = f.runtime.listenerCount('notification');
  assert.equal(before, 2);
  f.engine.active.clear();
  await f.engine.close();
  assert.equal(f.runtime.listenerCount('notification'), 1);
  assert.equal(f.runtime.listenerCount('request'), 0);
  f.runtime.off('notification', external);
});
