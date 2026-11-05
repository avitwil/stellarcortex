import test from 'node:test';
import assert from 'node:assert/strict';
import { botComputerAccess, registeredBotSession } from '../src/environment-computer.mjs';
const policy = {
    accountId: 'owner',
    environmentId: 'env',
    computerId: 'computer',
    defaultAccess: true,
    overrides: {},
  },
  identity = { accountId: 'owner', environmentId: 'env' },
  bot = { id: 'alpha', environmentId: 'env' };
const record = (botId, uid, guestPort) => ({
  ...identity,
  computerId: 'computer',
  vmId: '01',
  botId,
  sessionId: 'session-' + botId,
  uid,
  cid: 151,
  displayNumber: guestPort - 7000,
});
test('environment members inherit access while denied, deleted and foreign bots cannot', () => {
  assert.equal(botComputerAccess(policy, bot, identity), true);
  assert.equal(botComputerAccess({ ...policy, overrides: { alpha: false } }, bot, identity), false);
  assert.equal(botComputerAccess({ ...policy, defaultAccess: false }, bot, identity), false);
  assert.equal(
    botComputerAccess(
      { ...policy, defaultAccess: false, overrides: { alpha: true } },
      bot,
      identity,
    ),
    true,
  );
  for (const [b, i] of [
    [{ ...bot, deletedAt: 'today' }, identity],
    [{ ...bot, environmentId: 'other' }, identity],
    [bot, { ...identity, accountId: 'other' }],
  ])
    assert.equal(botComputerAccess(policy, b, i), false);
});
test('two bots use one computer but cannot inherit desktop/user/worker authority', () => {
  const records = [record('alpha', 1101, 7101), record('beta', 1102, 7102)];
  assert.equal(registeredBotSession(policy, bot, identity, records).uid, 1101);
  assert.equal(
    registeredBotSession(policy, { id: 'beta', environmentId: 'env' }, identity, records).vmId,
    '01',
  );
  for (const key of ['sessionId', 'uid', 'displayNumber'])
    assert.throws(
      () =>
        registeredBotSession(policy, bot, identity, [
          records[0],
          { ...records[1], [key]: records[0][key] },
        ]),
      /cannot share/,
    );
  assert.throws(
    () => registeredBotSession({ ...policy, overrides: { alpha: false } }, bot, identity, records),
    /disabled/,
  );
  assert.throws(() => registeredBotSession(policy, bot, identity, []), /not been provisioned/);
});
import { DesktopProviderRuntime } from '../src/desktop-provider-runtime.mjs';
test('runtime checks environment access on every action and rejects duplicate session authority', async () => {
  const records = [
    { ...record('alpha', 1101, 7101), generation: 'generation', state: 'running' },
    { ...record('beta', 1102, 7102), generation: 'generation' },
  ];
  let invoked = 0;
  const runtime = new DesktopProviderRuntime({
    records,
    environmentPolicy: policy,
    enabled: true,
    broker: {
      guest: async () => {
        invoked++;
        return {};
      },
    },
  });
  runtime.store = { data: { bots: [bot, { id: 'beta', environmentId: 'env' }] } };
  await runtime.agent(records[0], 'files.read', {});
  assert.equal(invoked, 1);
  runtime.store.data.bots[0] = { ...bot, computer: 'none' };
  await assert.rejects(runtime.agent(records[0], 'files.read', {}), /identity changed/);
  assert.equal(invoked, 1);
  assert.equal((await runtime.onboarding('owner', 'alpha')).state, 'access-disabled');
});
import { desktopScope, scopeKey } from '../src/desktop-provider-session.mjs';
import { DesktopSessionCoordinator } from '../src/desktop-provider-session.mjs';
test('display and input authority includes session identity; two bot sessions can act independently', async () => {
  const a = { ...record('alpha', 1101, 7101), generation: 'one' },
    b = { ...record('beta', 1102, 7102), generation: 'one' };
  assert.notEqual(scopeKey(a), scopeKey(b));
  assert.notEqual(scopeKey(a), scopeKey({ ...a, sessionId: 'replacement' }));
  assert.throws(() => desktopScope({ ...a, computerId: undefined }), /Complete trusted/);
  const coordinator = new DesktopSessionCoordinator({ releaseInputs: async () => {} });
  const lease = await coordinator.claim(a, 'human');
  let ran = false;
  await coordinator.runAgent(b, async () => {
    ran = true;
  });
  assert.equal(ran, true);
  await assert.rejects(
    coordinator.runAgent(a, async () => {}),
    /Human control/,
  );
  assert.equal(coordinator.canWrite({ ...a, sessionId: 'replacement' }, lease), false);
  await coordinator.release(a, lease);
});
test('owner per-bot access choice overrides the default but cannot override root denial', () => {
  const policy = {
      accountId: 'owner',
      environmentId: 'env',
      computerId: 'computer',
      defaultAccess: true,
      overrides: {},
    },
    bot = { id: 'b', environmentId: 'env' },
    identity = { accountId: 'owner', environmentId: 'env' };
  assert.equal(botComputerAccess(policy, bot, identity), true);
  assert.equal(botComputerAccess(policy, { ...bot, computer: 'none' }, identity), false);
  assert.equal(
    botComputerAccess({ ...policy, overrides: { b: false } }, { ...bot, computer: 'vm' }, identity),
    false,
  );
});
