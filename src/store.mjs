import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { modelFields, botModelFields, providerOf } from './models.mjs';

// The desktop manifest needs this before the app has started, so whichever comes first creates it.
export function installationKey(dir) {
  const file = path.join(dir, 'access-key');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    // Two first starts can race outside the lock. The link appears whole, and only the first one wins.
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, randomBytes(32).toString('hex'), { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key) throw new Error(`The access key file is empty. Remove ${file} and start again.`);
  return key;
}
// Computers are registered to this id. It starts as a hash of the key and survives a new key.
export function ownerAccount(dir) {
  const file = path.join(dir, 'owner-account');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim()
    : createHash('sha256')
        .update('android-owner-v1:' + installationKey(dir))
        .digest('hex');
}
function replaceFile(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function rotateKey(dir) {
  // The id is saved first, so a stop between the two writes loses nothing.
  replaceFile(path.join(dir, 'owner-account'), ownerAccount(dir));
  replaceFile(path.join(dir, 'access-key'), randomBytes(32).toString('hex'));
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function required(value, name, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} is required (maximum ${max} characters)`);
  return value.trim();
}
export function initialState() {
  const botId = id(),
    chatId = id();
  return {
    version: 1,
    settings: {
      theme: 'dark',
      language: 'he',
      design: 'observatory',
      timezone: 'Asia/Jerusalem',
      concurrency: 2,
      model: '',
      notifications: false,
    },
    bots: [
      {
        id: botId,
        provider: 'codex',
        name: 'Stellar',
        title: 'Your chief of staff',
        instructions:
          'Help organize work and deliver finished results. Respond in the user’s language. Coordinate with other bots only when useful for the user’s request.',
        color: 'violet',
        shape: 'round',
        memory: [],
        pinned: true,
        hidden: false,
        section: '',
        createdAt: now(),
      },
    ],
    chats: [
      {
        id: chatId,
        type: 'direct',
        name: 'Stellar',
        botIds: [botId],
        threadIds: {},
        unread: false,
        createdAt: now(),
      },
    ],
    messages: [],
    jobs: [],
    routines: [],
    skills: [],
    artifacts: [],
    approvals: [],
    providerUsage: {},
  };
}
export class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const folder of ['workspace', 'browser', 'uploads'])
      fs.mkdirSync(path.join(dir, folder), { recursive: true, mode: 0o700 });
    // Never silently replace corrupt user data.
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : initialState();
    if (this.data.version !== 1)
      throw new Error('Unsupported data version. Back up the data folder before upgrading.');
    // Missing fields migrate to Manual; bot overrides remain independent.
    this.data.settings.claudePermissionMode ??= 'manual';
    delete this.data.settings.sudoMode;
    for (const bot of this.data.bots) delete bot.sudoMode;
    // The old per-bot switch becomes the mode, so an owner's off setting survives.
    for (const bot of this.data.bots) {
      if (typeof bot.computerAccess === 'boolean')
        bot.computer ??= bot.computerAccess ? 'vm' : 'none';
      delete bot.computerAccess;
    }
    for (const bot of this.data.bots) bot.provider = providerOf(bot.provider);
    this.data.providerUsage ||= {};
    for (const job of this.data.jobs)
      if (['running', 'waiting'].includes(job.status)) {
        job.status = 'interrupted';
        job.error = 'The server stopped. Review any completed actions before retrying.';
        job.completedAt = now();
      }
    for (const a of this.data.approvals) if (a.status === 'pending') a.status = 'expired';
    this.save();
  }
  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.emit('change');
  }
  message(chatId, role, text, extra = {}) {
    const msg = { id: id(), chatId, role, text, createdAt: now(), ...extra };
    this.data.messages.push(msg);
    const chat = this.data.chats.find(c => c.id === chatId);
    if (chat) {
      chat.updatedAt = now();
      chat.unread = role !== 'user';
    }
    this.save();
    return msg;
  }
  bot(botId) {
    const b = this.data.bots.find(x => x.id === botId);
    if (!b) throw new Error('Bot not found');
    return b;
  }
  chat(chatId) {
    const c = this.data.chats.find(x => x.id === chatId);
    if (!c) throw new Error('Conversation not found');
    return c;
  }
  createBot(input) {
    const bot = {
      id: id(),
      name: required(input.name, 'Name', 60),
      title: String(input.title || '').slice(0, 140),
      instructions: String(input.instructions || '').slice(0, 12000),
      color: ['violet', 'mint', 'amber', 'blue', 'rose', 'orange'].includes(input.color)
        ? input.color
        : 'violet',
      shape: ['round', 'square', 'flower'].includes(input.shape) ? input.shape : 'round',
      memory: [],
      pinned: false,
      hidden: false,
      section: '',
      createdAt: now(),
      ...botModelFields(input),
    };
    bot.scope = input.scope === 'task' ? 'task' : 'persistent';
    if (bot.scope === 'task') bot.taskRootId = required(input.taskRootId, 'Root task ID', 100);
    if (input.managerBotId) {
      this.bot(input.managerBotId);
      bot.managerBotId = input.managerBotId;
    }
    if (input.createdByBotId) {
      this.bot(input.createdByBotId);
      bot.createdByBotId = input.createdByBotId;
    }
    this.data.bots.push(bot);
    const chat = {
      id: id(),
      type: 'direct',
      name: bot.name,
      botIds: [bot.id],
      threadIds: {},
      unread: false,
      createdAt: now(),
    };
    this.data.chats.push(chat);
    this.save();
    return { bot, chat };
  }
  createGroup(input) {
    const botIds = [...new Set(input.botIds || [])];
    if (botIds.length < 2 || botIds.length > 6) throw new Error('Choose 2–6 bots');
    botIds.forEach(b => {
      if (this.bot(b).deletedAt) throw new Error('A deleted bot cannot join a group');
    });
    const chat = {
      id: id(),
      type: 'group',
      name: required(input.name, 'Group name', 80),
      botIds,
      threadIds: {},
      unread: false,
      createdAt: now(),
    };
    chat.scope = input.scope === 'task' ? 'task' : 'persistent';
    if (chat.scope === 'task') chat.taskRootId = required(input.taskRootId, 'Root task ID', 100);
    if (input.managerBotId) {
      this.bot(input.managerBotId);
      chat.managerBotId = input.managerBotId;
    }
    this.data.chats.push(chat);
    this.save();
    return chat;
  }
  updateBot(botId, input) {
    const current = this.bot(botId),
      bot = { ...current };
    if (bot.deletedAt) throw new Error('Restore this bot before editing it');
    Object.assign(bot, botModelFields(input, current));
    if (input.name !== undefined) bot.name = required(input.name, 'Name', 60);
    for (const [key, max] of [
      ['title', 140],
      ['instructions', 12000],
      ['section', 80],
    ])
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'string') throw new Error(`${key} must be text`);
        bot[key] = input[key].slice(0, max);
      }
    if (input.color !== undefined) {
      if (!['violet', 'mint', 'amber', 'blue', 'rose', 'orange'].includes(input.color))
        throw new Error('Unknown color');
      bot.color = input.color;
    }
    if (input.shape !== undefined) {
      if (!['round', 'square', 'flower'].includes(input.shape))
        throw new Error('Unknown avatar shape');
      bot.shape = input.shape;
    }
    for (const key of ['pinned', 'hidden'])
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
        bot[key] = input[key];
      }
    if (input.managerBotId !== undefined) {
      let manager = input.managerBotId || null,
        seen = new Set([bot.id]);
      while (manager) {
        if (seen.has(manager)) throw new Error('A team hierarchy cannot contain a cycle');
        seen.add(manager);
        const parent = this.bot(manager);
        if (parent.deletedAt) throw new Error('A deleted bot cannot manage a team');
        manager = parent.managerBotId;
      }
      bot.managerBotId = input.managerBotId || null;
    }
    const chat = this.data.chats.find(c => c.type === 'direct' && c.botIds[0] === bot.id);
    if (chat) chat.name = bot.name;
    bot.updatedAt = now();
    Object.assign(current, bot);
    this.save();
    return current;
  }
  botTemplate(botId) {
    const bot = this.bot(botId);
    return {
      format: 'stellarcortex-bot-template',
      version: 1,
      bot: {
        name: bot.name,
        title: bot.title,
        instructions: bot.instructions,
        color: bot.color,
        shape: bot.shape,
        provider: providerOf(bot.provider),
        ...modelFields(bot, { defaults: true }),
      },
    };
  }
  updateGroup(groupId, input) {
    const current = this.chat(groupId),
      chat = { ...current };
    if (chat.type !== 'group') throw new Error('Not a group conversation');
    if (input.name !== undefined) chat.name = required(input.name, 'Group name', 80);
    if (input.botIds !== undefined) {
      const members = [...new Set(input.botIds)];
      if (members.length < 2 || members.length > 6) throw new Error('Choose 2–6 bots');
      members.forEach(b => {
        if (this.bot(b).deletedAt) throw new Error('A deleted bot cannot join a group');
      });
      chat.botIds = members;
    }
    if (input.managerBotId !== undefined) {
      if (input.managerBotId) this.bot(input.managerBotId);
      chat.managerBotId = input.managerBotId || null;
    }
    chat.updatedAt = now();
    Object.assign(current, chat);
    this.save();
    return current;
  }
  deleteBot(botId) {
    const bot = this.bot(botId);
    if (bot.deletedAt) return bot;
    bot.hiddenBeforeDelete = bot.hidden;
    bot.deletedAt = now();
    bot.hidden = true;
    for (const r of this.data.routines) if (r.botId === botId) r.enabled = false;
    this.save();
    return bot;
  }
  restoreBot(botId) {
    const bot = this.bot(botId);
    if (!bot.deletedAt) return bot;
    bot.hidden = Boolean(bot.hiddenBeforeDelete);
    delete bot.hiddenBeforeDelete;
    delete bot.deletedAt;
    this.save();
    return bot;
  }
  createRoutine(input) {
    const bot = this.bot(input.botId);
    const kind = input.kind || 'interval';
    if (!['interval', 'daily', 'webhook'].includes(kind)) throw new Error('Unknown schedule type');
    const minutes = Number(input.minutes || 60);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 525600)
      throw new Error('Interval must be 5–525600 minutes');
    const time = input.time || '09:00',
      timezone = input.timezone || this.data.settings.timezone;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Use HH:MM time');
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
    const r = {
      id: id(),
      botId: bot.id,
      chatId: this.data.chats.find(c => c.type === 'direct' && c.botIds[0] === bot.id).id,
      name: required(input.name, 'Routine name', 100),
      prompt: required(input.prompt, 'Instruction'),
      kind,
      minutes,
      time,
      timezone,
      enabled: input.enabled !== false,
      nextRun: kind === 'interval' ? new Date(Date.now() + minutes * 60000).toISOString() : null,
      lastDate: null,
      createdAt: now(),
    };
    this.data.routines.push(r);
    this.save();
    return r;
  }
}
export function due(r, date = new Date()) {
  if (!r.enabled || r.kind === 'webhook') return false;
  if (r.kind === 'interval') return date.getTime() >= Date.parse(r.nextRun);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: r.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(p => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return `${parts.hour}:${parts.minute}` >= r.time && day !== r.lastDate;
}
export function markRun(r, date = new Date()) {
  r.lastRun = date.toISOString();
  r.nextRun =
    r.kind === 'interval' ? new Date(date.getTime() + r.minutes * 60000).toISOString() : null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: r.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map(p => [p.type, p.value]),
  );
  r.lastDate = `${parts.year}-${parts.month}-${parts.day}`;
}
export function safeFile(root, relative, mustExist = true) {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error('Path is outside the workspace');
  // Resolve every existing ancestor, including junctions and symlinks.
  let cursor = target;
  // existsSync follows links and treats a dangling link as absent. Do not skip
  // such a link: a subsequent write could otherwise create its target outside.
  while (true) {
    try {
      fs.lstatSync(cursor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const p = path.dirname(cursor);
    if (p === cursor) throw new Error('Invalid path');
    cursor = p;
  }
  const realRoot = fs.realpathSync(root),
    realRel = path.relative(realRoot, fs.realpathSync(cursor));
  if (realRel.startsWith('..') || path.isAbsolute(realRel))
    throw new Error('Symlink leaves the workspace');
  if (mustExist && !fs.statSync(target).isFile()) throw new Error('Not a file');
  return target;
}
