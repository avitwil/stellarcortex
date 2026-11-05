import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { qmpInputEvents } from './desktop-qmp.mjs';
import { linuxKeySequence } from './desktop.mjs';
const execute = promisify(execFile);
export class X11SessionDesktop {
  constructor({
    env = process.env,
    run = (file, args, options) => execute(file, args, options),
  } = {}) {
    if (
      !/^:[0-9]+(?:\.[0-9]+)?$/.test(env.DISPLAY || '') ||
      !env.XAUTHORITY?.startsWith('/') ||
      !env.XDG_RUNTIME_DIR?.startsWith('/')
    )
      throw Error('Dedicated authenticated X11 session required');
    this.env = { ...env };
    this.run = (file, args, options = {}) =>
      run(file, args, { env: this.env, timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...options });
  }
  async status() {
    const { stdout } = await this.run('/usr/bin/xdotool', ['getdisplaygeometry']);
    const dims = String(stdout).trim().split(/\s+/).map(Number);
    if (
      dims.length !== 2 ||
      dims.some(n => !Number.isInteger(n) || n < 2 || n > 8192) ||
      dims[0] * dims[1] > 33554432
    )
      throw Error('Invalid session geometry');
    return { available: true, width: dims[0], height: dims[1], session: 'xfce-x11' };
  }
  async snapshot() {
    const frame = await this.status();
    const { stdout } = await this.run('/usr/bin/import', ['-window', 'root', 'png:-'], {
      encoding: 'buffer',
    });
    const bytes = Buffer.from(stdout);
    if (
      bytes.length < 24 ||
      bytes.length > 16 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== frame.width ||
      bytes.readUInt32BE(20) !== frame.height
    )
      throw Error('Invalid session capture');
    return { ...frame, mimeType: 'image/png', image: bytes.toString('base64') };
  }
  async input({ action, frame }) {
    const current = await this.status();
    if (!frame || current.width !== frame.width || current.height !== frame.height)
      throw Object.assign(Error('Session geometry changed; capture again'), {
        rejectedBeforeEffects: true,
      });
    // Reuse the strict action schema, but never send these actions to the VM console.
    try {
      qmpInputEvents(action, frame);
    } catch (error) {
      error.rejectedBeforeEffects = true;
      throw error;
    }
    const position = (x, y) => [
        'mousemove',
        '--sync',
        String(Math.round(x)),
        String(Math.round(y)),
      ],
      button = String({ left: 1, middle: 2, right: 3 }[action.button || 'left']);
    let args;
    if (action.action === 'move') args = position(action.x, action.y);
    else if (['click', 'doubleClick'].includes(action.action))
      args = [
        ...position(action.x, action.y),
        'click',
        '--repeat',
        action.action === 'doubleClick' ? '2' : '1',
        '--delay',
        '120',
        button,
      ];
    else if (action.action === 'drag')
      args = [
        ...position(action.x, action.y),
        'mousedown',
        button,
        ...position(action.toX, action.toY),
        'mouseup',
        button,
      ];
    else if (action.action === 'key')
      args = ['key', '--clearmodifiers', linuxKeySequence(action.key)];
    else if (action.action === 'scroll')
      args = [
        'click',
        '--repeat',
        String(Math.min(20, Math.max(1, Math.round(Math.abs(action.amount) / 120)))),
        '--delay',
        '30',
        action.amount > 0 ? '5' : '4',
      ];
    await this.run('/usr/bin/xdotool', args);
    return { ok: true };
  }
  async releaseInputs() {
    await this.run('/usr/bin/xdotool', [
      'keyup',
      'Shift_L',
      'Shift_R',
      'Control_L',
      'Control_R',
      'Alt_L',
      'Alt_R',
      'Super_L',
      'Super_R',
      'mouseup',
      '1',
      'mouseup',
      '2',
      'mouseup',
      '3',
    ]);
    return { released: true };
  }
  setTakeover() {}
  async close() {}
}
export function x11SessionText(text, { signal, env = process.env, spawnImpl = spawn } = {}) {
  if (
    typeof text !== 'string' ||
    !text ||
    [...text].length > 1024 ||
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(text) ||
    !env.DISPLAY ||
    !env.XAUTHORITY
  )
    throw Object.assign(Error('Bounded Unicode input in an authenticated session required'), {
      rejectedBeforeEffects: true,
    });
  if (signal?.aborted)
    throw Object.assign(Error('Text cancelled before dispatch'), { rejectedBeforeEffects: true });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      '/usr/bin/xdotool',
      ['type', '--clearmodifiers', '--delay', '20', '--file', '-'],
      { env: { ...env }, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    let stopping = false,
      killTimer;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, 35000);
    timer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
    };
    child.once('error', () => {
      cleanup();
      reject(
        Object.assign(Error('Session input could not start'), { rejectedBeforeEffects: true }),
      );
    });
    child.once('close', code => {
      cleanup();
      if (stopping)
        resolve({ cancelled: true, partialInputPossible: true, verificationRequired: true });
      else if (code === 0) resolve({ submitted: [...text].length, verificationRequired: true });
      else reject(Error('Session input ended without confirmation'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
