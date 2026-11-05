import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import { loginFacts, submitLogin } from './secret-login.mjs';

const hostOf = url => url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
function ipv6Groups(ip) {
  const dotted = ip.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    ip = `${dotted[1]}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const [head, tail] = ip.split('::'),
    left = head ? head.split(':') : [],
    right = tail ? tail.split(':') : [];
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(group =>
    parseInt(group, 16),
  );
}
// These IPv6 forms reach the host of the IPv4 address they carry: mapped, translated, compatible, NAT64 and 6to4.
function unmapped(ip) {
  ip = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip.split('%')[0]),
    ipv4 = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
    zero = (from, to) => g.slice(from, to).every(group => group === 0);
  if (
    (zero(0, 5) && g[5] === 0xffff) ||
    (zero(0, 4) && g[4] === 0xffff && g[5] === 0) ||
    zero(0, 6) ||
    (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))
  )
    return ipv4(g[6], g[7]);
  return g[0] === 0x2002 ? ipv4(g[1], g[2]) : ip;
}
export function privateAddress(ip) {
  ip = unmapped(ip);
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  return (
    ip === '::' ||
    ip === '::1' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    /^fe[89ab]/.test(ip) ||
    ip.startsWith('ff') ||
    ip.startsWith('2001:db8') ||
    !net.isIP(ip)
  );
}
const metadataAddress = ip => {
  ip = unmapped(ip);
  return ip.startsWith('169.254.') || ip === '100.100.100.200' || ip === 'fd00:ec2::254';
};
export const metadataHost = hostname => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  return host === 'metadata.google.internal' || metadataAddress(host);
};
const addresses = host =>
  net.isIP(host) ? Promise.resolve([{ address: host }]) : dns.lookup(host, { all: true });
export async function publicUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('Only public HTTP/HTTPS URLs without embedded credentials are allowed');
  const host = hostOf(u);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new Error('Private network browsing is disabled');
  const ips = await addresses(host);
  if (!ips.length || ips.some(x => privateAddress(x.address)))
    throw new Error('Private network browsing is disabled');
  return u.href;
}
// Connections the owner configured may use loopback, the LAN and a tailnet, but never a cloud metadata service.
export async function connectionUrl(value) {
  const u = new URL(value),
    host = hostOf(u);
  if (metadataHost(host) || (await addresses(host)).some(x => metadataAddress(x.address)))
    throw new Error('Cloud metadata endpoints cannot be connection targets');
  return u.href;
}
export const browserTarget = value =>
  value === 'about:blank' ? Promise.resolve('about:blank') : publicUrl(value);
export function refusePasswordSaving(profile) {
  const file = path.join(profile, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...prefs,
      credentials_enable_service: false,
      profile: { ...prefs.profile, password_manager_enabled: false },
    }),
    { mode: 0o600 },
  );
}
export class BrowserWorkspace {
  constructor(dir, { contextFactory = null, urlGuard = publicUrl, secureLogin } = {}) {
    this.contextFactory = contextFactory;
    this.urlGuard = urlGuard;
    this.secureLogin = secureLogin;
    this.loggingIn = new Set();
    this.dir = dir;
    this.pages = new Map();
    this.takeover = new Set();
    this.booting = null;
    this.urlFile = path.join(dir, 'browser-pages.json');
    this.urls = fs.existsSync(this.urlFile)
      ? JSON.parse(fs.readFileSync(this.urlFile, 'utf8'))
      : {};
  }
  async context() {
    if (this.ctx) return this.ctx;
    if (this.booting) return this.booting;
    this.booting = (async () => {
      const { chromium } = await import('playwright');
      if (!this.contextFactory) refusePasswordSaving(path.join(this.dir, 'browser'));
      const ctx = this.contextFactory
        ? await this.contextFactory()
        : await chromium.launchPersistentContext(path.join(this.dir, 'browser'), {
            headless: true,
            ...(process.env.STELLARCORTEX_INSIDE_GUEST === '1' ? { chromiumSandbox: true } : {}),
            viewport: { width: 1280, height: 800 },
            acceptDownloads: true,
            serviceWorkers: 'block',
          });
      await ctx.route('**/*', async route => {
        try {
          await this.urlGuard(route.request().url());
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      ctx.on('close', () => {
        this.ctx = null;
        this.pages.clear();
      });
      this.ctx = ctx;
      return ctx;
    })().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }
  async page(botId, { restore = true } = {}) {
    let p = this.pages.get(botId);
    if (p && !p.isClosed()) return p;
    const saved = restore && this.urls[botId] ? await browserTarget(this.urls[botId]) : null;
    const ctx = await this.context();
    p = await ctx.newPage();
    this.pages.set(botId, p);
    p.on('framenavigated', frame => {
      if (frame !== p.mainFrame() || !/^https?:/.test(frame.url()) || this.loggingIn.has(botId))
        return;
      this.urls[botId] = frame.url();
      const tmp = this.urlFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.urls), { mode: 0o600 });
      fs.renameSync(tmp, this.urlFile);
    });
    if (saved)
      try {
        await p.goto(saved, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {}
    return p;
  }
  currentUrl(botId) {
    const page = this.pages.get(botId);
    return page && !page.isClosed?.() ? page.url() : null;
  }
  async snapshot(botId, create = false) {
    const page = create ? await this.page(botId) : this.pages.get(botId);
    if (!page || page.isClosed())
      return {
        available: false,
        url: '',
        title: '',
        takeover: this.takeover.has(botId),
        image: null,
      };
    let image;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        image = (await page.screenshot({ type: 'jpeg', quality: 65, timeout: 10000 })).toString(
          'base64',
        );
        break;
      } catch (error) {
        if (page.isClosed())
          return {
            available: false,
            image: null,
            url: '',
            title: '',
            takeover: this.takeover.has(botId),
          };
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return {
      ...dimensions,
      url: page.url(),
      title: await page.title(),
      takeover: this.takeover.has(botId),
      image,
    };
  }
  async action(botId, args, manual = false) {
    if (!manual && this.takeover.has(botId))
      throw new Error('The user has control. Wait for them to hand the browser back.');
    const action = args.action;
    let target = null;
    if (action === 'open') {
      try {
        target = await browserTarget(args.url);
      } catch (error) {
        error.rejectedBeforeEffects = true;
        throw error;
      }
    }
    const page =
      action === 'read'
        ? this.pages.get(botId)
        : await this.page(botId, { restore: action !== 'open' });
    if (!page || page.isClosed?.())
      return {
        available: false,
        url: '',
        title: '',
        text: 'No browser page is open. Open a page explicitly.',
      };
    page.setDefaultTimeout(12000);
    if (action === 'open') {
      try {
        await page.goto(target, { waitUntil: 'commit', timeout: 15000 });
      } catch (error) {
        if (error.name !== 'TimeoutError' && !String(error.message).includes('net::ERR_'))
          throw error;
        return {
          available: !page.isClosed?.(),
          url: page.url(),
          title: await page.title().catch(() => ''),
          text: 'Navigation did not complete. Inspect the current page before deciding what to do next.',
          navigation: {
            status: 'failed',
            settled: true,
            effectsPossible: true,
            error: String(error.message).slice(0, 500),
          },
        };
      }
    } else if (action === 'click') {
      if (Number.isFinite(args.x) && Number.isFinite(args.y))
        await page.mouse.click(args.x, args.y);
      else await page.locator(String(args.selector)).first().click();
    } else if (action === 'fill')
      await page
        .locator(String(args.selector))
        .first()
        .fill(String(args.text || ''));
    else if (action === 'type') await page.keyboard.insertText(String(args.text || ''));
    else if (action === 'key') {
      try {
        await page.keyboard.press(String(args.key || 'Enter'));
      } catch (error) {
        if (page.isClosed?.())
          return {
            available: false,
            closed: true,
            url: '',
            title: '',
            text: 'Browser window closed.',
          };
        throw error;
      }
    } else if (action === 'scroll')
      await page.mouse.wheel(0, Math.max(-2400, Math.min(2400, Number(args.amount) || 600)));
    else if (action !== 'read') throw new Error('Unknown browser action');
    if (page.isClosed?.())
      return { available: false, closed: true, url: '', title: '', text: 'Browser window closed.' };
    const text = (
      await page
        .locator('body')
        .innerText({ timeout: 5000 })
        .catch(() => '')
    ).slice(0, 20000);
    const title = await page.title().catch(error => {
      if (page.isClosed?.()) return '';
      throw error;
    });
    return { available: !page.isClosed?.(), url: page.url(), title, text };
  }
  async loginTarget(botId) {
    const page = this.pages.get(botId);
    return !page || page.isClosed() ? { status: 'no-field' } : loginFacts(page, this.secureLogin);
  }
  // Playwright errors can quote the page, so only a status leaves this method.
  async deliverLogin(botId, target, secret) {
    const page = this.pages.get(botId);
    if (!page || page.isClosed())
      return { status: 'target-changed', passwordFieldStillShown: false };
    this.loggingIn.add(botId);
    try {
      return await submitLogin(page, target, secret, this.secureLogin);
    } catch {
      return { status: 'failed', passwordFieldStillShown: false };
    } finally {
      this.loggingIn.delete(botId);
    }
  }
  async close() {
    await this.ctx?.close();
  }
}
