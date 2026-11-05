import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { logProcessOutput } from './process-output.mjs';

const aliases = {
  Ctrl: 'Control',
  Win: 'Meta',
  Super: 'Meta',
  Return: 'Enter',
  Esc: 'Escape',
  Del: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};
const named = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'Insert',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
export function normalizeKey(value) {
  const parts = String(value || '')
    .split('+')
    .map(x => aliases[x] || x);
  if (
    !parts.length ||
    parts.length > 5 ||
    parts.some(x => !named.has(x) && !/^[A-Za-z0-9]$/.test(x))
  )
    throw new Error('Unsupported key. Use named keys such as Control+A, Enter, Tab or ArrowDown.');
  if (parts.slice(0, -1).some(x => !['Control', 'Shift', 'Alt', 'Meta'].includes(x)))
    throw new Error('Only modifier keys may precede the final key.');
  return parts;
}
export function linuxKeySequence(value) {
  const keys = normalizeKey(Array.isArray(value) ? value.join('+') : value);
  const names = {
    Control: 'ctrl',
    Shift: 'shift',
    Alt: 'alt',
    Meta: 'super',
    Enter: 'Return',
    Escape: 'Escape',
    Backspace: 'BackSpace',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    PageUp: 'Prior',
    PageDown: 'Next',
    Space: 'space',
  };
  // xdotool treats an uppercase keysym as an implicit Shift. Chords use the base
  // letter so only an explicit Shift modifier is pressed; standalone capitals
  // retain their text-entry semantics.
  return keys
    .map(
      (key, index) =>
        names[key] ||
        (keys.length > 1 && index === keys.length - 1 && /^[A-Z]$/.test(key)
          ? key.toLowerCase()
          : key),
    )
    .join('+');
}
function execute(command, args, { input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        ...options,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        logProcessOutput(path.basename(command), stderr, String(error.signal || error.code));
        reject(new Error(`${path.basename(command)} failed. Details are in the server log.`));
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

class LinuxDesktop {
  constructor(env = {}) {
    this.env = {
      ...process.env,
      DISPLAY: process.env.STELLARCORTEX_DESKTOP_DISPLAY || process.env.DISPLAY || '',
      ...env,
    };
  }
  async command(name, args, options = {}) {
    return execute(name, args, { env: this.env, ...options });
  }
  async request(a) {
    if (!this.env.DISPLAY)
      throw new Error(
        'No X11 DISPLAY. Log in to an X11 session and give the service DISPLAY and XAUTHORITY.',
      );
    const dims = (await this.command('xdotool', ['getdisplaygeometry']))
      .trim()
      .split(/\s+/)
      .map(Number);
    if (dims.length !== 2 || dims.some(n => !Number.isFinite(n) || n < 1))
      throw new Error('Could not read X11 desktop dimensions.');
    const [sw, sh] = dims,
      scale = Math.min(1, 1600 / sw, 1200 / sh),
      width = Math.round(sw * scale),
      height = Math.round(sh * scale),
      screen = { x: 0, y: 0, width: sw, height: sh };
    const result = { available: true, mode: 'x11-desktop', width, height, screen };
    if (a.action === 'status') return result;
    if (a.action === 'snapshot') {
      const buffer = await this.command(
        'import',
        ['-window', 'root', '-resize', `${width}x${height}!`, '-quality', '72', 'jpeg:-'],
        { encoding: null },
      );
      return { ...result, image: buffer.toString('base64'), mimeType: 'image/jpeg' };
    }
    const pos = (x, y) => ['mousemove', '--sync', String(x), String(y)];
    if (a.action === 'move') await this.command('xdotool', pos(a.x, a.y));
    else if (a.action === 'click' || a.action === 'doubleClick') {
      await this.command('xdotool', [
        ...pos(a.x, a.y),
        'click',
        '--repeat',
        a.action === 'doubleClick' ? '2' : '1',
        '--delay',
        '120',
        String({ left: 1, middle: 2, right: 3 }[a.button]),
      ]);
    } else if (a.action === 'drag') {
      await this.command('xdotool', [
        ...pos(a.x, a.y),
        'mousedown',
        '1',
        ...pos(a.toX, a.toY),
        'mouseup',
        '1',
      ]);
    } else if (a.action === 'type')
      await this.command('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--file', '-'], {
        input: a.text,
      });
    else if (a.action === 'key')
      await this.command('xdotool', ['key', '--clearmodifiers', linuxKeySequence(a.keys)]);
    else if (a.action === 'scroll') {
      await this.command('xdotool', [
        'click',
        '--repeat',
        String(Math.max(1, Math.min(20, Math.round(Math.abs(a.amount) / 120)))),
        '--delay',
        '30',
        a.amount > 0 ? '5' : '4',
      ]);
    } else throw new Error('Unknown desktop action');
    return { ok: true, ...result };
  }
  async close() {}
}

export class DesktopWorkspace {
  constructor(dir, { platform = process.platform, transport = null } = {}) {
    this.dir = dir;
    this.enabled = true;
    this.platform = platform;
    this.transport = transport || (platform === 'linux' ? new LinuxDesktop() : null);
    this.mode = platform === 'linux' ? 'x11-desktop' : 'unsupported';
    this.owner = null;
    this.takeoverBotId = null;
    this.frames = new Map();
    this.frameHistory = new Map();
    this.removingBots = new Set();
    this.queue = Promise.resolve();
    this.lastStatus = null;
  }
  invalidateFrames() {
    this.frames.clear();
    this.frameHistory.clear();
  }
  metadata() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      ownerBotId: this.owner?.botId || null,
      ownerRunId: this.owner?.runId || null,
      takeover: !!this.takeoverBotId,
      takeoverBotId: this.takeoverBotId,
    };
  }
  async status() {
    if (!this.enabled)
      return { ...this.metadata(), available: false, reason: 'The desktop has shut down.' };
    if (!this.transport)
      return {
        ...this.metadata(),
        available: false,
        reason: 'Desktop control supports Linux X11.',
      };
    try {
      const status = await this.serial(() => this.transport.request({ action: 'status' }));
      this.lastStatus = status;
      return { ...status, ...this.metadata() };
    } catch (e) {
      return { ...this.metadata(), available: false, reason: e.message };
    }
  }
  requireEnabled() {
    if (!this.enabled) throw new Error('The desktop has shut down.');
    if (!this.transport)
      throw new Error('This operating system is not supported for desktop control.');
  }
  serial(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  acquire(botId, runId) {
    this.requireEnabled();
    if (this.takeoverBotId)
      throw new Error('The user has desktop control. Wait for them to release it.');
    if (this.owner && this.owner.runId !== runId)
      throw new Error(
        `The desktop is in use by bot ${this.owner.botId}. Wait for that task to finish.`,
      );
    this.owner = { botId, runId };
    return this.metadata();
  }
  release(runId) {
    if (this.owner?.runId === runId) this.owner = null;
  }
  setTakeover(botId, enabled) {
    this.requireEnabled();
    if (enabled) {
      this.takeoverBotId = botId;
      this.invalidateFrames();
    } else if (this.takeoverBotId === botId) {
      this.takeoverBotId = null;
      this.invalidateFrames();
    }
    return this.metadata();
  }
  async snapshot(botId) {
    this.requireEnabled();
    return this.serial(async () => {
      this.requireEnabled();
      if (this.removingBots.has(botId)) throw new Error('This bot desktop is being removed.');
      const data = await this.transport.request({ action: 'snapshot' });
      if (!data.available || !data.image)
        throw new Error(data.reason || 'Desktop screenshot is unavailable');
      const frame = { ...data, frameId: randomUUID(), at: Date.now() };
      this.frames.set(botId, frame);
      this.frameHistory.set(frame.frameId, { botId, frame });
      for (const [key, entry] of this.frameHistory) {
        if (Date.now() - entry.frame.at > 120000 || this.frameHistory.size > 64)
          this.frameHistory.delete(key);
      }
      this.lastStatus = data;
      return { ...frame, ...this.metadata() };
    });
  }
  async action(botId, args, manual = false) {
    this.requireEnabled();
    return this.serial(async () => {
      this.requireEnabled();
      if (this.removingBots.has(botId)) throw new Error('This bot desktop is being removed.');
      if (manual && this.takeoverBotId !== botId)
        throw new Error('Take control before operating the desktop.');
      if (!manual && this.takeoverBotId)
        throw new Error('The user has desktop control. Do not send input until they release it.');
      if (!manual && this.owner && this.owner.botId !== botId)
        throw new Error(`The desktop is in use by bot ${this.owner.botId}.`);
      const action = String(args.action || ''),
        out = { action };
      if (!['click', 'doubleClick', 'move', 'drag', 'type', 'key', 'scroll'].includes(action))
        throw new Error('Unknown desktop action');
      const historical = args.frameId ? this.frameHistory.get(args.frameId) : null;
      const frame = args.frameId
        ? historical?.botId === botId
          ? historical.frame
          : null
        : this.frames.get(botId);
      if (args.frameId && !frame)
        throw new Error('The screenshot is stale. Read the desktop again before acting.');
      if (['click', 'doubleClick', 'move', 'drag'].includes(action)) {
        if (!frame || Date.now() - frame.at > 120000)
          throw new Error('Take a fresh desktop screenshot before sending coordinates.');
        const current = await this.transport.request({ action: 'status' });
        if (!current.available) throw new Error(current.reason || 'Desktop unavailable.');
        if (['x', 'y', 'width', 'height'].some(key => current.screen?.[key] !== frame.screen[key]))
          throw new Error('Desktop geometry changed. Take a new screenshot.');
        const point = (x, y) => {
          if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < 0 ||
            y < 0 ||
            x >= frame.width ||
            y >= frame.height
          )
            throw new Error('Coordinates are outside the screenshot.');
          return {
            x:
              frame.screen.x +
              Math.min(frame.screen.width - 1, Math.round((x * frame.screen.width) / frame.width)),
            y:
              frame.screen.y +
              Math.min(
                frame.screen.height - 1,
                Math.round((y * frame.screen.height) / frame.height),
              ),
          };
        };
        Object.assign(out, point(args.x, args.y));
        if (action === 'drag') {
          const end = point(args.toX ?? args.endX, args.toY ?? args.endY);
          out.toX = end.x;
          out.toY = end.y;
        }
        out.button = args.button || 'left';
        if (!['left', 'middle', 'right'].includes(out.button))
          throw new Error('Invalid mouse button');
      }
      if (action === 'type') {
        if (typeof args.text !== 'string' || args.text.length > 4000)
          throw new Error('Desktop typing requires up to 4000 characters.');
        out.text = args.text;
      }
      if (action === 'key') out.keys = normalizeKey(args.key);
      if (action === 'scroll') {
        if (!Number.isFinite(args.amount) || args.amount === 0)
          throw new Error('Scroll requires a nonzero amount.');
        out.amount = Math.max(-2400, Math.min(2400, Math.round(args.amount)));
      }
      const result = await this.transport.request(out);
      this.invalidateFrames();
      return { ...result, ...this.metadata() };
    });
  }
  async removeBot(botId) {
    this.removingBots.add(botId);
    if (this.owner?.botId === botId) this.owner = null;
    if (this.takeoverBotId === botId) this.takeoverBotId = null;
    await this.queue;
    this.frames.delete(botId);
    for (const [key, entry] of this.frameHistory)
      if (entry.botId === botId) this.frameHistory.delete(key);
    this.removingBots.delete(botId);
  }
  teachingFrame(botId, frameId) {
    if (this.takeoverBotId !== botId)
      throw new Error('Manual control of this agent is required for teaching');
    const entry = this.frameHistory.get(frameId);
    if (!entry || entry.botId !== botId || Date.now() - entry.frame.at > 120000)
      throw new Error('Teaching frame expired; view the screen again and redraw masks');
    return { ...entry.frame };
  }
  async close() {
    this.enabled = false;
    await this.queue;
    await this.transport?.close();
    this.invalidateFrames();
    this.owner = null;
    this.takeoverBotId = null;
  }
}
