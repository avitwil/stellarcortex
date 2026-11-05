import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopEffectJournal } from '../src/desktop-effect-journal.mjs';
const scope = { accountId: 'owner', botId: 'a', vmId: 'vm-a', generation: 'one' };
test('durable duplicates are never repeated; inactive uncertain outcomes preserve history without blocking fresh work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-effect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json'),
    j = new DesktopEffectJournal(file);
  let calls = 0;
  const request = { scope, requestId: 'request-one', operation: { action: 'input' } };
  await j.execute(request, async () => {
    calls++;
    return { ok: true };
  });
  await new DesktopEffectJournal(file).execute(request, async () => {
    calls++;
  });
  assert.equal(calls, 1);
  await assert.rejects(
    j.execute({ ...request, requestId: 'lost-reply' }, async () => {
      throw Error('lost');
    }),
  );
  await j.execute({ ...request, requestId: 'new-input' }, async () => ({ ok: true }));
  await j.execute(
    { ...request, scope: { ...scope, botId: 'b', vmId: 'vm-b' }, requestId: 'other-vm' },
    async () => ({ ok: true }),
  );
  j.review('lost-reply', { scope, note: 'Owner reviewed and abandoned without replay.' });
  await j.execute({ ...request, requestId: 'new-input' }, async () => ({ ok: true }));
  assert.equal(j.records['lost-reply'].state, 'reviewed-abandoned');
});
test('recovered in-flight operation becomes uncertain; a QMP settled error is retained without replay', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-effect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ crash: { scope, state: 'inflight', digest: 'fixture' } }),
  );
  const j = new DesktopEffectJournal(file);
  assert.equal(j.records.crash.state, 'uncertain');
  const request = {
    scope: { ...scope, vmId: 'vm-b' },
    requestId: 'qmp-error',
    operation: { action: 'input' },
  };
  await assert.rejects(
    j.execute(request, async () => {
      throw Object.assign(Error('rejected'), { settled: true });
    }),
  );
  assert.equal(j.records['qmp-error'].state, 'settled-error');
  await assert.rejects(
    j.execute(request, async () => {}),
    /never replayed/,
  );
});
test('release-only recovery and fresh input preserve uncertainty', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-release-effect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = new DesktopEffectJournal(path.join(dir, 'journal.json'));
  await assert.rejects(
    j.execute({ scope, requestId: 'uncertain-one', operation: { action: 'input' } }, async () => {
      throw Error('lost');
    }),
  );
  await j.execute(
    {
      scope,
      requestId: 'release-one',
      operation: { action: 'release-inputs' },
      recoveryOnly: true,
    },
    async () => ({ released: true }),
  );
  assert.equal(j.records['uncertain-one'].state, 'uncertain');
  await assert.rejects(
    j.execute(
      { scope, requestId: 'fake-recovery', operation: { action: 'input' }, recoveryOnly: true },
      async () => {},
    ),
    /Only input releases/,
  );
  await j.execute(
    { scope, requestId: 'fresh-input', operation: { action: 'input' } },
    async () => ({ ok: true }),
  );
  assert.equal(j.records['uncertain-one'].state, 'uncertain');
});
test('independent file work proceeds during graphical input; conflicting input fails promptly', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-resource-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = new DesktopEffectJournal(path.join(dir, 'audit.json'));
  let finish;
  const active = j.execute(
    { scope, requestId: 'active-typing', operation: { action: 'guest', method: 'desktop.type' } },
    () => new Promise(r => (finish = r)),
  );
  await Promise.resolve();
  await j.execute(
    { scope, requestId: 'independent-file', operation: { action: 'guest', method: 'files.write' } },
    async () => ({ ok: true }),
  );
  await assert.rejects(
    j.execute(
      { scope, requestId: 'conflicting-input', operation: { action: 'input' } },
      async () => {},
    ),
    /running operation/,
  );
  finish({ ok: true });
  await active;
});
