import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
import { DesktopDisplayTickets, authorizeDisplayUpgrade } from '../src/desktop-display-auth.mjs';
import { DesktopProviderLifecycle } from '../src/desktop-provider-lifecycle.mjs';
const scope = { accountId: 'owner', botId: 'a', vmId: 'vm-a', generation: 'one' };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return { resolve, promise };
};
test('conflicting input fails promptly; human claim waits for interruption and expires with cleanup', async () => {
  let time = 10,
    cleaned = 0;
  const c = new DesktopSessionCoordinator({
      clock: () => time,
      leaseMs: 10,
      releaseInputs: async () => {
        cleaned++;
      },
    }),
    entered = deferred(),
    finish = deferred(),
    events = [];
  const active = c.runAgent(scope, async () => {
    entered.resolve();
    await finish.promise;
    events.push('active');
  });
  await entered.promise;
  const queued = c.runAgent(scope, () => events.push('queued'));
  const rejection = assert.rejects(queued, /already active/);
  const claim = c.claim(scope, 'session-a');
  finish.resolve();
  const lease = await claim;
  await active;
  await rejection;
  assert.deepEqual(events, ['active']);
  assert(c.canWrite(scope, lease));
  time = 30;
  assert(!c.canWrite(scope, lease));
  await c.expire(scope);
  assert.equal(cleaned, 1);
  await c.runAgent(scope, () => events.push('new'));
  assert.equal(c.observation(scope).mode, 'agent');
});
test('failed release blocks agent resumption; another bot remains independent', async () => {
  const c = new DesktopSessionCoordinator({
      releaseInputs: async () => {
        throw Error('lost');
      },
    }),
    lease = await c.claim(scope, 'session-a');
  await assert.rejects(c.release(scope, lease), /not confirmed/);
  await assert.rejects(
    c.runAgent(scope, () => {}),
    /recovery/,
  );
  await c.runAgent({ ...scope, botId: 'b', vmId: 'vm-b' }, () => {});
  assert(!c.canWrite({ ...scope, generation: 'two' }, lease));
});
test('tickets bind exact session, bot, generation, origin and are single-use', () => {
  let now = 1;
  const t = new DesktopDisplayTickets({ clock: () => now, ttlMs: 10 }),
    args = { scope, sessionId: 'session-a', origin: 'https://app.example' },
    token = t.issue(args);
  for (const changed of [
    { sessionId: 'other' },
    { origin: 'https://evil.example' },
    { scope: { ...scope, botId: 'b' } },
    { scope: { ...scope, generation: 'two' } },
  ])
    assert.throws(() => t.consume({ ...args, ...changed, protocol: token.protocol }));
  assert.equal(t.consume({ ...args, protocol: token.protocol }).mode, 'view');
  assert.throws(() => t.consume({ ...args, protocol: token.protocol }));
  const expired = t.issue(args);
  now = 11;
  assert.throws(() => t.consume({ ...args, protocol: expired.protocol }));
});
test('upgrade cannot choose a socket path and rejects unauthenticated or cross-origin callers', () => {
  const tickets = new DesktopDisplayTickets(),
    args = { scope, sessionId: 'session-a', origin: 'https://app.example' },
    options = {
      origins: new Set([args.origin]),
      authenticate: () => ({ sessionId: args.sessionId, accountId: scope.accountId }),
      lookup: () => ({ ...scope, state: 'running' }),
      tickets,
    };
  const request = {
    method: 'GET',
    url: '/api/desktops/a/display',
    headers: { origin: args.origin, 'sec-websocket-protocol': tickets.issue(args).protocol },
  };
  assert.throws(() =>
    authorizeDisplayUpgrade({ ...request, url: request.url + '?socket=/tmp/other' }, options),
  );
  assert.throws(() =>
    authorizeDisplayUpgrade(
      { ...request, headers: { ...request.headers, origin: 'https://evil.example' } },
      options,
    ),
  );
  assert.throws(() => authorizeDisplayUpgrade(request, { ...options, authenticate: () => null }));
  assert.equal(authorizeDisplayUpgrade(request, options).scope.vmId, 'vm-a');
});
test('lifecycle is disabled before approval and rejects stale generation without calling broker', async () => {
  let calls = 0;
  const p = new DesktopProviderLifecycle({
    registry: { get: () => scope },
    broker: {
      change: async () => {
        calls++;
      },
    },
    approved: false,
  });
  await assert.rejects(
    p.change('owner', 'a', 'start', { expectedGeneration: 'one', requestId: 'request-one' }),
    /approval/,
  );
  p.approved = true;
  await assert.rejects(
    p.change('owner', 'a', 'start', { expectedGeneration: 'old', requestId: 'request-one' }),
    /generation/,
  );
  await assert.rejects(
    p.change('owner', 'a', 'destroy', { expectedGeneration: 'one', requestId: 'request-one' }),
    /Unsupported/,
  );
  assert.equal(calls, 0);
});
test('failed interruption does not leave an undisclosed human lease', async () => {
  let cleaned = 0;
  const c = new DesktopSessionCoordinator({
    onClaim: async () => {
      throw Error('Cancellation reply lost');
    },
    releaseInputs: async () => {
      cleaned++;
    },
  });
  const s = { accountId: 'owner', botId: 'bot', vmId: 'vm', generation: 'one' };
  await assert.rejects(c.claim(s, 'human'), /Could not confirm/);
  if (c.state(s).releasePromise) await c.state(s).releasePromise;
  assert.equal(c.state(s).human, null);
  assert.equal(c.observation(s).mode, 'agent');
  assert.equal(cleaned, 1);
});
