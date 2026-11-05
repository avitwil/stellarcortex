import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createApp } from '../src/server.mjs';
import { BrowserWorkspace, refusePasswordSaving } from '../src/browser.mjs';
import { asksForPassword } from '../src/secret-login.mjs';
import { DesktopWorkspace } from '../src/desktop.mjs';
import { TOOLS } from '../src/engine.mjs';

class Runtime extends EventEmitter {
  constructor() {
    super();
    this.ready = false;
    this.responses = [];
  }
  async start() {}
  async stop() {}
  respond(id, result) {
    this.responses.push({ id, result });
  }
  reject() {}
  async request() {
    return {};
  }
}
const until = async check => {
  for (let i = 0; i < 400; i++) {
    const found = check();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out');
};
const client = { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/json' };
const facts = {
  origin: 'https://accounts.example.com',
  host: 'accounts.example.com',
  submitHost: 'accounts.example.com',
  password: true,
  username: true,
};
async function fixture(t, { browser } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-secret-')),
    runtime = new Runtime(),
    app = await createApp({
      dataDir: dir,
      port: 0,
      runtime,
      claudeRuntime: new Runtime(),
      startEngine: false,
    });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const delivered = [];
  app.engine.browser = browser || {
    close: async () => {},
    loginTarget: async () => ({ ...facts }),
    deliverLogin: async (botId, target, secret) => {
      delivered.push(secret);
      return { status: 'submitted', passwordFieldStillShown: false };
    },
    action: async () => ({ url: facts.origin }),
    snapshot: async () => null,
  };
  const base = `http://127.0.0.1:${app.port}`,
    bot = app.store.data.bots[0],
    chat = app.store.data.chats[0];
  const cookie = (
    await fetch(base + '/api/session', {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ key: app.accessKey }),
    })
  ).headers
    .get('set-cookie')
    .split(';')[0];
  const makeJob = (extra = {}) => {
    const job = {
      id: 'job-' + Math.random().toString(36).slice(2),
      botId: bot.id,
      chatId: chat.id,
      status: 'running',
      provider: 'codex',
      attachments: [],
      ...extra,
    };
    app.store.data.jobs.push(job);
    app.engine.active.set(job.id, job);
    return job;
  };
  const pending = () =>
    until(() => app.store.data.approvals.find(a => a.kind === 'secret' && a.status === 'pending'));
  const send = (id, value, headers = {}) =>
    fetch(`${base}/api/secret-requests/${id}`, {
      method: 'POST',
      headers: { 'X-StellarCortex-Client': '1', Cookie: cookie, Origin: base, ...headers },
      body: value,
    });
  const ask = (job, args = { target: 'browser-login' }) =>
    app.engine.tool(job, 'stellarcortex_secret', args).then(result => JSON.parse(result[0].text));
  return { dir, app, base, bot, chat, cookie, runtime, delivered, makeJob, pending, send, ask };
}
test('the tool has no value parameter', () => {
  const tool = TOOLS.find(item => item.name === 'stellarcortex_secret');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['target']);
  assert.deepEqual(tool.inputSchema.properties.target.enum, ['browser-login']);
});
test('a login goes from the dialog to the page, and the model gets a status only', async t => {
  const f = await fixture(t),
    job = f.makeJob({ ownerHosts: ['example.com'] }),
    result = f.ask(job),
    request = await f.pending();
  assert.deepEqual(Object.keys(request.details).sort(), [
    'botName',
    'chatName',
    'hasPasswordField',
    'host',
    'https',
    'needsUsername',
    'ownerNamed',
    'punycode',
    'submitHost',
    'target',
  ]);
  assert.equal(request.details.ownerNamed, true);
  assert.equal(request.details.host, 'accounts.example.com');
  assert.equal((await f.send(request.id, 'owner\0hunter2')).status, 200);
  assert.deepEqual(await result, { status: 'submitted', passwordFieldStillShown: false });
  assert.deepEqual(f.delivered, [{ username: 'owner', password: 'hunter2' }]);
  assert.ok(f.app.store.data.signedInHosts.includes('accounts.example.com'));
  assert.equal(job.external, undefined);
  assert.equal(job.sensitive, undefined);
  assert.equal(job.status, 'running');
  assert.equal((await f.send(request.id, 'owner\0again')).status, 410);
});
test('the prompt carries no model text, and no extra argument gets through', async t => {
  const f = await fixture(t),
    job = f.makeJob();
  await assert.rejects(
    f.ask(job, { target: 'browser-login', reason: 'Your account will be closed' }),
    /only target/,
  );
  await assert.rejects(f.ask(job, { target: 'stdin' }), /only target/);
  await assert.rejects(f.ask(job, { target: 'browser-login', value: 'x' }), /only target/);
  assert.equal(f.app.store.data.approvals.length, 0);
});
test('a tainted job can log in, and the prompt says the owner did not name the site', async t => {
  const f = await fixture(t),
    job = f.makeJob({ external: true, sensitive: true }),
    result = f.ask(job),
    request = await f.pending();
  assert.equal(request.external, true);
  assert.equal(request.details.ownerNamed, false);
  await f.send(request.id, '\0pw');
  assert.equal((await result).status, 'submitted');
});
test('a punycode host is flagged', async t => {
  const f = await fixture(t);
  f.app.engine.browser.loginTarget = async () => ({
    ...facts,
    host: 'xn--ggle-0nda.example',
    submitHost: 'xn--ggle-0nda.example',
  });
  const job = f.makeJob(),
    result = f.ask(job),
    request = await f.pending();
  assert.equal(request.details.punycode, true);
  f.app.engine.resolveApproval(request.id, { approve: false });
  await result;
});
test('a decline ends it for the job, a plain approval is a decline, and there is no nagging', async t => {
  const f = await fixture(t),
    job = f.makeJob(),
    first = f.ask(job),
    request = await f.pending();
  assert.equal(
    (
      await fetch(`${f.base}/api/approvals/${request.id}`, {
        method: 'POST',
        headers: { ...client, Cookie: f.cookie },
        body: JSON.stringify({ approve: true }),
      })
    ).status,
    200,
  );
  assert.equal((await first).status, 'declined');
  assert.equal(f.delivered.length, 0);
  assert.equal((await f.ask(job)).status, 'declined');
  assert.equal(f.app.store.data.approvals.length, 1);
});
test('one open request per bot and two per job', async t => {
  const f = await fixture(t),
    job = f.makeJob(),
    other = f.makeJob();
  const first = f.ask(job),
    request = await f.pending();
  assert.equal((await f.ask(other)).status, 'failed');
  await f.send(request.id, '\0pw');
  await first;
  const second = f.ask(job),
    next = await until(() => f.app.store.data.approvals.find(a => a.status === 'pending'));
  await f.send(next.id, '\0pw');
  await second;
  assert.equal((await f.ask(job)).status, 'failed');
  assert.equal(f.app.store.data.approvals.length, 2);
});
test('a request that expires reports timeout, and a page that is not a login page never prompts', async t => {
  const f = await fixture(t),
    job = f.makeJob(),
    result = f.ask(job),
    request = await f.pending();
  f.app.engine.resolveApproval(request.id, { approve: false, expired: true });
  assert.equal((await result).status, 'timeout');
  f.app.engine.browser.loginTarget = async () => ({ status: 'insecure' });
  assert.equal((await f.ask(f.makeJob())).status, 'insecure');
  f.app.engine.browser.loginTarget = async () => {
    throw new Error('page said hunter2');
  };
  assert.deepEqual(await f.ask(f.makeJob()), { status: 'failed', passwordFieldStillShown: false });
  assert.equal(f.app.store.data.approvals.length, 1);
});
test('the browser and screenshots are refused for all the bot’s jobs while a request is open', async t => {
  const f = await fixture(t),
    job = f.makeJob(),
    other = f.makeJob({ ownerHosts: ['example.com'] }),
    result = f.ask(job),
    request = await f.pending();
  f.bot.computer = 'host';
  await assert.rejects(
    f.app.engine.tool(other, 'stellarcortex_browser', { action: 'read' }),
    /login request is open/,
  );
  await assert.rejects(
    f.app.engine.tool(other, 'stellarcortex_computer', { action: 'screenshot' }),
    /login request is open/,
  );
  await f.send(request.id, '\0pw');
  await result;
  await f.app.engine.tool(other, 'stellarcortex_browser', { action: 'read' });
});
test('the route needs a session, a secure origin, a small body and an open request', async t => {
  const f = await fixture(t),
    job = f.makeJob(),
    result = f.ask(job),
    request = await f.pending();
  assert.equal(
    (
      await fetch(`${f.base}/api/secret-requests/${request.id}`, {
        method: 'POST',
        headers: { 'X-StellarCortex-Client': '1', Origin: f.base },
        body: '\0pw',
      })
    ).status,
    401,
  );
  const noOrigin = await fetch(`${f.base}/api/secret-requests/${request.id}`, {
    method: 'POST',
    headers: { 'X-StellarCortex-Client': '1', Cookie: f.cookie },
    body: '\0pw',
  });
  assert.equal(noOrigin.status, 403);
  const big = await f.send(request.id, Buffer.alloc(4097, 65));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'The request is too large' });
  const gone = await f.send('nope', '\0hunter2');
  assert.equal(gone.status, 410);
  assert.doesNotMatch(await gone.text(), /hunter2/);
  await f.send(request.id, 'no separator');
  assert.equal((await result).status, 'failed');
  assert.equal(f.delivered.length, 0);
});
test('a password is not delivered when admission refuses the request after it was typed', async t => {
  const f = await fixture(t);
  let open = true;
  f.app.engine.workflowContinuations.set('unit', () => open);
  const job = f.makeJob({ workflowUnit: { key: 'unit' } }),
    result = f.ask(job),
    request = await f.pending();
  open = false;
  await f.send(request.id, '\0pw');
  assert.equal((await result).status, 'declined');
  assert.equal(f.delivered.length, 0);
});
test('a request does not survive a restart', async t => {
  const f = await fixture(t),
    job = f.makeJob(),
    result = f.ask(job),
    request = await f.pending();
  f.app.engine.secretRequests.clear();
  assert.equal((await f.send(request.id, '\0pw')).status, 410);
  f.app.engine.resolveApproval(request.id, { approve: false, expired: true });
  await result;
});
test('a password cannot be collected in the question box', async t => {
  for (const params of [
    { questions: [{ id: 'a', question: 'What is your password?' }] },
    { questions: [{ id: 'a', question: 'מה הסיסמה שלך?' }] },
    { questions: [{ id: 'a', question: 'Name', isSecret: true }] },
    { reason: 'I need your passcode', questions: [] },
  ])
    assert.equal(asksForPassword(params), true);
  assert.equal(
    asksForPassword({ questions: [{ id: 'a', question: 'Which file should I open?' }] }),
    false,
  );
  const f = await fixture(t),
    job = f.makeJob({ threadId: 'thread' });
  await f.app.engine.request(
    {
      id: 'q',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread', questions: [{ id: 'a', question: 'Type your password' }] },
    },
    'codex',
  );
  assert.deepEqual(f.runtime.responses, [{ id: 'q', result: { answers: {} } }]);
  assert.equal(f.app.store.data.approvals.length, 0);
  assert.ok(job);
});
test('desktop typing goes through stdin, not the process arguments', async () => {
  const desktop = new DesktopWorkspace('.', { platform: 'linux' }),
    calls = [],
    linux = desktop.transport;
  linux.env.DISPLAY = ':0';
  linux.command = async (name, args, options) => {
    calls.push({ args, options });
    return args[0] === 'getdisplaygeometry' ? '100 100' : Buffer.from('x');
  };
  await linux.request({ action: 'type', text: 'hunter2' });
  const typed = calls.find(call => call.args[0] === 'type');
  assert.equal(typed.options.input, 'hunter2');
  assert.equal(typed.args.includes('hunter2'), false);
});
test('the service has no core dumps and Chromium will not offer to save a password', t => {
  assert.match(
    fs.readFileSync(new URL('../scripts/linux-service.mjs', import.meta.url), 'utf8'),
    /LimitCORE=0/,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{"keep":1,"profile":{"name":"x"}}');
  refusePasswordSaving(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8')), {
    keep: 1,
    profile: { name: 'x', password_manager_enabled: false },
    credentials_enable_service: false,
  });
});

// Real Chromium on a local fixture. The seams let a loopback page stand in for an HTTPS site.
const CANARY = 'Cn4ry-P4ss-7f3e91d2',
  page = (body, head = '') => `<!doctype html><title>x</title>${head}<body>${body}`,
  full =
    '<form method="post" action="/done"><input name="user"><input name="pass" type="password"><button>Go</button></form>';
async function site(t) {
  const received = [],
    server = http.createServer((req, res) => {
      let text = '';
      req.on('data', chunk => (text += chunk));
      req.on('end', () => {
        const url = new URL(req.url, 'http://x'),
          send = html => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
          };
        received.push({ method: req.method, url: req.url, text });
        const routes = {
          '/login': full,
          '/two':
            '<form method="post" action="/two2"><input name="user"><button>Next</button></form>',
          '/two2': full,
          '/hop':
            '<form method="post" action="/hop2"><input name="user"><button>Next</button></form>',
          '/hop2':
            '<form method="post" action="http://localhost:1/done"><input name="pass" type="password"><button>Go</button></form>',
          '/get':
            '<form method="get" action="/done"><input name="user"><input name="pass" type="password"></form>',
          '/none':
            '<form action="/done"><input name="user"><input name="pass" type="password"><button>Go</button></form>',
          '/masked': '<form method="post" action="/done"><input name="pass" type="text"></form>',
          '/hidden':
            '<form method="post" action="/done"><input name="pass" type="password" style="display:none"></form>',
          '/stay':
            '<form method="post" onsubmit="event.preventDefault()"><input name="pass" type="password"></form>',
          '/cross':
            '<form method="post" action="http://localhost:1/done"><input name="pass" type="password"></form>',
          '/plain':
            '<form method="post" action="http://127.0.0.2/done"><input name="pass" type="password"></form>',
        };
        send(page(routes[url.pathname] || '<p>Welcome</p>'));
      });
    });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { received, url: route => `http://127.0.0.1:${server.address().port}${route}` };
}
const secureLogin = url => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
async function chromeBrowser(t, dir) {
  const profile = path.join(dir, 'browser'),
    launch = () => chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
  try {
    const probe = await launch();
    await probe.close();
  } catch {
    t.skip('Chrome is not installed');
    return null;
  }
  return new BrowserWorkspace(dir, {
    contextFactory: launch,
    urlGuard: async () => {},
    secureLogin,
  });
}
async function open(browser, url, botId = 'bot') {
  const tab = await browser.page(botId, { restore: false });
  await tab.goto(url);
  return tab;
}
const realTest = (name, run) =>
  test(name, { timeout: 60000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-page-')),
      browser = await chromeBrowser(t, dir);
    t.after(async () => {
      await browser?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    if (browser) await run(t, browser, await site(t));
  });
realTest(
  'the tool reads the page itself: masked field only, secure target only, GET refused',
  async (t, browser, web) => {
    for (const [route, status] of [
      ['/masked', 'no-field'],
      ['/get', 'insecure'],
      ['/plain', 'insecure'],
    ]) {
      await open(browser, web.url(route));
      const seen = await browser.loginTarget('bot');
      if (route === '/masked') assert.equal(seen.password, false);
      else assert.equal(seen.status, status, route);
    }
    await open(browser, web.url('/hidden'));
    assert.equal((await browser.loginTarget('bot')).status, 'no-field');
    await open(browser, web.url('/login'));
    assert.deepEqual(await browser.loginTarget('bot'), {
      origin: new URL(web.url('/')).origin,
      host: '127.0.0.1',
      submitHost: '127.0.0.1',
      password: true,
      username: true,
    });
    await open(browser, web.url('/cross'));
    assert.equal((await browser.loginTarget('bot')).submitHost, 'localhost');
    browser.secureLogin = undefined;
    await open(browser, web.url('/login'));
    assert.equal((await browser.loginTarget('bot')).status, 'insecure');
  },
);
realTest(
  'a normal login posts the password to the site and fills nothing else',
  async (t, browser, web) => {
    await open(browser, web.url('/login'));
    const target = await browser.loginTarget('bot');
    assert.deepEqual(
      await browser.deliverLogin('bot', target, { username: 'owner', password: CANARY }),
      { status: 'submitted', passwordFieldStillShown: false },
    );
    assert.equal(
      web.received.find(item => item.method === 'POST').text,
      `user=owner&pass=${CANARY}`,
    );
  },
);
realTest('a two-step page gets the username, then the password', async (t, browser, web) => {
  await open(browser, web.url('/two'));
  const target = await browser.loginTarget('bot');
  assert.equal(target.password, false);
  assert.equal(
    (await browser.deliverLogin('bot', target, { username: 'owner', password: CANARY })).status,
    'submitted',
  );
  assert.match(
    web.received.filter(item => item.method === 'POST').at(-1).text,
    new RegExp(`pass=${CANARY}`),
  );
});
realTest('a second step that posts to another host gets no password', async (t, browser, web) => {
  await open(browser, web.url('/hop'));
  const target = await browser.loginTarget('bot');
  assert.equal(
    (await browser.deliverLogin('bot', target, { username: 'owner', password: CANARY })).status,
    'target-changed',
  );
  assert.equal(
    web.received.some(item => `${item.url}${item.text}`.includes(CANARY)),
    false,
  );
});
realTest('a page that changes while the dialog is open gets nothing', async (t, browser, web) => {
  await open(browser, web.url('/login'));
  const target = await browser.loginTarget('bot');
  await open(browser, web.url('/cross'));
  assert.equal(
    (await browser.deliverLogin('bot', target, { username: '', password: CANARY })).status,
    'target-changed',
  );
  await open(browser, web.url('/welcome'));
  assert.equal(
    (await browser.deliverLogin('bot', target, { username: '', password: CANARY })).status,
    'target-changed',
  );
  assert.equal(
    web.received.some(item => `${item.url}${item.text}`.includes(CANARY)),
    false,
  );
});
realTest('a form with no method cannot put the password in a URL', async (t, browser, web) => {
  await open(browser, web.url('/none'));
  const target = await browser.loginTarget('bot');
  assert.equal(
    (await browser.deliverLogin('bot', target, { username: '', password: CANARY })).status,
    'failed',
  );
  assert.equal(
    web.received.some(item => item.url.includes(CANARY)),
    false,
  );
  assert.equal((await browser.page('bot')).url().includes(CANARY), false);
});
realTest('a field that stays on screen is cleared after submit', async (t, browser, web) => {
  const tab = await open(browser, web.url('/stay')),
    target = await browser.loginTarget('bot');
  assert.deepEqual(await browser.deliverLogin('bot', target, { username: '', password: CANARY }), {
    status: 'submitted',
    passwordFieldStillShown: true,
  });
  assert.equal(await tab.locator('input').inputValue(), '');
});
const encodings = value => [
  value,
  Buffer.from(value).toString('base64'),
  createHash('sha256').update(value).digest('hex'),
  createHash('sha256').update(value).digest('base64'),
];
function leaks(dir, texts, value) {
  const needles = encodings(value).map(item => Buffer.from(item)),
    found = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        let data;
        try {
          data = fs.readFileSync(file);
        } catch {
          continue;
        }
        if (needles.some(needle => data.includes(needle))) found.push(file);
      }
    }
  };
  walk(dir);
  for (const text of texts)
    if (encodings(value).some(item => text.includes(item))) found.push('captured output');
  return found;
}
test(
  'canary: after a full login the password is nowhere in the data, the output or the logs',
  { timeout: 90000 },
  async t => {
    const f = await fixture(t),
      browser = await chromeBrowser(t, f.dir);
    if (!browser) return;
    const web = await site(t),
      captured = [],
      methods = ['log', 'info', 'warn', 'error', 'debug'],
      saved = methods.map(name => console[name]);
    methods.forEach(name => {
      console[name] = (...args) => captured.push(args.map(String).join(' '));
    });
    t.after(() =>
      methods.forEach((name, index) => {
        console[name] = saved[index];
      }),
    );
    f.app.engine.browser = browser;
    const job = f.makeJob({ ownerHosts: ['127.0.0.1'] });
    await open(browser, web.url('/login'), f.bot.id);
    const result = f.app.engine.tool(job, 'stellarcortex_secret', { target: 'browser-login' }),
      request = await f.pending();
    assert.equal((await f.send(request.id, `owner\0${CANARY}`)).status, 200);
    const output = await result;
    captured.push(JSON.stringify(output));
    assert.deepEqual(JSON.parse(output[0].text), {
      status: 'submitted',
      passwordFieldStillShown: false,
    });
    assert.equal(
      web.received.find(item => item.method === 'POST').text,
      `user=owner&pass=${CANARY}`,
    );
    captured.push(
      JSON.stringify(await f.app.engine.tool(job, 'stellarcortex_browser', { action: 'read' })),
    );
    captured.push(
      await (await fetch(`${f.base}/api/state`, { headers: { Cookie: f.cookie } })).text(),
    );
    f.app.store.save();
    await browser.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(leaks(f.dir, captured, CANARY), []);
    // Mutation check: the same scan must find each encoded form when it does leak.
    for (const form of encodings(CANARY)) {
      const file = path.join(f.dir, 'leak.bin');
      fs.writeFileSync(
        file,
        Buffer.concat([Buffer.from([0, 1]), Buffer.from(form), Buffer.from([2])]),
      );
      assert.deepEqual(leaks(f.dir, [], CANARY), [file]);
      fs.rmSync(file);
      assert.equal(leaks(f.dir, [form], CANARY).length, 1);
    }
  },
);
