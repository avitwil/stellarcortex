import { spawn } from 'node:child_process';
export function guestShell(
  args,
  { signal, spawnImpl = spawn, insideGuest = process.env.STELLARCORTEX_INSIDE_GUEST === '1' } = {},
) {
  if (!insideGuest) throw Error('Refusing native execution outside explicit guest bootstrap');
  const { command, cwd, timeoutMs = 30000 } = args,
    argv = args.args || [];
  if (
    typeof command !== 'string' ||
    command.includes('\0') ||
    !Array.isArray(argv) ||
    argv.some(v => typeof v !== 'string' || v.includes('\0')) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 3600000
  )
    throw Error('Invalid guest command');
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '',
      finished = false,
      reason = null;
    const child = spawnImpl(command, argv, {
      cwd,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = why => {
      if (finished) return;
      clearTimeout(killTimer);
      reason = why;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        if (finished) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 1000);
      killTimer.unref();
    };
    let killTimer;
    const timer = setTimeout(() => stop('timeout'), timeoutMs),
      abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', x => {
      stdout = (stdout + x).slice(-65536);
    });
    child.stderr.on('data', x => {
      stderr = (stderr + x).slice(-65536);
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', () => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(Error('Guest executable could not start'));
      }
    });
    child.once('exit', (exitCode, exitSignal) => {
      if (!finished) {
        finished = true;
        cleanup();
        resolve({ exitCode, signal: exitSignal, stdout, stderr, stopped: reason });
      }
    });
  });
}
