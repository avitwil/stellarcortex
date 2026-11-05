import fs from 'node:fs';
// Navigation state only: never persists form input or replays browser actions.
export class BrowserSession {
  constructor(file) {
    this.file = file;
    this.pages = [];
    this.active = null;
    this.suspended = true;
    this.saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (
      this.saved &&
      (!Array.isArray(this.saved.urls) || this.saved.urls.some(u => typeof u !== 'string'))
    )
      throw Error('Invalid saved browser session');
  }
  track(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    page.on('framenavigated', f => {
      if (f === page.mainFrame()) this.save();
    });
    page.on('close', () => {
      this.pages = this.pages.filter(p => p !== page);
      if (this.active === page) this.active = this.pages.at(-1) || null;
      this.save();
    });
  }
  select(page) {
    this.track(page);
    if (this.active !== page) {
      this.active = page;
      this.save();
    }
  }
  snapshot() {
    const pages = this.pages.filter(p => !p.isClosed()),
      urls = pages.map(p => p.url());
    if (
      urls.some(u => {
        try {
          const v = new URL(u);
          return (
            u !== 'about:blank' &&
            (!['https:', 'http:'].includes(v.protocol) || v.username || v.password)
          );
        } catch {
          return true;
        }
      })
    )
      return null;
    return { urls, active: Math.max(0, pages.indexOf(this.active)) };
  }
  save() {
    if (this.suspended) return;
    const state = this.snapshot();
    if (!state) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  freeze() {
    this.save();
    this.suspended = true;
  }
  async restore(context, validate) {
    const saved = this.saved;
    if (saved) {
      for (const url of saved.urls) await validate(url);
    }
    if (saved?.urls.length) {
      const initial = context.pages().filter(p => !p.isClosed());
      let selected = null;
      for (let i = 0; i < saved.urls.length; i++) {
        const page =
          i === 0 && initial.length === 1 && initial[0].url() === 'about:blank'
            ? initial[0]
            : await context.newPage();
        this.track(page);
        await page.goto(saved.urls[i], { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
        if (i === saved.active) selected = page;
      }
      this.active = selected || this.pages.at(-1);
      if (this.active) await this.active.bringToFront();
    } else for (const p of context.pages()) this.track(p);
    this.suspended = false;
    this.save();
  }
}

export async function focusedBrowserPage(pages, previous) {
  const candidates = [],
    focused = [];
  for (const page of pages)
    if (!page.isClosed()) {
      const state = await page
        .evaluate(() => ({
          focused: document.hasFocus(),
          visible: document.visibilityState === 'visible',
        }))
        .catch(() => null);
      if (state?.focused) focused.push(page);
      if (state?.visible) candidates.push(page);
    }
  if (focused.length === 1) return focused[0];
  return candidates.length === 1
    ? candidates[0]
    : previous && !previous.isClosed()
      ? previous
      : candidates.at(-1) || null;
}
