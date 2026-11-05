import fs from 'node:fs';
const args = process.argv.slice(2),
  mode = process.env.STELLARCORTEX_FAKE_CLAUDE_MODE || 'normal';
if (args[0] === '--version') {
  console.log('2.1.310 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(
    JSON.stringify({
      loggedIn: mode !== 'noauth',
      authMethod: mode === 'noauth' ? 'none' : mode === 'api' ? 'api_key' : 'claude.ai',
      apiProvider: 'firstParty',
      email: process.env.STELLARCORTEX_FAKE_CLAUDE_EMAIL || 'test@example.test',
      subscriptionType: 'max',
      private_secret: 'must-never-escape',
    }),
  );
  process.exit(mode === 'noauth' ? 1 : 0);
}
if (args.includes('/usage')) {
  if (process.env.STELLARCORTEX_FAKE_CLAUDE_USAGE_LOG)
    fs.appendFileSync(process.env.STELLARCORTEX_FAKE_CLAUDE_USAGE_LOG, 'usage\n');
  console.log(
    JSON.stringify(
      mode === 'usagefail'
        ? { is_error: true, result: 'Usage unavailable' }
        : {
            type: 'result',
            local_command: 'usage',
            num_turns: 0,
            total_cost_usd: 0,
            is_error: false,
            result:
              'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 2% used · resets Oct 26, 7pm (Asia/Jerusalem)\nCurrent week (all models): 10% used · resets Nov 1, 12pm (Asia/Jerusalem)',
          },
    ),
  );
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const user = JSON.parse(input),
  option = name => args[args.indexOf(name) + 1],
  id = user.session_id;
if (user.type === 'control_request') {
  console.log(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: user.request_id,
        response: {
          models: [
            {
              value: 'default',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Default',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium'],
            },
            {
              value: 'sonnet',
              resolvedModel: 'claude-sonnet-5-5',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high'],
            },
            {
              value: 'fable',
              resolvedModel: 'claude-fable-5-1',
              supportsEffort: true,
              supportedEffortLevels: ['high'],
            },
          ],
        },
      },
    }),
  );
  process.exit(0);
}
if (process.env.STELLARCORTEX_FAKE_CLAUDE_LOG)
  fs.appendFileSync(
    process.env.STELLARCORTEX_FAKE_CLAUDE_LOG,
    JSON.stringify({ args: args.filter((_, i) => args[i - 1] !== '--mcp-config'), input: user }) +
      '\n',
  );
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'fail') {
  process.stderr.write('Deliberate fake failure');
  process.exit(4);
}
if (mode === 'noauto' && option('--permission-mode') === 'auto') {
  process.stderr.write('Automatic mode is unavailable for this account');
  process.exit(4);
}
out({
  type: 'system',
  subtype: 'init',
  session_id: id,
  model: 'claude-fake-model',
  permissionMode: mode === 'wrongmode' ? 'default' : option('--permission-mode'),
});
if (mode === 'hang') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'mcp' || mode === 'mcp-elevation') {
  const config = JSON.parse(option('--mcp-config')).mcpServers.stellarcortex;
  const request = async (method, params) => {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { ...config.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fake', version: '1' },
  });
  const tools = await request('tools/list');
  if (!tools.tools.some(t => t.name === 'stellarcortex_memory'))
    throw new Error('Stellar tool missing');
  const permission = await request('tools/call', {
    name: 'approve',
    arguments: {
      tool_name: 'Bash',
      input: { command: mode === 'mcp-elevation' ? 'sudo id' : 'echo test' },
    },
  });
  const allowed = JSON.parse(permission.content[0].text);
  if (allowed.behavior !== 'deny') throw new Error('Denied permission was not forwarded');
  const tool = await request('tools/call', {
    name: 'stellarcortex_memory',
    arguments: { action: 'list' },
  });
  if (tool.content[1]?.type !== 'image' || tool.content[1]?.data !== 'eA==')
    throw new Error('Image tool result was lost');
}
out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-test' } } });
out({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
});
out({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
});
out({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude' } },
});
out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
out({
  type: 'assistant',
  message: { id: 'msg-test', content: [{ type: 'text', text: 'Hello Claude' }] },
});
out({
  type: 'result',
  subtype: 'success',
  result: 'Hello Claude',
  is_error: false,
  session_id: id,
});
