import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Codex } from '../src/codex.mjs';

const stubbed = (servers, configured) => {
  const codex = new Codex();
  codex.request = async method =>
    method === 'config/read' ? { config: { mcp_servers: configured } } : { data: servers };
  return codex;
};
test('only servers in the config are disabled by name, and the built-in is left to features.apps', async () => {
  assert.deepEqual(
    await stubbed(
      [{ name: 'codex_apps' }, { name: 'demo' }, { name: 'from-plugin', pluginId: 'p' }],
      { demo: {} },
    ).disabledNativeServers(),
    { 'mcp_servers.demo.enabled': false },
  );
});
test('a configured server named like the built-in is still disabled', async () => {
  assert.deepEqual(
    await stubbed([{ name: 'codex_apps' }], {
      codex_apps: { url: 'https://example.invalid/mcp' },
    }).disabledNativeServers(),
    { 'mcp_servers.codex_apps.enabled': false },
  );
});
test('an unknown server stops an external job instead of running or breaking every message', async () => {
  await assert.rejects(
    stubbed([{ name: 'surprise' }], {}).disabledNativeServers({ live: true }),
    /cannot be disabled safely/,
  );
});
// Real Codex with an empty home and a fake ChatGPT token, so codex_apps is listed with no login and no real config.
test('real Codex accepts the job config, and no thread has the built-in server or a configured one enabled', async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (!fs.existsSync(path.join(root, 'node_modules', '@openai', 'codex')))
    return t.skip('Codex is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-codex-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const script = path.join(dir, 'probe.mjs'),
    source = new URL('../src/codex.mjs', import.meta.url).href;
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';import path from 'node:path';
const dir=process.env.CODEX_HOME,b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),jwt=b64({alg:'none'})+'.'+b64({email:'test@example.invalid','https://api.openai.com/auth':{chatgpt_account_id:'test',chatgpt_plan_type:'plus'},exp:4102444800})+'.sig';
fs.writeFileSync(path.join(dir,'config.toml'),'[mcp_servers.demo]\\ncommand = "'+process.execPath.replaceAll('\\\\','/')+'"\\nargs = ["-e","setTimeout(()=>{},1000)"]\\nenabled = true\\n');
fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{id_token:jwt,access_token:jwt,refresh_token:'test',account_id:'test'},last_refresh:new Date().toISOString()}));
const {Codex}=await import(${JSON.stringify(source)}),codex=new Codex(),report={};
const names=async threadId=>(await codex.request('mcpServerStatus/list',{threadId},15000)).data.map(server=>server.name+':'+server.runtimeStatus).sort();
try{await codex.start();const disabled=await codex.disabledNativeServers();report.disabled=disabled;
 const open=await codex.request('thread/start',{cwd:dir,config:{}});report.open=await names(open.thread.id);
 const job=await codex.request('thread/start',{cwd:dir,config:{web_search:'disabled','features.apps':false,'features.plugins':false,...disabled}});report.job=await names(job.thread.id);
}catch(error){report.error=error.message;}
console.log(JSON.stringify(report));await codex.stop?.();process.exit(0);`,
  );
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: dir, HOME: dir, USERPROFILE: dir },
    timeout: 60000,
  });
  const report = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(report.error, undefined);
  assert.deepEqual(report.disabled, { 'mcp_servers.demo.enabled': false });
  assert.ok(
    report.open.some(item => item.startsWith('codex_apps:')),
    'the control thread must have the built-in, or this test proves nothing',
  );
  assert.deepEqual(report.job, ['demo:disabled']);
});

const changing = () => {
  const state = {
    configured: { demo: {} },
    servers: [{ name: 'demo' }],
    asked: [],
    codex: new Codex(),
  };
  state.codex.request = async method => {
    state.asked.push(method);
    return method === 'config/read'
      ? { config: { mcp_servers: state.configured } }
      : { data: state.servers };
  };
  return state;
};
test('a plain turn names what the config lists, at once, and never waits for the server list', async () => {
  const f = changing(),
    never = new Promise(() => {}),
    request = f.codex.request;
  f.codex.request = async method => {
    if (method !== 'config/read') {
      f.asked.push(method);
      await never;
    }
    return request(method);
  };
  const first = await Promise.race([
    f.codex.disabledNativeServers(),
    new Promise(resolve => setTimeout(resolve, 500, 'waited')),
  ]);
  assert.deepEqual(
    first,
    { 'mcp_servers.demo.enabled': false },
    'the first turn does not wait for a hung server',
  );
  assert.deepEqual(f.asked, ['config/read']);
  f.configured = { demo: {}, added: {} };
  assert.deepEqual(
    await f.codex.disabledNativeServers(),
    { 'mcp_servers.demo.enabled': false, 'mcp_servers.added.enabled': false },
    'a server added while the app runs is off on the next turn',
  );
});
test('a server the status list leaves out is still turned off, and a name that cannot be is refused at once', async () => {
  assert.deepEqual(await stubbed([], { demo: { enabled: false } }).disabledNativeServers(), {
    'mcp_servers.demo.enabled': false,
  });
  await assert.rejects(
    stubbed([], { 'bad.name': {} }).disabledNativeServers(),
    /cannot be disabled safely/,
  );
});
test('an external job waits for the live list, and stops if it cannot be trusted', async () => {
  const f = changing();
  assert.deepEqual(await f.codex.disabledNativeServers({ live: true }), {
    'mcp_servers.demo.enabled': false,
  });
  assert.deepEqual(f.asked, ['config/read', 'mcpServerStatus/list']);
  f.servers = [{ name: 'surprise' }];
  await assert.rejects(f.codex.disabledNativeServers({ live: true }), /cannot be disabled safely/);
  f.codex.request = async () => {
    throw new Error('list failed');
  };
  await assert.rejects(f.codex.disabledNativeServers({ live: true }), /list failed/);
});
// Real Codex with an empty home: no login and no real config.
test("guest Codex starts with the owner's servers turned off, and refuses only a name it cannot turn off", async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (!fs.existsSync(path.join(root, 'node_modules', '@openai', 'codex')))
    return t.skip('Codex is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-codex-guest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const script = path.join(dir, 'probe.mjs'),
    source = new URL('../src/codex.mjs', import.meta.url).href;
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';import path from 'node:path';
const server=name=>'[mcp_servers.'+name+']\\ncommand = "'+process.execPath.replaceAll('\\\\','/')+'"\\nargs = ["-e","setTimeout(()=>{},1000)"]\\nenabled = true\\n',write=text=>fs.writeFileSync(path.join(process.env.CODEX_HOME,'config.toml'),text);
const {Codex}=await import(${JSON.stringify(source)}),codex=new Codex({guestMode:true}),report={};
try{write(server('demo'));await codex.start();report.ready=codex.ready;report.demo=(await codex.request('config/read',{includeLayers:false})).config.mcp_servers.demo.enabled;await codex.stop();
 write('');await codex.start();report.afterRemoval=codex.ready;await codex.stop();
 write(server('"odd.name"'));await codex.start().catch(error=>{report.refused=error.message;});report.oddReady=codex.ready;
}catch(error){report.error=error.message;}
console.log(JSON.stringify(report));await codex.stop?.();process.exit(0);`,
  );
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: dir, HOME: dir, USERPROFILE: dir },
    timeout: 60000,
  });
  const report = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(report.error, undefined);
  assert.equal(report.ready, true);
  assert.equal(report.demo, false);
  assert.equal(
    report.afterRemoval,
    true,
    'a server the owner removed must not stop the next start',
  );
  assert.match(report.refused, /odd\.name/);
  assert.equal(report.oddReady, false);
});
