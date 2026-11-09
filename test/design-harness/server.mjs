// Static preview of public/ with in-memory fixture data, for checking designs.
// It never touches src/, a data directory, a provider or the network.
//   node test/design-harness/server.mjs [port]
// /__set?design=&theme=&language=&go=/ changes the fixture settings.
// /__frame?w=&h=&u= shows a page in an iframe of that size (phone widths).
// A URL hash of #apps, #tasks, #settings or #settings:<pane> opens that screen.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtureState,
  fixtureKanban,
  fixtureAccount,
  fixtureMcp,
  fixtureUpdate,
} from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)),
  publicDir = path.join(here, '..', '..', 'public');
const port = Number(process.argv[2] || 8780);
const settings = {
  theme: 'dark',
  language: 'he',
  design: 'observatory',
  timezone: 'Asia/Jerusalem',
  concurrency: 2,
  model: '',
  notifications: false,
};
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'";
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};
const readBody = req =>
  new Promise(resolve => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
  });
const drive = `addEventListener('load',()=>{const [screen,pane]=location.hash.slice(1).split(':');if(!screen)return;const wait=(test,then,tries=60)=>{const found=test();if(found)then(found);else if(tries)setTimeout(()=>wait(test,then,tries-1),50);};
if(screen==='settings')wait(()=>document.querySelector('#account .account-circle'),()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true}));if(pane)wait(()=>document.querySelector('[data-settings-pane="'+pane+'"]'),b=>b.click());});
else wait(()=>document.querySelector(screen==='apps'?'#connect-apps-nav':'#tasks-nav'),b=>b.click());});`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'),
      p = url.pathname;
    res.setHeader('Content-Security-Policy', csp);
    if (p === '/__set') {
      for (const key of ['design', 'theme', 'language', 'secret'])
        if (url.searchParams.has(key)) settings[key] = url.searchParams.get(key);
      res.writeHead(302, { Location: url.searchParams.get('go') || '/' });
      return res.end();
    }
    if (p === '/__drive.js') {
      res.writeHead(200, { 'Content-Type': types['.js'] });
      return res.end(drive);
    }
    if (p === '/__frame') {
      const w = Number(url.searchParams.get('w')) || 375,
        h = Number(url.searchParams.get('h')) || 800,
        src = url.searchParams.get('u') || '/';
      res.writeHead(200, { 'Content-Type': types['.html'] });
      return res.end(
        `<!doctype html><body style="margin:0;background:#666"><iframe src="${src.replace(/"/g, '')}" style="width:${w}px;height:${h}px;border:0;display:block"></iframe>`,
      );
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      const beat = setInterval(() => res.write(': beat\n\n'), 15000);
      req.on('close', () => clearInterval(beat));
      return;
    }
    if (p === '/api/state') return json(res, fixtureState(settings));
    if (p === '/api/settings' && req.method === 'PATCH') {
      Object.assign(settings, await readBody(req));
      return json(res, settings);
    }
    if (p === '/api/account' || /^\/api\/providers\/[^/]+\/account$/.test(p))
      return json(res, fixtureAccount());
    if (p === '/api/provider-connections') return json(res, { connections: [] });
    if (p === '/health') return json(res, { ok: true, version: '0.1.0' });
    if (p === '/api/desktop/status') return json(res, { available: false });
    if (p === '/api/kanban' && req.method === 'GET') return json(res, fixtureKanban(settings));
    if (p === '/api/mcp/connections') return json(res, { connections: fixtureMcp() });
    if (p === '/api/software-update') return json(res, fixtureUpdate());
    if (p === '/api/claude-permissions')
      return json(res, { defaultMode: 'manual', effectiveMode: 'manual', bots: [] });
    if (p === '/api/computer-modes')
      return json(res, {
        vm: { available: true },
        host: { platform: 'linux', state: 'x11', screen: true },
        bots: fixtureState(settings)
          .bots.slice(0, 3)
          .map((bot, index) => ({
            id: bot.id,
            name: bot.name,
            computer: ['none', 'vm', 'host'][index],
          })),
      });
    if (p.startsWith('/api/') || p.startsWith('/hooks/'))
      return json(res, req.method === 'GET' ? {} : { ok: true });
    const asset = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)),
      file = path.resolve(publicDir, asset);
    if (
      !file.startsWith(publicDir + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    if (asset === 'index.html')
      return res.end(
        fs
          .readFileSync(file, 'utf8')
          .replace('</body>', '<script src="/__drive.js"></script></body>'),
      );
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`Design harness on http://127.0.0.1:${port}`));
