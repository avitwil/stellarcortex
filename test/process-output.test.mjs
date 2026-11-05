import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Claude } from '../src/claude.mjs';
import { Codex } from '../src/codex.mjs';
import { logProcessOutput } from '../src/process-output.mjs';
import { LibvirtDesktopBroker } from '../src/desktop-libvirt-broker.mjs';
import { run as runStep } from '../scripts/kit-update.mjs';
import { chatErrorText, withoutProgramOutput } from '../public/chat-errors.js';
import { updateCause } from '../public/update-causes.js';
import { compact } from './helpers/source-text.mjs';

const he = a => a,
  en = (_, b) => b,
  read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const stack = `Codex stopped (1). file:///tmp/app/node_modules/@openai/codex/bin/codex.js:107
  throw new Error(
        ^
Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest
    at findCodexExecutable (file:///tmp/app/node_modules/@openai/codex/bin/codex.js:107:9)`;
const raw = /file:|throw new|node_modules|\n\s+at /;

function captureLog(t) {
  const lines = [],
    original = console.error;
  console.error = (...values) => lines.push(values.join(' '));
  t.after(() => {
    console.error = original;
  });
  return lines;
}
// A real child that prints to stderr and stops, as the Codex launcher does.
async function codexStopsWith(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-codex-')),
    file = path.join(dir, 'stop.cjs'),
    options = process.env.NODE_OPTIONS;
  fs.writeFileSync(file, script);
  process.env.NODE_OPTIONS = `--require ${file}`;
  t.after(() => {
    if (options === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = options;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const codex = new Codex({ executable: process.execPath }),
    offline = new Promise(resolve => codex.once('offline', resolve));
  const started = codex.start().catch(error => error);
  const reason = await offline;
  await started;
  return reason;
}

test('a missing Codex program says to run the installer, and the stack stays in the log', async t => {
  const lines = captureLog(t);
  const reason = await codexStopsWith(
    t,
    `console.error(${JSON.stringify(stack)});process.exit(1);`,
  );
  assert.equal(reason, 'Codex is not fully installed on this server. Run the installer again.');
  assert.match(lines.join('\n'), /Missing optional dependency/);
});
test('any other Codex stop is short too, and the log keeps what it printed', async t => {
  const lines = captureLog(t);
  const reason = await codexStopsWith(t, `console.error('panic in thread');process.exit(3);`);
  assert.equal(reason, 'Codex stopped (3). Details are in the server log.');
  assert.match(lines.join('\n'), /panic in thread/);
});
test('Codex that cannot start says to run the installer', async t => {
  const lines = captureLog(t);
  const codex = new Codex({ executable: path.join(os.tmpdir(), 'scx-no-such-program') }),
    offline = new Promise(resolve => codex.once('offline', resolve));
  codex.start().catch(() => {});
  assert.match(await offline, /not fully installed/);
  assert.match(lines.join('\n'), /ENOENT/);
});
function fakeClaude(stderr, code = 1, signal = null) {
  return () => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {},
    });
    setImmediate(() => {
      child.stderr.emit('data', stderr);
      child.emit('close', code, signal);
    });
    return child;
  };
}
test('a failed Claude command keeps its output out of the error', async t => {
  const lines = captureLog(t);
  const claude = new Claude({ spawnProcess: fakeClaude(stack) });
  const error = await claude.capture(['mcp', 'list']).catch(e => e);
  assert.equal(error.message, 'Claude Code mcp failed (1). Details are in the server log.');
  assert.match(lines.join('\n'), /Missing optional dependency/);
});
test('a program killed by a signal still leaves a line in the log it points to', async t => {
  const lines = captureLog(t);
  const claude = new Claude({ spawnProcess: fakeClaude('', null, 'SIGKILL') });
  const error = await claude.capture(['mcp', 'list']).catch(e => e);
  assert.equal(error.message, 'Claude Code mcp failed (SIGKILL). Details are in the server log.');
  assert.match(lines.join('\n'), /signal SIGKILL/);
});
test('a failed Claude sign-in command logs nothing, since it can print a login code', async t => {
  const lines = captureLog(t);
  const claude = new Claude({ spawnProcess: fakeClaude('Your code: ABCD-EFGH') });
  const error = await claude.capture(['auth', 'status']).catch(e => e);
  assert.doesNotMatch(error.message, /ABCD/);
  assert.deepEqual(lines, []);
});
test('no error is built from what a program printed', () => {
  assert.doesNotMatch(read('src/claude.mjs'), /\(\$\{code\}\)\. \$\{(turn\.)?stderr\}/);
  assert.doesNotMatch(read('src/codex.mjs'), /new Error\(`[^`]*this\.stderr/);
  assert.doesNotMatch(read('src/desktop.mjs'), /new Error\(`\$\{command\}: |Error\(errors \|\|/);
  assert.doesNotMatch(read('src/private-browser.mjs'), /attachment: ' \+ diagnostic/);
});
test('the log gets a short tail with tokens, addresses and keys hidden', t => {
  const lines = captureLog(t),
    accessKey = 'f'.repeat(64);
  logProcessOutput(
    'Codex',
    'x'.repeat(2000) +
      ` token=abc123 Authorization: Bearer sekret https://auth.example.test/?code=1 ${accessKey} done`,
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length < 850);
  assert.match(lines[0], /done$/);
  assert.doesNotMatch(lines[0], /abc123|sekret|auth\.example|ffffffff/);
  logProcessOutput('Codex', '');
  assert.equal(lines.length, 1);
});
test('a saved stack shows as a short message in both languages, with nothing under details', () => {
  for (const text of [stack, `Codex is unavailable: ${stack}`]) {
    const hebrew = chatErrorText(text, he),
      english = chatErrorText(text, en);
    assert.match(hebrew.text, /הריצו שוב את ההתקנה/);
    assert.match(english.text, /Run the installer again/);
    assert.equal(english.detail, null);
    assert.equal(english.action, null);
  }
  const other = chatErrorText(
    'Claude Code exited (1). at Object.<anonymous> (/srv/app/x.js:1:1)',
    en,
  );
  assert.match(other.text, /program on the server stopped/);
  assert.equal(other.detail, null);
});
test('the new short errors are translated, and ordinary errors pass through', () => {
  assert.match(
    withoutProgramOutput(
      'Codex is not fully installed on this server. Run the installer again.',
      he,
    ),
    /Codex לא הותקן/,
  );
  assert.match(
    withoutProgramOutput('Codex stopped (3). Details are in the server log.', he),
    /נעצרה/,
  );
  assert.equal(withoutProgramOutput('Choose a model first.', en), 'Choose a model first.');
  assert.equal(withoutProgramOutput(null, en), null);
  assert.doesNotMatch(updateCause(stack, en), raw);
});
test('no screen prints a saved error field without the filter', () => {
  // These hold what api() rejected with, and api() already filtered that.
  const fromApi =
    /^(session\.error|session\.newConnectionError|session\.connectionsError|this\.error)$/;
  const unfiltered = [];
  const folder = new URL('../public/', import.meta.url);
  for (const name of fs.readdirSync(folder).filter(file => file.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(name, folder), 'utf8');
    for (const [, shown] of text.matchAll(
      /\b(?:esc|escape)\(\s*((?:[\w?.]+\s*\|\|\s*)*[\w?.]+\.(?:error|\w+Error)\b)/g,
    ))
      if (!fromApi.test(shown) && !shown.endsWith('plainError'))
        unfiltered.push(name + ': ' + shown);
  }
  assert.deepEqual(unfiltered, []);
  assert.doesNotMatch(read('public/computer-settings.js'), /build\.message/);
});
test('files that run without the public folder import nothing from it', () => {
  assert.doesNotMatch(read('src/process-output.mjs'), /^import /m);
  for (const name of ['src/desktop-libvirt-broker.mjs', 'scripts/kit-update.mjs'])
    assert.doesNotMatch(read(name), /ui-json|public\//, name);
});
test('a failed virsh call gives a short error and keeps the command line out', async t => {
  const lines = captureLog(t),
    broker = new LibvirtDesktopBroker({ registry: {} }),
    error = await broker.run(['domstate', 'no-such-computer']).catch(e => e);
  assert.equal(error.message, 'virsh failed. Details are in the server log.');
  assert.ok(lines.join('').length > 0);
});
test('a failed step on the host keeps its raw line out of the status, unless the owner can act on it', async t => {
  const lines = captureLog(t),
    failing = line => [
      '-e',
      `console.log('working');console.error(${JSON.stringify(line)});process.exit(1)`,
    ];
  const raw = await runStep(
    process.execPath,
    failing('ValueError: Private or linked runtime input: /var/lib/x'),
  ).catch(e => e);
  assert.equal(raw.message, 'The update step on the host failed. Details are in the server log.');
  assert.match(lines.join('\n'), /ValueError/);
  const busy = await runStep(
    process.execPath,
    failing('A computer is being prepared. Run this again when it finishes.'),
  ).catch(e => e);
  assert.match(updateCause(busy.message, en), /being prepared/);
  assert.match(updateCause(raw.message, he), /תוכנה בשרת נעצרה/);
});
test('Start counts as busy for an update, and a starting computer is polled on the bot tab', () => {
  assert.match(read('deployment/ubuntu-desktop/host-setup.py'), /busy=.*computer-start\.service/);
  assert.match(read('public/remote-desktop-provider.js'), /'building',\s*'starting',/);
});
test('every real install checks that the Codex program runs', () => {
  const check = 'node_modules/@openai/codex/bin/codex.js';
  assert.ok(read('Dockerfile').includes(`node ${check} --version`));
  assert.ok(read('install.sh').includes(`node ${check} --version`));
  assert.match(read('scripts/doctor.mjs'), /Codex is not fully installed/);
  // Only the computer leaves it out: its Codex comes from the host, in the signed bundle.
  assert.doesNotMatch(
    [read('install.sh'), read('Dockerfile'), read('src/managed-updates.mjs')].join('\n'),
    /omit=optional/,
  );
});
