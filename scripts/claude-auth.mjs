import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { claudeCommand } from '../src/claude.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.argv.includes('--help')) {
  console.log(
    'Run from the StellarCortex installation: node scripts/claude-auth.mjs\nSign-in runs in the official Claude Code terminal flow. Use --status to check authentication without signing in. A configured Windows WSL installation is handled automatically.',
  );
} else {
  const status = process.argv.includes('--status'),
    cli = await claudeCommand(),
    command = cli.bin,
    args = [...cli.prefix, 'auth', status ? 'status' : 'login'];
  if (!status)
    console.log(
      'Complete sign-in directly with Claude Code. After sign-in, refresh the Claude connection in StellarCortex Settings.',
    );
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  child.once('error', error => {
    console.error(
      `Claude Code could not start: ${error.message}. Run the StellarCortex installer again or install Claude Code from https://code.claude.com/docs/en/setup`,
    );
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
