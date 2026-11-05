import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTaskScope } from '../public/voice-chat.js';

const job = (id, other = {}) => ({
  id,
  rootJobId: id,
  chatId: 'chat',
  botId: 'stellar',
  status: 'completed',
  ...other,
});
const message = (jobId, text, other = {}) => ({
  jobId,
  chatId: 'chat',
  botId: 'stellar',
  role: 'assistant',
  text,
  ...other,
});
test('voice speaks only final replies from its bot and task tree, including delegated callbacks', () => {
  const scope = new VoiceTaskScope({ chatId: 'chat', botId: 'stellar' });
  const { generation } = scope.beginUtterance();
  scope.accept([job('root')], generation);
  const jobs = [
    job('history'),
    job('root'),
    job('child', { rootJobId: 'root', botId: 'other' }),
    job('callback', { rootJobId: 'root', source: 'handoff-result' }),
    job('stream', { rootJobId: 'root', status: 'running' }),
  ];
  const messages = [
    message('history', 'old'),
    message('root', 'commentary'),
    message('root', 'final answer'),
    message('child', 'child answer', { botId: 'other' }),
    message('callback', 'delegated final'),
    message('stream', 'partial'),
  ];
  assert.deepEqual(
    scope.takeReplies(jobs, messages).map(reply => reply.text),
    ['final answer', 'delegated final'],
  );
  assert.deepEqual(scope.takeReplies(jobs, messages), []);
});
test('new utterance invalidates stale replies and a late enqueue is returned for cancellation', () => {
  const scope = new VoiceTaskScope({ chatId: 'chat', botId: 'stellar' });
  const first = scope.beginUtterance();
  scope.accept([job('old')], first.generation);
  const next = scope.beginUtterance();
  assert.deepEqual(next.roots, ['old']);
  assert.equal(scope.current(first.generation), false);
  assert.deepEqual(scope.accept([job('late')], first.generation), {
    accepted: false,
    roots: ['late'],
  });
  scope.accept([job('new')], next.generation);
  assert.deepEqual(
    scope
      .takeReplies([job('old'), job('new')], [message('old', 'stale'), message('new', 'fresh')])
      .map(reply => reply.text),
    ['fresh'],
  );
  assert.deepEqual(scope.close(), ['old', 'late', 'new']);
  assert.equal(scope.current(next.generation), false);
});
test('pending work includes delegated children but excludes unrelated jobs and completed roots', () => {
  const scope = new VoiceTaskScope({ chatId: 'chat', botId: 'stellar' });
  scope.accept([job('root')], scope.beginUtterance().generation);
  assert.deepEqual(
    scope
      .pending([
        job('root'),
        job('child', { rootJobId: 'root', chatId: 'elsewhere', botId: 'other', status: 'waiting' }),
        job('unrelated', { status: 'running' }),
      ])
      .map(item => item.id),
    ['child'],
  );
  scope.close();
  assert.deepEqual(scope.takeReplies([job('root')], [message('root', 'late')]), []);
});
test('completed replies play in completion order even when API jobs are newest first', () => {
  const scope = new VoiceTaskScope({ chatId: 'chat', botId: 'stellar' });
  scope.accept([job('root')], scope.beginUtterance().generation);
  const jobs = [
    job('callback', { rootJobId: 'root', completedAt: '2026-10-26T10:03:00Z' }),
    job('root', { completedAt: '2026-10-26T10:00:00Z' }),
  ];
  assert.deepEqual(
    scope
      .takeReplies(jobs, [message('root', 'initial final'), message('callback', 'follow-up final')])
      .map(item => item.text),
    ['initial final', 'follow-up final'],
  );
});
