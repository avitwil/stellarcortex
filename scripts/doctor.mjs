import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexCommand } from '../src/codex.mjs';
import { Claude } from '../src/claude.mjs';
import { defaultData } from '../src/server.mjs';
import { ProviderConnections } from '../src/provider-connections.mjs';
console.log('StellarCortex diagnostics');
console.log(`Node ${process.version}; platform ${process.platform} ${process.arch}`);
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Node 22.16 or later is required');
  process.exitCode = 1;
}
const c = codexCommand();
for (const args of [['--version'], ['login', 'status']]) {
  const r = spawnSync(c.bin, [...c.prefix, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  console.log((r.stdout || r.stderr || r.error?.message || '').trim());
  if (r.status !== 0)
    console.log(
      args[0] === '--version'
        ? 'Codex is not fully installed. Run the installer again.'
        : 'Codex is not connected; API or local-model providers can still be used.',
    );
}
try {
  const { chromium } = await import('playwright');
  const bin = chromium.executablePath();
  console.log(`Browser installed: ${fs.existsSync(bin)}`);
  if (!fs.existsSync(bin)) {
    console.log('Run npm run setup:browser');
    process.exitCode = 1;
  }
} catch {
  console.log('Run npm ci first');
  process.exitCode = 1;
}
console.log(`Data: ${path.resolve(defaultData())}`);
try {
  for (const connection of new ProviderConnections(defaultData()).list().connections)
    console.log(
      `${connection.name}: ${connection.configured ? 'configured (not a live connectivity test)' : 'not configured'}`,
    );
} catch (error) {
  console.log(error.message);
  process.exitCode = 1;
}
const claude = new Claude();
try {
  await claude.start();
  const auth = await claude.account();
  console.log(
    `Claude Code ${claude.version}: ${auth.account ? 'subscription signed in' : auth.error}`,
  );
} catch (error) {
  console.log(`Claude Code (optional): ${error.message}`);
} finally {
  await claude.stop();
}
console.log(
  'An installed runtime and a logged-in account do not prove model access. Send a test message to verify inference.',
);
