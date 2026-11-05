import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGNS,
  DEFAULT_DESIGN,
  normalizeDesign,
  orderTeam,
  designPickerMarkup,
  chatStatus,
} from '../public/themes/design.js';

import { boardCounts, jobCounts, recentActivity, createMission } from '../public/themes/mission.js';
import { compact, compactCss } from './helpers/source-text.mjs';

const pub = file => path.join(import.meta.dirname, '..', 'public', file);
const tr = (he, en) => en;
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const names = ordered => ordered.map(item => `${item.entry.botId}:${item.depth}`);

test('unknown or missing designs fall back to the default', () => {
  assert.equal(normalizeDesign(undefined), DEFAULT_DESIGN);
  assert.equal(normalizeDesign('../../etc'), DEFAULT_DESIGN);
  for (const design of DESIGNS) assert.equal(normalizeDesign(design.id), design.id);
});

test('team order nests members under their manager', () => {
  const ordered = orderTeam([
    { botId: 'b' },
    { botId: 'a', managerId: 'b' },
    { botId: 'c' },
    { botId: 'd', managerId: 'a' },
    { botId: 'e', managerId: 'b' },
  ]);
  assert.deepEqual(names(ordered), ['b:0', 'a:1', 'd:2', 'e:1', 'c:0']);
  assert.deepEqual(
    ordered.filter(item => item.lead).map(item => item.entry.botId),
    ['b', 'a'],
  );
  assert.deepEqual(
    ordered.filter(item => item.last).map(item => item.entry.botId),
    ['d', 'e'],
  );
});

test('team order keeps every entry when managers are missing, self-referencing or cyclic', () => {
  const entries = [
    { botId: 'gone', managerId: 'nobody' },
    { botId: 'self', managerId: 'self' },
    { botId: 'x', managerId: 'y' },
    { botId: 'y', managerId: 'x' },
    { botId: undefined },
  ];
  const ordered = orderTeam(entries);
  assert.equal(ordered.length, entries.length);
  assert.ok(ordered.every(item => item.depth === 0));
});

test('chat status prefers a waiting job over a running one and ignores finished work', () => {
  const jobs = [
    { chatId: 'a', status: 'running' },
    { chatId: 'a', status: 'waiting' },
    { chatId: 'b', status: 'queued' },
    { chatId: 'c', status: 'completed' },
  ];
  assert.equal(chatStatus(jobs, 'a'), 'waiting');
  assert.equal(chatStatus(jobs, 'b'), 'running');
  assert.equal(chatStatus(jobs, 'c'), '');
});

test('board counts group stages and skip archived cards', () => {
  const cards = [
    'todo',
    'idea',
    'in-progress',
    'specification',
    'development',
    'approval',
    'testing',
    'done',
  ].map(stage => ({ stage }));
  assert.deepEqual(boardCounts([...cards, { stage: 'done', archivedAt: 'x' }]), {
    todo: 2,
    working: 3,
    review: 2,
    done: 1,
  });
  assert.deepEqual(boardCounts(undefined), { todo: 0, working: 0, review: 0, done: 0 });
});

test('job counts report live work and pending approvals only', () => {
  const state = {
    jobs: [
      { status: 'running' },
      { status: 'queued' },
      { status: 'waiting' },
      { status: 'completed' },
    ],
    approvals: [{ status: 'pending' }, { status: 'approved' }],
  };
  assert.deepEqual(jobCounts(state), { working: 2, waiting: 1 });
});

test('recent activity lists tool messages, newest first', () => {
  const messages = [
    { role: 'tool', id: 'a', createdAt: '1' },
    { role: 'assistant', id: 'b', createdAt: '3' },
    { role: 'tool', id: 'c', createdAt: '2' },
  ];
  assert.deepEqual(
    recentActivity(messages).map(item => item.id),
    ['c', 'a'],
  );
  assert.equal(recentActivity(messages, 1).length, 1);
  assert.equal(messages[0].id, 'a');
});

test('the design picker marks the saved design and offers every design', () => {
  const last = DESIGNS.at(-1).id,
    html = designPickerMarkup(last, { tr, esc });
  for (const design of DESIGNS) assert.ok(html.includes(`value="${design.id}"`));
  assert.equal(html.match(/ checked/g).length, 1);
  assert.match(html, new RegExp(`value="${last}" checked`));
  assert.match(
    designPickerMarkup('nope', { tr, esc }),
    new RegExp(`value="${DEFAULT_DESIGN}" checked`),
  );
});

test('every design ships a linked stylesheet with both colour modes', () => {
  const index = fs.readFileSync(pub('index.html'), 'utf8');
  for (const design of DESIGNS) {
    assert.ok(index.includes(`href="/themes/${design.id}.css"`), design.id);
    const css = compactCss(fs.readFileSync(pub(`themes/${design.id}.css`), 'utf8'));
    assert.ok(css.includes(`html[data-design=${design.id}] body{`), design.id);
    assert.ok(css.includes(`html[data-design=${design.id}] body.light{`), design.id);
  }
});

test('fonts are self-hosted, present and licensed', () => {
  const css = fs.readFileSync(pub('themes/fonts.css'), 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.match(url, /^\/fonts\/[a-z0-9-]+\.woff2$/);
    assert.ok(fs.existsSync(pub(url.slice(1))), url);
  }
  const licences = fs.readdirSync(pub('fonts/licenses'));
  for (const family of ['assistant', 'bellefair', 'rubik', 'ibm-plex-sans-hebrew', 'ibm-plex-mono'])
    assert.ok(licences.includes(`${family}-OFL.txt`), family);
});

test('the shell and theme styles make no external requests', () => {
  const files = ['index.html', ...fs.readdirSync(pub('themes')).map(file => `themes/${file}`)];
  for (const file of files) {
    const text = fs.readFileSync(pub(file), 'utf8').replace(/http:\/\/www\.w3\.org\/\d+\/svg/g, '');
    assert.doesNotMatch(text, /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, file);
  }
});

test('the Mission bar hides with the workspace and its buttons do nothing after lock or session expiry', t => {
  assert.match(
    compactCss(fs.readFileSync(pub('themes/mission.css'), 'utf8')),
    /html\[data-design=mission\]:has\(#app\[hidden\]\) #design-bar\{display:none\}/,
  );
  const nodes = new Map(),
    node = () => ({
      dataset: {},
      style: {},
      hidden: false,
      querySelector: () => node(),
      querySelectorAll: () => [],
      setAttribute() {},
      insertAdjacentHTML() {},
      append() {},
      remove() {},
    });
  const find = selector => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  globalThis.document = {
    querySelector: find,
    querySelectorAll: () => [],
    body: { classList: { contains: () => false }, insertBefore: child => child },
    documentElement: { dir: 'ltr', hasAttribute: () => false },
    createElement: node,
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  let state = {
      jobs: [{ chatId: 'c1', status: 'running' }],
      approvals: [{ chatId: 'c2', status: 'pending' }],
      messages: [],
      bots: [],
      chats: [],
    },
    calls = [];
  const record =
    name =>
    (...args) =>
      calls.push([name, ...args]);
  const mission = createMission({
    tr,
    esc,
    state: () => state,
    view: () => 'chat',
    chatId: () => null,
    detailTab: () => 'chat',
    online: () => true,
    api: async () => ({ projects: [], cards: [] }),
    toast() {},
    relativeTime: () => '',
    search: record('search'),
    settings: record('settings'),
    openChat: record('chat'),
    setTheme: record('theme'),
    showTab() {},
    taskDetails() {},
  });
  t.after(() => {
    mission.unmount();
    Object.assign(globalThis, saved);
  });
  mission.render();
  const buttons = [
    '#design-search',
    '#design-working',
    '#design-waiting',
    '#design-settings',
    '#design-theme',
  ].map(find);
  for (const button of buttons) button.onclick();
  assert.deepEqual(
    calls.map(call => call[0]),
    ['search', 'chat', 'chat', 'settings', 'theme'],
  );
  calls = [];
  find('#app').hidden = true;
  for (const button of buttons) button.onclick();
  assert.deepEqual(calls, []);
  find('#app').hidden = false;
  state = undefined;
  for (const button of buttons) button.onclick();
  assert.deepEqual(calls, []);
});
