import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ComputerControlSession } from '../public/computer-control.js';
import { ComputerInputQueue } from '../public/computer-input.js';
import { compact } from './helpers/source-text.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test('closing during takeover returns a late grant to the original bot without acquiring a new context', async () => {
  const grant = deferred(),
    started = deferred(),
    calls = [];
  const control = new ComputerControlSession({
    idle: async () => {},
    setTakeover: async (owner, enabled) => {
      calls.push([owner.botId, owner.mode, enabled]);
      if (enabled) {
        started.resolve();
        await grant.promise;
      }
    },
  });
  const acquire = control.acquire({ botId: 'old-bot', mode: 'desktop' }, () => true);
  await started.promise;
  const close = control.release();
  assert.equal(await control.acquire({ botId: 'new-bot', mode: 'browser' }, () => true), false);
  grant.resolve();
  assert.equal(await acquire, false);
  await close;
  assert.deepEqual(calls, [
    ['old-bot', 'desktop', true],
    ['old-bot', 'desktop', false],
  ]);
  assert.equal(control.owner, null);
  assert.equal(control.transition, null);
});

test('changing context during takeover releases the requested bot rather than the newly visible bot', async () => {
  const grant = deferred(),
    started = deferred(),
    calls = [];
  let current = true;
  const control = new ComputerControlSession({
    idle: async () => {},
    setTakeover: async (owner, enabled) => {
      calls.push([owner.botId, enabled]);
      if (enabled) {
        started.resolve();
        await grant.promise;
      }
    },
  });
  const acquire = control.acquire({ botId: 'original' }, () => current);
  await started.promise;
  current = false;
  grant.resolve();
  assert.equal(await acquire, false);
  assert.deepEqual(calls, [
    ['original', true],
    ['original', false],
  ]);
  assert.equal(control.accepting, false);
});

test('handback freezes new input before draining accepted keys and releases only after they finish', async () => {
  const queue = new ComputerInputQueue(),
    key = deferred(),
    started = deferred(),
    calls = [];
  const control = new ComputerControlSession({
    idle: () => queue.idle(),
    setTakeover: async (owner, enabled) => {
      calls.push(enabled ? 'take' : 'release');
    },
  });
  await control.acquire({ botId: 'one' }, () => true);
  const admit = fn => (control.accepting ? queue.enqueue(fn) : Promise.resolve(false));
  const accepted = admit(async () => {
    calls.push('key-start');
    started.resolve();
    await key.promise;
    calls.push('key-finish');
  });
  await started.promise;
  const handback = control.release();
  assert.equal(control.accepting, false);
  assert.equal(await admit(() => calls.push('late-key')), false);
  key.resolve();
  await accepted;
  await handback;
  assert.deepEqual(calls, ['take', 'key-start', 'key-finish', 'release']);
});

test('failed remote handback clears local ownership and permits a later explicit retry', async () => {
  let fail = true;
  const control = new ComputerControlSession({
    idle: async () => {},
    setTakeover: async (owner, enabled) => {
      if (!enabled && fail) throw new Error('offline');
    },
  });
  await control.acquire({ botId: 'one' }, () => true);
  await assert.rejects(control.release(), /offline/);
  assert.equal(control.owner, null);
  assert.equal(control.transition, null);
  assert.equal(control.accepting, false);
  fail = false;
  assert.equal(await control.acquire({ botId: 'one' }, () => true), true);
  await control.release();
});

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function appFunction(start, end, globals) {
  const source = app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  return context;
}

test('viewer close always restores local controls and inert layout when remote release fails', async () => {
  const calls = [];
  const context = appFunction(
    'async function closeComputerViewer()',
    'function resetComputerInput()',
    {
      releaseComputerControl: async () => {
        throw new Error('offline');
      },
      resetComputerInput: () => calls.push('reset'),
      setManualControls: value => calls.push(['manual', value]),
      setComputerExpanded: value => calls.push(['expanded-and-inert', value]),
    },
  );
  await assert.rejects(context.closeComputerViewer(), /offline/);
  assert.deepEqual(calls, ['reset', ['manual', false], ['expanded-and-inert', false]]);
});

test('late screenshot from a prior context cannot overwrite the visible bot frame or send input', async () => {
  const screenshot = deferred(),
    started = deferred(),
    owner = { botId: 'original', mode: 'desktop' },
    newFrame = { frameId: 'new-bot-frame' },
    calls = [];
  let current = true;
  const context = appFunction(
    'async function operateComputer(args)',
    'function bindComputerImage(',
    {
      computerManual: true,
      computerControl: { owner, accepting: true },
      computerInputs: new ComputerInputQueue(),
      computerContextCurrent: () => current,
      screenBusy: false,
      computerOperation: false,
      computerShot: null,
      api: async (url, args) => {
        calls.push(url);
        if (!args) {
          started.resolve();
          return screenshot.promise;
        }
      },
      updateScreen: async () => {},
      tr: (_he, en) => en,
      setTimeout,
    },
  );
  const operation = context.operateComputer({ action: 'click', x: 4, y: 7 });
  await started.promise;
  current = false;
  context.computerShot = newFrame;
  screenshot.resolve({ frameId: 'old-bot-frame' });
  await operation;
  assert.equal(context.computerShot, newFrame);
  assert.equal(context.computerOperation, false);
  assert.deepEqual(calls, ['/api/desktop/original']);
});
test('both Stop buttons stop the whole task tree', () => {
  const code = compact(app);
  assert.match(
    code,
    /#stop-jobs'\)\.onclick=act\(async\(\)=>\{await Promise\.all\(jobs\.map\(j=>api\(`\/api\/jobs\/\$\{j\.id\}\/cancel`,\{tree:true\}\)/,
  );
  assert.match(
    code,
    /#task-stop'\)\?\.addEventListener\('click',act\(async\(\)=>\{await api\(`\/api\/jobs\/\$\{job\.id\}\/cancel`,\{tree:true\}\)/,
  );
  assert.doesNotMatch(code, /\/cancel`,\{\}\)/);
  for (const label of [
    "tr('עצירת המשימה וכל מה שהיא הפעילה','Stop this task and everything it started')",
    "tr('עצירת המשימות וכל מה שהן הפעילו','Stop these tasks and everything they started')",
  ])
    assert.ok(code.includes(label));
});
test('Claude sign-in is shown in the app: full command, its copy button and the steps, with no relative command', () => {
  assert.ok(app.includes('id="claude-login-flow"'));
  assert.ok(app.includes("mountClaudeLogin($('#claude-login-flow')"));
  assert.doesNotMatch(app, /node scripts\/claude-auth\.mjs/);
  const details = app.slice(
    app.indexOf('claude-login-steps'),
    app.indexOf('</details>', app.indexOf('claude-login-steps')),
  );
  for (const text of [
    'id="claude-login-command"',
    'id="claude-copy-login"',
    'Open a terminal on the computer or server where StellarCortex is installed.',
    'פתח טרמינל במחשב או בשרת שבו StellarCortex מותקן.',
    'Come back here and choose Check connection.',
    'חזור לכאן ולחץ על בדיקת חיבור.',
  ])
    assert.ok(details.includes(text), text);
});
