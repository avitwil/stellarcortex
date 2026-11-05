import test from 'node:test';
import assert from 'node:assert/strict';
import { qmpInputCommand, parseQmpReply } from '../src/desktop-qmp.mjs';
import { LibvirtDesktopBroker } from '../src/desktop-libvirt-broker.mjs';
const scope = { accountId: 'owner', botId: 'bot', vmId: 'vm', generation: 'one' },
  uuid = '11111111-1111-1111-1111-111111111111';
test('QMP absolute coordinates cover the complete framebuffer; chord releases reverse order', () => {
  const x = qmpInputCommand({ action: 'click', x: 1599, y: 999 }, { width: 1600, height: 1000 });
  assert.equal(x.arguments.events[0].data.value, 32767);
  assert.equal(x.arguments.events[1].data.value, 32767);
  const keys = qmpInputCommand({ action: 'key', key: 'Control+Alt+Delete' }).arguments.events;
  assert.deepEqual(
    keys.map(k => [k.data.key.data, k.data.down]),
    [
      ['ctrl', true],
      ['alt', true],
      ['delete', true],
      ['delete', false],
      ['alt', false],
      ['ctrl', false],
    ],
  );
  assert.throws(() =>
    qmpInputCommand({ action: 'click', x: 1600, y: 1 }, { width: 1600, height: 1000 }),
  );
  assert.throws(() => qmpInputCommand({ action: 'key', key: '$(id)' }));
  assert.throws(() => qmpInputCommand({ action: 'type', text: 'secret' }));
});
test('broker uses a checked registered UUID and a bounded command, never caller shell text', async () => {
  const calls = [],
    broker = new LibvirtDesktopBroker({
      registry: { get: () => ({ ...scope, domain: 'scx-desktop-vm', uuid }) },
      approved: true,
      effects: { records: {}, execute: async (_entry, fn) => fn() },
      run: async args => {
        calls.push(args);
        return { stdout: args[0] === 'domuuid' ? uuid : '{"return":{}}' };
      },
    });
  await broker.input({ scope, requestId: 'request-one', action: { action: 'key', key: 'Tab' } });
  assert.equal(calls[1][0], 'qemu-monitor-command');
  assert.equal(calls[1][1], uuid);
  assert.equal(JSON.parse(calls[1][2]).execute, 'input-send-event');
  await assert.rejects(broker.status({ ...scope, generation: 'old' }), /stale/);
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[1][2]).arguments.events[0].data.down, true);
  assert.equal(JSON.parse(calls[2][2]).arguments.events[0].data.down, false);
});
test('approval and durable audit are required before effects; malformed QMP reply stays unknown', async () => {
  let calls = 0;
  const broker = new LibvirtDesktopBroker({
    registry: { get: () => ({ ...scope, domain: 'scx-desktop-vm', uuid }) },
    run: async () => {
      calls++;
    },
  });
  await assert.rejects(
    broker.change({ scope, action: 'start', requestId: 'request-one' }),
    /approval/,
  );
  assert.equal(calls, 0);
  assert.throws(() => parseQmpReply('{}'), /no result/);
  assert.throws(
    () => parseQmpReply('{"error":{"class":"GenericError"}}'),
    e => e.settled === true,
  );
});
test('a rejected release after a successful press remains an uncertain partial input', async () => {
  let count = 0;
  const broker = new LibvirtDesktopBroker({
    registry: { get: () => ({ ...scope, domain: 'scx-desktop-vm', uuid }) },
    approved: true,
    effects: { records: {}, execute: async (_entry, fn) => fn() },
    run: async args => ({
      stdout:
        args[0] === 'domuuid'
          ? uuid
          : ++count === 1
            ? ' {"return":{}}'
            : '{"error":{"class":"GenericError"}}',
    }),
  });
  await assert.rejects(
    broker.input({ scope, requestId: 'partial-input', action: { action: 'key', key: 'Tab' } }),
    error => error.settled === false,
  );
  assert.equal(count, 2);
});
