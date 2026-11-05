import fs from 'node:fs';
import path from 'node:path';
import { defaultData } from '../src/server.mjs';
const base = `http://127.0.0.1:${process.env.PORT || 4317}`,
  key = fs.readFileSync(path.join(defaultData(), 'access-key'), 'utf8').trim();
const login = await fetch(base + '/api/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
  body: JSON.stringify({ key }),
  signal: AbortSignal.timeout(5000),
});
if (!login.ok) throw new Error('Could not authenticate to this installation');
const cookie = login.headers.get('set-cookie').split(';')[0];
const r = await fetch(base + '/api/shutdown', {
  method: 'POST',
  headers: { Cookie: cookie, 'X-StellarCortex-Client': '1' },
});
if (!r.ok) throw new Error('Shutdown request failed');
let stopped = false;
for (let i = 0; i < 60; i++) {
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
  } catch {
    stopped = true;
    break;
  }
}
if (!stopped) throw new Error('Server did not finish shutting down within 15 seconds');
console.log('StellarCortex stopped. Running tasks were interrupted, not replayed.');
