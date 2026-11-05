import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToolDetails, parseToolDetail } from '../public/tool-details.js';
test('historical Bash JSON becomes a command without transport envelope', () => {
  const record = {
    id: 'transport-123',
    type: 'commandExecution',
    tool: 'Bash',
    command: 'printf "שלום\\n"\npwd',
    status: 'completed',
  };
  const json = JSON.stringify(record),
    html = renderToolDetails(json);
  assert.match(html, /Command/);
  assert.match(html, /printf &quot;שלום/);
  assert.doesNotMatch(html, /transport-123|commandExecution|&quot;command&quot;:/);
  assert.equal(JSON.stringify(record), json);
});
test('approval preserves full command, ordered arguments and all security context', () => {
  const command = 'x'.repeat(20000) + 'END';
  const html = renderToolDetails(
    {
      command,
      args: ['', 'a b', '--flag'],
      cwd: '/tmp',
      privileged: true,
      permissions: { network: ['example.com'] },
      futurePolicy: { allow: false },
    },
    { approval: true },
  );
  assert.ok(html.includes(command));
  assert.match(html, /<li><pre dir="auto"><\/pre><\/li>/);
  assert.match(html, /example.com/);
  assert.match(html, /false/);
  assert.match(html, /Administrator privileges/);
});
test('unknown results, output and malicious HTML are retained safely', () => {
  const html = renderToolDetails({
    result: { content: [{ text: '<script>alert(1)</script>' }] },
    stderr: 'failure',
    exitCode: 1,
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /failure/);
  assert.match(html, /Exit code/);
});
test('malformed legacy detail is preserved with complete command fallback', () => {
  const html = renderToolDetails('{"command":"truncated', { fallbackCommand: 'complete command' });
  assert.match(html, /complete command/);
  assert.match(html, /truncated/);
  assert.equal(parseToolDetail('plain output'), 'plain output');
});
test('objects, arrays, null, booleans and Hebrew labels render without throwing', () => {
  for (const value of [null, false, [], ['a'], { input: { command: 'pwd' } }])
    assert.equal(typeof renderToolDetails(value), 'string');
  assert.match(renderToolDetails({ command: 'pwd' }, { tr: he => he }), /פקודה/);
});
test('identical nested command is shown once without mutating approval input', () => {
  const value = {
    command: 'unique-command',
    input: { command: 'unique-command', description: 'purpose' },
  };
  const html = renderToolDetails(value, { approval: true });
  assert.equal(html.split('unique-command').length - 1, 1);
  assert.match(html, /purpose/);
  assert.equal(value.input.command, 'unique-command');
});
test('unfamiliar fields with prototype names remain visible without crashing', () => {
  const html = renderToolDetails('{"constructor":"custom","__proto__":{"scope":"restricted"}}', {
    approval: true,
  });
  assert.match(html, /custom/);
  assert.match(html, /restricted/);
});
