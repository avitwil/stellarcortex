import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BrowserSession, focusedBrowserPage } from '../src/browser-session.mjs';
class Page extends EventEmitter {
  constructor(url = 'about:blank') {
    super();
    this.u = url;
  }
  url() {
    return this.u;
  }
  isClosed() {
    return this.closed;
  }
  mainFrame() {
    return this;
  }
  async goto(url) {
    this.u = url;
    this.emit('framenavigated', this);
  }
  async bringToFront() {
    this.front = true;
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
}
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-session-'));
  return { dir, file: path.join(dir, 'session.json') };
};
test('tracks initial tabs, human navigation, closure and freezes shutdown state', async () => {
  const { dir, file } = fixture();
  try {
    const s = new BrowserSession(file),
      a = new Page(),
      b = new Page();
    s.select(a);
    await s.restore({ pages: () => [a] }, async () => {});
    await a.goto('https://example.com/');
    s.select(b);
    await b.goto('https://example.org/');
    s.select(a);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
      urls: ['https://example.com/', 'https://example.org/'],
      active: 0,
    });
    b.close();
    s.freeze();
    a.close();
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
      urls: ['https://example.com/'],
      active: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test('restores multiple URLs and selected tab without replaying actions', async () => {
  const { dir, file } = fixture();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ urls: ['https://example.com/', 'about:blank'], active: 1 }),
    );
    const s = new BrowserSession(file),
      pages = [new Page()];
    await s.restore(
      {
        pages: () => pages,
        newPage: async () => {
          const p = new Page();
          pages.push(p);
          return p;
        },
      },
      async () => {},
    );
    assert.equal(pages.length, 2);
    assert.equal(pages[0].url(), 'https://example.com/');
    assert.equal(pages[1].front, true);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test('validates all saved targets before navigation', async () => {
  const { dir, file } = fixture();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ urls: ['https://example.com/', 'file:///secret'], active: 0 }),
    );
    const s = new BrowserSession(file),
      p = new Page();
    await assert.rejects(
      s.restore({ pages: () => [p] }, async u => {
        if (u.startsWith('file:')) throw Error('rejected');
      }),
    );
    assert.equal(p.url(), 'about:blank');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('multiple visible pages do not overwrite actual selected tab', async () => {
  const a = new Page(),
    b = new Page();
  a.evaluate = async () => ({ visible: true, focused: false });
  b.evaluate = async () => ({ visible: true, focused: true });
  assert.equal(await focusedBrowserPage([a, b], a), b);
  b.evaluate = async () => ({ visible: true, focused: false });
  assert.equal(await focusedBrowserPage([a, b], b), b);
});

test('ambiguous emulated focus preserves last selection', async () => {
  const a = new Page(),
    b = new Page();
  for (const p of [a, b]) p.evaluate = async () => ({ visible: true, focused: true });
  assert.equal(await focusedBrowserPage([a, b], b), b);
});
