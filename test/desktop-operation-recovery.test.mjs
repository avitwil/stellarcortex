import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopEffectJournal } from '../src/desktop-effect-journal.mjs';
import { LibvirtDesktopBroker } from '../src/desktop-libvirt-broker.mjs';
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
import { GuestWorker } from '../src/guest-worker.mjs';
const scope = { accountId: 'owner', botId: 'bot', vmId: '01', generation: 'generation-one' },
  uuid = '11111111-1111-1111-1111-111111111111';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const effects = new DesktopEffectJournal(path.join(dir, 'audit.json'));
  const worker = new GuestWorker({
    vmId: '01',
    generation: scope.generation,
    allowedBots: ['bot'],
    workspace: dir,
    ledgerFile: path.join(dir, 'guest.json'),
  });
  const broker = new LibvirtDesktopBroker({
    registry: { get: () => ({ ...scope, domain: 'scx-desktop-01', uuid, cid: 151 }) },
    approved: true,
    effects,
    run: async () => ({ stdout: uuid }),
    callGuest: async (_record, input) => {
      const reply = await worker.handle({
        protocol: 'scx-guest-v1',
        vmId: '01',
        generation: scope.generation,
        botId: scope.botId,
        requestId: input.requestId,
        method: input.method,
        args: input.args,
      });
      if (reply.error || reply.uncertain) throw Error(reply.error || 'Uncertain guest operation');
      return reply.result;
    },
  });
  return { effects, worker, broker };
}
test('cancellation reaches active guest work without waiting behind its ownership queue', async t => {
  const { worker, broker, effects } = fixture(t);
  let began;
  const started = new Promise(r => (began = r));
  worker.runShell = async (_args, { signal }) => {
    began();
    return new Promise(resolve =>
      signal.addEventListener('abort', () => resolve({ stopped: 'cancelled' }), { once: true }),
    );
  };
  const provider = new DesktopProviderRuntime({ records: [scope], broker, enabled: true });
  const work = provider.agent(
    scope,
    'shell.run',
    { command: 'fixture', args: [] },
    'active-operation',
  );
  await started;
  const human = provider.coordinator.claim(scope, 'human');
  assert.deepEqual(await work, { stopped: 'cancelled' });
  const lease = await human;
  assert.equal(provider.coordinator.observation(scope).mode, 'human');
  assert.equal(effects.records['active-operation'].state, 'done');
  assert(
    Object.values(effects.records).some(
      r => r.kind === 'cancel-guest' && r.targetRequestId === 'active-operation',
    ),
  );
  provider.coordinator.releaseInputs = async () => {};
  await provider.coordinator.release(scope, lease);
});
test('cancellation before broker dispatch prevents the late original from running', async t => {
  const { broker, effects } = fixture(t);
  await broker.cancel({ scope, requestId: 'cancel-request', targetRequestId: 'not-yet-started' });
  let ran = false;
  await assert.rejects(
    effects.execute(
      { scope, requestId: 'not-yet-started', operation: { action: 'guest', method: 'shell.run' } },
      async () => (ran = true),
    ),
    /identity reused/,
  );
  assert.equal(ran, false);
  assert.equal(effects.records['not-yet-started'].state, 'cancelled-before-start');
});
test('review preserves uncertainty evidence and creates a guest no-replay tombstone', async t => {
  const { broker, effects, worker } = fixture(t);
  await assert.rejects(
    effects.execute(
      {
        scope,
        requestId: 'lost-operation',
        operation: { action: 'guest', method: 'browser.action' },
      },
      async () => {
        throw Error('transport lost');
      },
    ),
  );
  const digest = effects.records['lost-operation'].digest;
  await assert.rejects(
    broker.review({
      scope,
      targetRequestId: 'lost-operation',
      expectedDigest: digest,
      note: 'Reviewed',
      confirm: false,
    }),
    /Explicit/,
  );
  await assert.rejects(
    broker.review({
      scope: { ...scope, generation: 'old' },
      targetRequestId: 'lost-operation',
      expectedDigest: digest,
      note: 'Reviewed',
      confirm: true,
    }),
    /stale/,
  );
  await broker.review({
    scope,
    targetRequestId: 'lost-operation',
    expectedDigest: digest,
    note: 'Unknown prior effects; owner abandons without replay.',
    confirm: true,
  });
  assert.equal(effects.records['lost-operation'].state, 'reviewed-abandoned');
  assert.equal(effects.records['lost-operation'].digest, digest);
  assert.equal(worker.ledger['lost-operation'].state, 'reviewed-abandoned');
  assert(effects.records['lost-operation'].reviewAttempt);
  const late = await worker.handle({
    protocol: 'scx-guest-v1',
    vmId: '01',
    generation: scope.generation,
    botId: 'bot',
    requestId: 'lost-operation',
    method: 'browser.action',
    args: { input: { action: 'open' } },
  });
  assert.match(late.error, /identity reused/);
});
test('review refuses an active guest even if the host transport already lost confirmation', async t => {
  const { broker, effects, worker } = fixture(t);
  await assert.rejects(
    effects.execute(
      { scope, requestId: 'still-running', operation: { action: 'guest', method: 'shell.run' } },
      async () => {
        throw Error('lost');
      },
    ),
  );
  worker.ledger['still-running'] = { state: 'inflight', botId: 'bot' };
  await assert.rejects(
    broker.review({
      scope,
      targetRequestId: 'still-running',
      expectedDigest: effects.records['still-running'].digest,
      note: 'Checked',
      confirm: true,
    }),
    /still active/,
  );
  assert.equal(effects.records['still-running'].state, 'uncertain');
});
test('lost reconciliation reply keeps host uncertainty until a later inspection confirms guest review', async t => {
  const { broker, effects } = fixture(t);
  await assert.rejects(
    effects.execute(
      { scope, requestId: 'lost-review', operation: { action: 'guest', method: 'browser.action' } },
      async () => {
        throw Error('lost');
      },
    ),
  );
  const original = broker.callGuest;
  let reconcileCalls = 0;
  broker.callGuest = async (...args) => {
    const result = await original(...args);
    if (args[1].method === 'execution.reconcile') {
      reconcileCalls++;
      throw Error('reply lost');
    }
    return result;
  };
  const input = {
    scope,
    targetRequestId: 'lost-review',
    expectedDigest: effects.records['lost-review'].digest,
    note: 'Unknown effects; explicitly abandoned',
    confirm: true,
  };
  await assert.rejects(broker.review(input), /reply lost/);
  assert.equal(effects.records['lost-review'].state, 'uncertain');
  await broker.review(input);
  assert.equal(effects.records['lost-review'].state, 'reviewed-abandoned');
  assert.equal(reconcileCalls, 1);
});
test('an inactive uncertain action never blocks a fresh operation or loses its audit', async t => {
  const { broker, effects, worker } = fixture(t);
  await assert.rejects(
    effects.execute(
      { scope, requestId: 'old-uncertain', operation: { action: 'guest', method: 'desktop.type' } },
      async () => {
        throw Error('lost');
      },
    ),
  );
  worker.ledger['old-uncertain'] = { state: 'uncertain', botId: 'bot', method: 'desktop.type' };
  const before = JSON.stringify(effects.records['old-uncertain']);
  await broker.guest({
    scope,
    requestId: 'new-file-write',
    method: 'files.write',
    args: { path: 'new-qa.txt', text: 'fresh', expectedHash: null },
  });
  assert.equal(JSON.stringify(effects.records['old-uncertain']), before);
  assert.equal(worker.ledger['old-uncertain'].state, 'uncertain');
  await assert.rejects(
    broker.guest({
      scope,
      requestId: 'old-uncertain',
      method: 'desktop.type',
      args: { text: 'never replay' },
    }),
    /identity reused|never replayed/,
  );
});
test('remote active work after lost transport rejects promptly without queuing or changing history', async t => {
  const { broker, effects, worker } = fixture(t);
  await assert.rejects(
    effects.execute(
      { scope, requestId: 'old-active', operation: { action: 'guest', method: 'shell.run' } },
      async () => {
        throw Error('lost');
      },
    ),
  );
  worker.ledger['old-active'] = { state: 'inflight', botId: 'bot' };
  await assert.rejects(
    broker.guest({
      scope,
      requestId: 'new-conflict',
      method: 'files.write',
      args: { path: 'blocked.txt', text: 'no' },
    }),
    /old-active.*still running/,
  );
  assert.equal(effects.records['new-conflict'], undefined);
  assert.equal(effects.records['old-active'].state, 'uncertain');
});
