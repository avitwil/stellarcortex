import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorkspace, browserTarget } from '../src/browser.mjs';
test('rejected navigation does not obtain, create or restore a browser page', async () => {
  const b = new BrowserWorkspace('/unused-browser-validation');
  let obtained = 0;
  b.page = async () => {
    obtained++;
    throw Error('Page must not be obtained');
  };
  for (const url of [
    'file:///tmp/a',
    'javascript:alert(1)',
    'http://127.0.0.1/',
    'https://user:password@example.com/',
    'about:blank#fragment',
    'invalid',
  ])
    await assert.rejects(b.action('bot', { action: 'open', url }));
  assert.equal(obtained, 0);
});
test('exact blank page target is explicit and skips previous URL restoration', async () => {
  const b = new BrowserWorkspace('/unused-browser-validation'),
    calls = [];
  b.page = async (bot, options) => {
    calls.push({ bot, options });
    return {
      setDefaultTimeout() {},
      goto: async url => calls.push(url),
      locator: () => ({ innerText: async () => '' }),
      url: () => 'about:blank',
      title: async () => '',
    };
  };
  assert.equal(await browserTarget('about:blank'), 'about:blank');
  assert.equal((await b.action('bot', { action: 'open', url: 'about:blank' })).url, 'about:blank');
  assert.deepEqual(calls, [{ bot: 'bot', options: { restore: false } }, 'about:blank']);
});
test('invalid saved URL cannot initialize browser context during restoration', async () => {
  const b = new BrowserWorkspace('/unused-browser-validation');
  b.urls.bot = 'file:///tmp/a';
  let contexts = 0;
  b.context = async () => {
    contexts++;
    throw Error('No context permitted');
  };
  await assert.rejects(b.page('bot'), /public HTTP/);
  assert.equal(contexts, 0);
});
test('read and snapshot never create or restore pages', async () => {
  const b = new BrowserWorkspace('/unused-browser-validation');
  b.urls.bot = 'https://example.com/';
  b.page = async () => {
    throw Error('Observation must not navigate');
  };
  assert.equal((await b.action('bot', { action: 'read' })).available, false);
  assert.equal((await b.snapshot('bot')).available, false);
  b.takeover.add('bot');
  assert.equal((await b.snapshot('bot')).takeover, true);
});
test('settled navigation timeout returns an inspectable failure, not a replay request', async () => {
  const b = new BrowserWorkspace('/unused-browser-validation');
  b.page = async () => ({
    setDefaultTimeout() {},
    goto: async () => {
      throw Object.assign(Error('navigation timeout'), { name: 'TimeoutError' });
    },
    isClosed: () => false,
    url: () => 'about:blank',
    title: async () => '',
  });
  const r = await b.action('bot', { action: 'open', url: 'about:blank' });
  assert.equal(r.navigation.settled, true);
  assert.equal(r.navigation.effectsPossible, true);
  assert.equal(r.navigation.status, 'failed');
});
import { VisibleBrowserWorkspace } from '../src/visible-browser.mjs';
test('malformed visible-browser arguments reject before contacting a browser', async () => {
  const browser = new VisibleBrowserWorkspace('/unused', {});
  let calls = 0;
  browser.request = async () => {
    calls++;
  };
  for (const args of [undefined, null, [], 17])
    await assert.rejects(
      browser.action('bot', args),
      error => error.rejectedBeforeEffects === true,
    );
  assert.equal(calls, 0);
});
