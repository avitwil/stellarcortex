import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { GuestRPC } from './helpers/guest-rpc.mjs';
import { GuestDesktop } from '../src/guest-desktop.mjs';
import { GuestWorker, guestSocketServer } from '../src/guest-worker.mjs';
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-guest-contract-')),
    calls = [],
    takeovers = new Set(),
    desktop = {
      status: async botId => ({
        available: true,
        enabled: true,
        perBotScreens: true,
        botId,
        takeover: takeovers.has(botId),
      }),
      snapshot: async botId => ({
        available: true,
        botId,
        width: 1600,
        height: 1000,
        frameId: 'test-frame',
        image: 'synthetic-fixture',
      }),
      acquire: (botId, runId) => {
        calls.push(['acquire', botId, runId]);
        return { ok: true };
      },
      release: runId => {
        calls.push(['release', runId]);
        return { ok: true };
      },
      setTakeover: (botId, value) => (value ? takeovers.add(botId) : takeovers.delete(botId)),
      action: async (botId, input, manual) => {
        if (manual && !takeovers.has(botId)) throw Error('Take control first');
        calls.push(['input', botId, input]);
        return { ok: true };
      },
      removeBot: async () => ({ ok: true }),
    },
    worker = new GuestWorker({
      vmId: 'user-vm',
      generation: 'epoch1',
      allowedBots: ['a', 'b'],
      desktop,
      browser: {
        takeover: new Set(),
        snapshot: async () => ({ image: 'synthetic-browser' }),
        action: async () => ({ ok: true }),
      },
      workspace: dir,
      ledgerFile: path.join(dir, 'ledger.json'),
      runShell: async args => {
        calls.push(['shell', args]);
        return { exitCode: 0, stdout: 'fake executor, no native process' };
      },
    }),
    socketPath = path.join(dir, 'worker.sock'),
    server = await guestSocketServer(worker, socketPath),
    rpc = new GuestRPC({ socketPath, vmId: 'user-vm', generation: 'epoch1', timeoutMs: 200 });
  t.after(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, calls, desktop, worker, rpc, socketPath };
}
test('guest contract exposes real request/reply desktop ownership and serialized takeover without host fallback', async t => {
  const f = await setup(t),
    d = new GuestDesktop(f.rpc, { enabled: true });
  await d.acquire('a', 'run-a');
  await d.setTakeover('a', true);
  assert.equal((await d.status('a')).takeover, true);
  assert.equal((await d.status('b')).takeover, false);
  const frame = await d.snapshot('a');
  assert.equal(frame.width, 1600);
  await d.action('a', { action: 'key', key: 'Tab' }, true);
  await d.setTakeover('a', false);
  d.release('run-a');
  await d.acquire('a', 'run-b');
  assert.deepEqual(
    f.calls.filter(c => c[0] !== 'input').map(c => c[0]),
    ['acquire', 'release', 'acquire'],
  );
  assert.equal(f.calls.filter(c => c[0] === 'input').length, 1);
  await d.close();
});
test('wrong VM generation and unknown bot fail closed without guest effects', async t => {
  const f = await setup(t),
    bad = new GuestRPC({ socketPath: f.socketPath, vmId: 'user-vm', generation: 'old' });
  await assert.rejects(bad.call('desktop.takeover', 'a', { enabled: true }), /Stale/);
  await assert.rejects(f.rpc.call('desktop.snapshot', 'unknown'), /Unknown/);
  assert.equal(f.calls.length, 0);
});
test('duplicate mutating RPC identities never repeat input, and conflicting payload cannot reuse identity', async t => {
  const f = await setup(t);
  await f.rpc.call('desktop.takeover', 'a', { enabled: true }, 'grant');
  const args = { input: { action: 'key', key: 'Tab' }, manual: true };
  await f.rpc.call('desktop.action', 'a', args, 'one-key');
  await f.rpc.call('desktop.action', 'a', args, 'one-key');
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.rpc.call(
      'desktop.action',
      'a',
      { input: { action: 'key', key: 'Enter' }, manual: true },
      'one-key',
    ),
    /different/,
  );
  assert.equal(f.calls.length, 1);
});
test('workspace and shell route to guest handlers; symlink/traversal rejected and shell is explicitly fake', async t => {
  const f = await setup(t);
  await f.rpc.call('files.write', 'a', { path: 'note.txt', text: 'guest fixture' }, 'write');
  assert.equal((await f.rpc.call('files.read', 'a', { path: 'note.txt' })).text, 'guest fixture');
  await assert.rejects(f.rpc.call('files.read', 'a', { path: '../escape' }), /escapes/);
  fs.symlinkSync('/etc/passwd', path.join(f.dir, 'link'));
  await assert.rejects(f.rpc.call('files.read', 'a', { path: 'link' }), /symlink/);
  const run = await f.rpc.call(
    'shell.run',
    'a',
    { command: 'fake', args: ['test'], cwd: '.' },
    'shell',
  );
  assert.match(run.stdout, /fake executor/);
  assert.equal(f.calls[0][0], 'shell');
  assert.equal(f.calls[0][1].cwd, f.dir);
});
test('uncertain effect after worker restart is not submitted again', async t => {
  const f = await setup(t);
  f.worker.ledger.crashed = { digest: 'unused', state: 'inflight', botId: 'a' };
  f.worker.save();
  const restarted = new GuestWorker({
    vmId: 'user-vm',
    generation: 'epoch1',
    allowedBots: ['a'],
    desktop: f.desktop,
    workspace: f.dir,
    ledgerFile: path.join(f.dir, 'ledger.json'),
  });
  assert.equal(restarted.ledger.crashed.state, 'uncertain');
  const reply = await restarted.handle({
    protocol: 'scx-guest-v1',
    vmId: 'user-vm',
    generation: 'epoch1',
    botId: 'a',
    requestId: 'query',
    method: 'execution.status',
    args: { requestId: 'crashed' },
  });
  assert.equal(reply.result.state, 'uncertain');
  assert.equal(f.calls.length, 0);
});

test('guest native shell entrypoint refuses host execution and validates arguments before spawn', async () => {
  const { guestShell } = await import('../src/guest-shell.mjs');
  let spawned = false;
  assert.throws(
    () =>
      guestShell(
        { command: 'fake', args: [], cwd: '.' },
        {
          insideGuest: false,
          spawnImpl: () => {
            spawned = true;
          },
        },
      ),
    /outside/,
  );
  assert.throws(
    () =>
      guestShell(
        { command: 'bad\0value', args: [], cwd: '.' },
        {
          insideGuest: true,
          spawnImpl: () => {
            spawned = true;
          },
        },
      ),
    /Invalid/,
  );
  assert.equal(spawned, false);
});

test('explicit cancellation before start persists a no-execution marker and never runs a late request', async t => {
  const f = await setup(t);
  await f.rpc.call('execution.cancel', 'a', { requestId: 'late-command' }, 'cancel-late');
  await assert.rejects(
    f.rpc.call('shell.run', 'a', { command: 'fake', args: [] }, 'late-command'),
    /Cancelled/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.rpc.call('execution.status', 'a', { requestId: 'late-command' })).state,
    'cancelled-before-start',
  );
});
test('cancel during a pending synthetic guest command aborts only its owning bot request', async t => {
  const f = await setup(t);
  let started;
  const ready = new Promise(r => (started = r));
  f.worker.runShell = (_args, { signal }) =>
    new Promise(resolve => {
      started();
      signal.addEventListener('abort', () => resolve({ stopped: 'cancelled', exitCode: null }), {
        once: true,
      });
    });
  const work = f.rpc.call('shell.run', 'a', { command: 'fake', args: [] }, 'pending-command');
  await ready;
  await assert.rejects(
    f.rpc.call('execution.cancel', 'b', { requestId: 'pending-command' }),
    /reconciliation/,
  );
  f.rpc.reconcile([...f.rpc.uncertain][0], 'Test verified other bot was not cancelled');
  await f.rpc.call('execution.cancel', 'a', { requestId: 'pending-command' });
  assert.equal((await work).stopped, 'cancelled');
});
test('file write refuses an altered target after approval', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.dir, 'changing.txt'), 'original');
  const before = await f.rpc.call('files.inspect', 'a', { path: 'changing.txt' });
  fs.writeFileSync(path.join(f.dir, 'changing.txt'), 'changed');
  await assert.rejects(
    f.rpc.call(
      'files.write',
      'a',
      { path: 'changing.txt', text: 'approved overwrite', expectedHash: before.hash },
      'write-race',
    ),
    /reconciliation/,
  );
  assert.equal(fs.readFileSync(path.join(f.dir, 'changing.txt'), 'utf8'), 'changed');
});
test('reviewed guest artifact export streams verified bytes to a generated path and never follows a guest host path', async t => {
  const f = await setup(t),
    { GuestExecution } = await import('../src/guest-execution.mjs'),
    g = new GuestExecution(f.rpc, { enabled: true }),
    bytes = Buffer.alloc(300000, 65);
  fs.writeFileSync(path.join(f.dir, 'export.txt'), bytes);
  const directory = path.join(f.dir, 'host-artifacts');
  await assert.rejects(
    g.exportArtifact('a', 'export.txt', { directory, approve: async () => false }),
    /declined/,
  );
  assert(!fs.existsSync(directory));
  const result = await g.exportArtifact('a', 'export.txt', {
    directory,
    approve: async info => info.size === bytes.length,
  });
  assert.equal(fs.readFileSync(result.file).compare(bytes), 0);
  assert.equal(path.dirname(result.file), directory);
  assert.notEqual(path.basename(result.file), 'export.txt');
});

test('owner-side facade registers newly created bot IDs without a new OS user or hardcoded roster limit', async t => {
  const f = await setup(t),
    { GuestExecution } = await import('../src/guest-execution.mjs'),
    g = new GuestExecution(f.rpc, { enabled: true });
  assert(!f.worker.allowedBots.has('new-agent'));
  await g.desktop.status('new-agent');
  assert(f.worker.allowedBots.has('new-agent'));
  await g.file('new-agent', {
    action: 'write',
    path: 'new-agent.txt',
    text: 'new synthetic bot workspace',
  });
  assert.equal(
    fs.readFileSync(path.join(f.dir, 'new-agent.txt'), 'utf8'),
    'new synthetic bot workspace',
  );
  assert.equal(f.calls.length, 0);
});

test('restart uncertainty is discovered before new model work and requires review without replay', async t => {
  const f = await setup(t),
    { GuestExecution } = await import('../src/guest-execution.mjs'),
    g = new GuestExecution(f.rpc, { enabled: true, providerIsolation: { claude: true } });
  f.worker.ledger.interrupted = { botId: 'a', state: 'uncertain', digest: 'synthetic' };
  await assert.rejects(g.health('a'), /explicit review/);
  assert.equal(g.providerReady('claude'), false);
  await assert.rejects(g.reconcile('b', 'interrupted', 'Wrong owner review'), /reconciliation/);
  const failed = [...f.rpc.uncertain].find(x => x !== 'interrupted');
  if (failed) f.rpc.reconcile(failed, 'Synthetic test: denied before effects');
  await g.reconcile(
    'a',
    'interrupted',
    'Inspected guest and confirmed no further effects; abandon rather than replay',
  );
  assert.equal(f.worker.ledger.interrupted.state, 'reviewed-abandoned');
  assert.equal((await g.health('a')).available, true);
  assert.equal(g.providerReady('claude'), true);
  assert.equal(f.calls.length, 0);
});

test('stale worker socket recovery refuses live/foreign paths and clears only a dead owned socket', async t => {
  const { prepareGuestSocket } = await import('../src/guest-worker.mjs'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-stale-worker-')),
    live = path.join(dir, 'live.sock'),
    stale = path.join(dir, 'stale.sock'),
    server = net.createServer();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await new Promise(r => server.listen(live, r));
  await assert.rejects(prepareGuestSocket(live), /already active/);
  assert(fs.existsSync(live));
  fs.renameSync(live, stale);
  await new Promise(r => server.close(r));
  await prepareGuestSocket(stale);
  assert(!fs.existsSync(stale));
  fs.writeFileSync(live, 'not a socket');
  await assert.rejects(prepareGuestSocket(live), /non-socket/);
  assert.equal(fs.readFileSync(live, 'utf8'), 'not a socket');
});
test('uncertain effects still allow passive evidence inspection but block new writes', async t => {
  const f = await setup(t);
  f.rpc.uncertain.add('interrupted');
  fs.writeFileSync(path.join(f.dir, 'evidence.txt'), 'review-only');
  assert.equal((await f.rpc.call('files.read', 'a', { path: 'evidence.txt' })).text, 'review-only');
  assert.equal((await f.rpc.call('desktop.snapshot', 'a')).available, true);
  await assert.rejects(
    f.rpc.call('files.write', 'a', { path: 'new.txt', text: 'must not write' }),
    /reconcile/,
  );
  assert(!fs.existsSync(path.join(f.dir, 'new.txt')));
});

test('lost read-only health replies never create false uncertain effects', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-lost-health-')),
    socketPath = path.join(dir, 'worker.sock'),
    server = net.createServer(socket => socket.once('data', () => socket.end()));
  await new Promise(r => server.listen(socketPath, r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const rpc = new GuestRPC({ socketPath, vmId: 'fixture', generation: 'fixture', timeoutMs: 1000 });
  for (const method of ['execution.ping', 'files.read', 'desktop.snapshot']) {
    await assert.rejects(rpc.call(method, 'a'), /closed/);
    assert.equal(rpc.uncertain.size, 0);
  }
  await assert.rejects(rpc.call('files.write', 'a'), /closed/);
  assert.equal(rpc.uncertain.size, 1);
});

test('failed guest effects retain exact RPC correlation without replay', async t => {
  const f = await setup(t);
  f.desktop.action = async () => {
    throw Error('synthetic failure');
  };
  await assert.rejects(
    f.rpc.call(
      'desktop.action',
      'a',
      { input: { action: 'key', key: 'Enter' } },
      'audit-effect-id',
    ),
    e => {
      assert.equal(e.guestRequestId, 'audit-effect-id');
      assert.equal(e.guestMethod, 'desktop.action');
      assert.equal(e.guestBotId, 'a');
      assert.equal(e.guestSubmitted, true);
      return /reconciliation/.test(e.message);
    },
  );
  assert.equal(f.worker.ledger['audit-effect-id'].state, 'uncertain');
});
test('uncertainty permits passive browser reads and owner takeover but not agent effects', async t => {
  const f = await setup(t);
  f.worker.browser = {
    takeover: new Set(),
    action: async () => ({ url: 'about:blank', text: '' }),
  };
  f.rpc.uncertain.add('prior-unknown');
  assert.equal((await f.rpc.call('browser.read', 'a')).url, 'about:blank');
  await f.rpc.call('desktop.takeover', 'a', { enabled: true });
  await f.rpc.call('desktop.action', 'a', { input: { action: 'key', key: 'Tab' }, manual: true });
  await assert.rejects(
    f.rpc.call('desktop.action', 'a', { input: { action: 'key', key: 'Tab' } }),
    /reconcile/,
  );
  await f.rpc.call('desktop.takeover', 'a', { enabled: false });
  assert(f.rpc.uncertain.has('prior-unknown'));
});
test('takeover refuses an operation still in flight without creating another uncertain record', async t => {
  const f = await setup(t);
  let started, finish;
  const ready = new Promise(r => (started = r));
  f.worker.runShell = () =>
    new Promise(r => {
      finish = r;
      started();
    });
  const work = f.rpc.call('shell.run', 'a', { command: 'fake', args: [] }, 'running');
  await ready;
  await assert.rejects(
    f.rpc.call('desktop.takeover', 'a', { enabled: true }, 'takeover-busy'),
    /still running/,
  );
  assert(!f.worker.ledger['takeover-busy']);
  assert(!f.rpc.uncertain.has('takeover-busy'));
  finish({ exitCode: 0 });
  await work;
  await f.rpc.call('desktop.takeover', 'a', { enabled: true });
});
test('ownership rejection is recorded without uncertainty and never replayed', async t => {
  const f = await setup(t);
  await f.rpc.call('browser.takeover', 'a', { enabled: true });
  await assert.rejects(
    f.rpc.call('desktop.action', 'a', { input: { action: 'key', key: 'Tab' } }, 'denied-input'),
    /control changed/,
  );
  assert.equal(f.worker.ledger['denied-input'].state, 'rejected-before-effects');
  assert.equal(f.rpc.uncertain.size, 0);
  await f.rpc.call('desktop.takeover', 'a', { enabled: false });
  await assert.rejects(
    f.rpc.call('desktop.action', 'a', { input: { action: 'key', key: 'Tab' } }, 'denied-input'),
    /control changed/,
  );
  assert.equal(f.calls.length, 0);
});
test('reviewed cached teaching frame stays observable during uncertainty and requires human control', async t => {
  const f = await setup(t);
  let captures = 0;
  f.worker.captureFrame = async () => {
    captures++;
    return { image: 'synthetic-redacted-frame', redacted: true };
  };
  f.rpc.uncertain.add('old-navigation');
  await assert.rejects(f.rpc.call('demo.frame', 'a', { frameId: 'fixture' }), /Take control/);
  assert.equal(captures, 0);
  assert.equal(f.rpc.uncertain.size, 1);
  await f.rpc.call('desktop.takeover', 'a', { enabled: true });
  const result = await f.rpc.call('demo.frame', 'a', { frameId: 'fixture' });
  assert.equal(result.redacted, true);
  assert.equal(captures, 1);
  assert.equal(f.rpc.uncertain.size, 1);
});
