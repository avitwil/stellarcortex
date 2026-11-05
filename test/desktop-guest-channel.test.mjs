import test from 'node:test';
import assert from 'node:assert/strict';
import { guestEnvelope, callRegisteredGuest } from '../src/desktop-guest-channel.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'one' },
  input = { scope, requestId: 'request-one', method: 'execution.ping' };
test('guest channel constructs trusted identity and rejects arbitrary transport/roster requests', () => {
  assert.equal(guestEnvelope({ cid: 151 }, input).botId, 'bot');
  assert.throws(() => guestEnvelope({ cid: 2 }, input));
  assert.throws(() => guestEnvelope({ cid: 151 }, { ...input, method: 'roster.register' }));
  assert.throws(() => guestEnvelope({ cid: 151 }, { ...input, method: 'host.shell' }));
});
test('guest transport binds reply generation and forwards input on stdin, never shell arguments', async () => {
  const run = reply =>
    callRegisteredGuest({ cid: 151 }, input, {
      spawnImpl: (command, args, options) => {
        assert.equal(command, '/usr/bin/python3');
        assert.equal(args[2], '151');
        assert.equal(options.shell, undefined);
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        child.stdin.on('finish', () => {
          child.stdout.write(JSON.stringify(reply));
          queueMicrotask(() => child.emit('exit', 0));
        });
        return child;
      },
    });
  assert.deepEqual(
    await run({ ...guestEnvelope({ cid: 151 }, input), result: { available: true } }),
    { available: true },
  );
  await assert.rejects(
    run({ ...guestEnvelope({ cid: 151 }, input), generation: 'wrong', result: {} }),
    /identity/,
  );
  await assert.rejects(run({ ...guestEnvelope({ cid: 151 }, input), uncertain: true }), /review/);
});
test('a relay refusal names its cause, counts as not run and is not an identity mismatch', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => {
      child.stdout.write(JSON.stringify({ relayError: 'The guest session registry mixes owners' }));
      queueMicrotask(() => child.emit('exit', 0));
    });
    return child;
  };
  await assert.rejects(
    callRegisteredGuest({ cid: 151 }, input, { spawnImpl }),
    error =>
      /Guest refused the request: The guest session registry mixes owners/.test(error.message) &&
      error.settled === true,
  );
});
