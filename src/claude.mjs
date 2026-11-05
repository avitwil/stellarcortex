import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeBridge } from './claude-mcp.mjs';
import { logProcessOutput } from './process-output.mjs';
import {
  claudeExternalHook,
  claudePermissionArgs,
  CLAUDE_PERMISSION_MODES,
} from './claude-permissions.mjs';
import { recognizedElevation } from './elevation-policy.mjs';
import {
  parseClaudeUsage,
  mergeClaudeRateLimitEvent,
  claudeUsageSnapshot,
  emptyClaudeUsage,
} from './claude-usage.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export function claudePackageCommand(folder) {
  const base = path.resolve(folder);
  let declared;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    declared = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
  } catch {}
  // Official native packages can retain the .exe name on Linux. Resolve their
  // declared entry point instead of assuming a filename from the host OS.
  for (const relative of [declared, 'bin/claude', 'bin/claude.exe', 'cli.js']) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) continue;
    const binary = path.resolve(base, relative),
      inside = path.relative(base, binary);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
      continue;
    try {
      if (!fs.statSync(binary).isFile()) continue;
    } catch {
      continue;
    }
    return /\.(?:c|m)?js$/i.test(binary)
      ? { bin: process.execPath, prefix: [binary] }
      : { bin: binary, prefix: [] };
  }
  return null;
}
export function claudeCommand() {
  if (process.env.CLAUDE_BIN) return { bin: process.env.CLAUDE_BIN, prefix: [] };
  const packageRoots = [
    path.join(root, 'node_modules', '@anthropic-ai', 'claude-code'),
    ...(process.env.APPDATA
      ? [path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code')]
      : []),
  ];
  for (const folder of packageRoots) {
    const command = claudePackageCommand(folder);
    if (command) return command;
  }
  const native = path.join(
    os.homedir(),
    '.local',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  return {
    bin: fs.existsSync(native) ? native : process.platform === 'win32' ? 'claude.exe' : 'claude',
    prefix: [],
  };
}
export function claudeModels() {
  // Exact IDs and lifecycle status verified 2026-10-26 against the official
  // model overview/deprecations pages; effort support follows Claude Code's
  // model-config documentation. This is not an account entitlement enumeration.
  // Fable is intentionally absent: print mode may charge usage credits for it.
  const versions = [
    ['claude-opus-5-5', 'opus', '5.5', efforts],
    ['claude-sonnet-5-5', 'sonnet', '5.5', efforts],
    ['claude-haiku-5-5', 'haiku', '5.5', efforts],
    ['claude-opus-5', 'opus', '5', efforts],
    ['claude-sonnet-5', 'sonnet', '5', efforts],
    ['claude-opus-4-8', 'opus', '4.8', efforts],
    ['claude-opus-4-7', 'opus', '4.7', efforts],
    ['claude-opus-4-6', 'opus', '4.6', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-4-6', 'sonnet', '4.6', ['low', 'medium', 'high', 'max']],
    ['claude-opus-4-5-20251101', 'opus', '4.5', []],
    ['claude-haiku-4-5-20251001', 'haiku', '4.5', []],
  ];
  const title = family => family[0].toUpperCase() + family.slice(1);
  const entry = (model, displayName, levels, extra = {}) => ({
    id: model,
    model,
    displayName,
    description:
      extra.selectionKind === 'version'
        ? 'Pinned Claude model version. Access and effective effort depend on your subscription and organization; Claude Code checks them when starting.'
        : 'Official Claude Code alias; the selected version may change. Access and effective effort depend on your subscription and organization.',
    isDefault: model === 'default',
    availability: 'unverified',
    catalogSource: 'official-documentation',
    catalogUpdatedAt: '2026-10-26',
    supportedReasoningEfforts: levels.map(reasoningEffort => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: null,
    serviceTiers: [],
    defaultServiceTier: 'default',
    ...extra,
  });
  return [
    entry('default', 'Claude · account default', [], { selectionKind: 'default' }),
    ...versions.map(([model, family, version, levels]) =>
      entry(model, `Claude ${title(family)} ${version}`, levels, {
        selectionKind: 'version',
        family,
        version,
      }),
    ),
    ...['opus', 'sonnet', 'haiku'].map(family =>
      entry(family, `Claude ${title(family)}`, efforts, { selectionKind: 'alias', family }),
    ),
  ];
}
export function claudeModelsFromInitialization(models) {
  if (!Array.isArray(models)) throw new Error('Claude Code did not return a model catalog');
  const pinned = new Map(),
    aliases = [],
    observedAt = new Date().toISOString();
  let defaultEntry;
  for (const raw of models) {
    if (!raw || typeof raw.value !== 'string' || typeof raw.resolvedModel !== 'string') continue;
    // Restrict this subscription integration to the documented included model
    // families; Fable can automatically draw separately billed usage credits.
    const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(
      raw.resolvedModel,
    );
    if (
      !match ||
      !/^(?:default|opus|sonnet|haiku|claude-(?:opus|sonnet|haiku)-[a-z0-9-]+)$/.test(raw.value)
    )
      continue;
    const [, family, major, minor] = match,
      version = minor ? `${major}.${minor}` : major,
      title = family[0].toUpperCase() + family.slice(1);
    const levels =
      raw.supportsEffort && Array.isArray(raw.supportedEffortLevels)
        ? [...new Set(raw.supportedEffortLevels.filter(level => efforts.includes(level)))]
        : [];
    const shared = {
      description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : '',
      availability: 'cli-listed',
      catalogSource: 'claude-code',
      catalogUpdatedAt: observedAt,
      resolvedModel: raw.resolvedModel,
      family,
      version,
      supportedReasoningEfforts: levels.map(reasoningEffort => ({
        reasoningEffort,
        description: reasoningEffort,
      })),
      defaultReasoningEffort: null,
      serviceTiers: [],
      defaultServiceTier: 'default',
    };
    pinned.set(raw.resolvedModel, {
      ...shared,
      id: raw.resolvedModel,
      model: raw.resolvedModel,
      displayName: `Claude ${title} ${version}`,
      isDefault: false,
      selectionKind: 'version',
    });
    if (raw.value === 'default')
      defaultEntry = {
        ...shared,
        id: 'default',
        model: 'default',
        displayName: 'Claude · account default',
        isDefault: true,
        selectionKind: 'default',
      };
    else if (['opus', 'sonnet', 'haiku'].includes(raw.value))
      aliases.push({
        ...shared,
        id: raw.value,
        model: raw.value,
        displayName: `Claude ${title}`,
        isDefault: false,
        selectionKind: 'alias',
      });
  }
  if (!pinned.size)
    throw new Error('Claude Code did not list supported subscription model families');
  // If the account default resolves to a credits-only family, do not silently
  // restore an unchecked `default` choice. The user must pick an included model.
  return [...(defaultEntry ? [defaultEntry] : []), ...pinned.values(), ...aliases];
}
// Claude runs its shells in their own process groups, and they lose their parent once it exits, so read the tree before any signal.
export function descendantPids(root, proc = '/proc') {
  const children = new Map();
  let ids;
  try {
    ids = fs.readdirSync(proc);
  } catch {
    return [];
  }
  for (const id of ids.filter(id => /^\d+$/.test(id))) {
    try {
      const stat = fs.readFileSync(path.join(proc, id, 'stat'), 'latin1'),
        parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(parent, [...(children.get(parent) || []), Number(id)]);
    } catch {}
  }
  const found = new Set();
  for (const pids = [root]; pids.length;)
    for (const pid of children.get(pids.pop()) || [])
      if (pid !== root && !found.has(pid)) {
        found.add(pid);
        pids.push(pid);
      }
  return [...found];
}
const processStart = (pid, proc) => {
  try {
    const stat = fs.readFileSync(path.join(proc, String(pid), 'stat'), 'latin1');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
};
export class Claude extends EventEmitter {
  constructor({
    command,
    spawnProcess = spawn,
    environment = process.env,
    procDir = '/proc',
  } = {}) {
    super();
    this.command = command;
    this.spawnProcess = spawnProcess;
    this.environment = environment;
    this.procDir = procDir;
    this.ready = false;
    this.installed = false;
    this.version = null;
    this.starting = null;
    this.threads = new Map();
    this.turns = new Map();
    this.pending = new Map();
    this.seq = 0;
    this.accountIdentity = null;
    this.accountChecked = false;
    this.usageSeed = null;
    this.usage = null;
    this.usageFetchedAt = 0;
    this.usageError = null;
    this.usagePending = null;
  }
  hydrateUsage(seed) {
    if (
      !this.accountChecked &&
      seed?.source === 'claude-code' &&
      typeof seed.accountKey === 'string' &&
      /^[a-f0-9]{64}$/.test(seed.accountKey)
    )
      this.usageSeed = claudeUsageSnapshot(seed);
  }
  child(args, options = {}) {
    const command = this.command || claudeCommand();
    return this.spawnProcess(command.bin, [...command.prefix, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.environment,
      ...options,
    });
  }
  async capture(args, { timeout = 15000, allowFailure = false, input = '' } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.child(args);
      let stdout = '',
        stderr = '',
        settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Claude Code ${args[0]} timed out`));
      }, timeout);
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.stdout.on('data', d => {
        stdout += d.toString();
        if (stdout.length > 1024 * 1024) {
          child.kill();
          finish(new Error('Claude Code status exceeded output limit'));
        }
      });
      child.stderr.on('data', d => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      child.once('error', e =>
        finish(
          new Error(
            `Cannot start Claude Code. Install it on the StellarCortex server and run its sign-in command. ${e.code || e.message}`,
          ),
        ),
      );
      child.once('close', (code, signal) => {
        const failed = code !== 0 && !allowFailure;
        // Sign-in commands can print a login code, so their output is never logged.
        if (failed && args[0] !== 'auth')
          logProcessOutput('Claude Code', stderr, signal && 'signal ' + signal);
        finish(
          failed
            ? new Error(
                `Claude Code ${args[0]} failed (${code ?? signal}). Details are in the server log.`,
              )
            : null,
          { stdout, stderr, code },
        );
      });
    });
  }
  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const result = await this.capture(['--version']);
      const version = result.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
      this.installed = true;
      this.version = version?.[0] || result.stdout.trim().slice(0, 80);
      if (
        !version ||
        Number(version[1]) < 2 ||
        (Number(version[1]) === 2 &&
          (Number(version[2]) < 1 || (Number(version[2]) === 1 && Number(version[3]) < 280)))
      )
        throw new Error('Update Claude Code to 2.1.280 or newer before using StellarCortex.');
      this.ready = true;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async account() {
    await this.start();
    const { stdout } = await this.capture(['auth', 'status'], { allowFailure: true });
    let status;
    try {
      status = JSON.parse(stdout);
    } catch {
      throw new Error(
        'Claude Code returned an invalid authentication status. Run its sign-in command on the server.',
      );
    }
    const subscription =
      status.loggedIn === true &&
      status.authMethod === 'claude.ai' &&
      (!status.apiProvider || status.apiProvider === 'firstParty');
    const identity = subscription
      ? createHash('sha256')
          .update(
            JSON.stringify([
              status.email || null,
              status.orgId || null,
              status.subscriptionType || null,
            ]),
          )
          .digest('hex')
      : null;
    if (!this.accountChecked || identity !== this.accountIdentity) {
      const seed =
        !this.accountChecked && identity && this.usageSeed?.accountKey === identity
          ? this.usageSeed
          : null;
      this.accountChecked = true;
      this.accountIdentity = identity;
      this.usageSeed = null;
      this.usage = seed
        ? claudeUsageSnapshot(seed)
        : { ...emptyClaudeUsage(), accountKey: identity, reset: true };
      this.usageFetchedAt = 0;
      this.usageError = null;
      this.notify('account/rateLimits/updated', { usage: this.usage });
    }
    return {
      account: subscription
        ? {
            type: 'claude',
            email: typeof status.email === 'string' ? status.email : null,
            planType: typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
          }
        : null,
      authMethod: typeof status.authMethod === 'string' ? status.authMethod : 'none',
      requiresOpenaiAuth: false,
      error: subscription
        ? null
        : status.loggedIn
          ? 'Claude Code is using API or provider credentials. StellarCortex requires your own Claude subscription login; API billing will not be used.'
          : 'Sign in to Claude Code on the StellarCortex server using your own Claude subscription.',
    };
  }
  async readUsage({ force = false } = {}) {
    let account;
    try {
      account = await this.account();
    } catch (error) {
      return claudeUsageSnapshot(this.usage, { error: error.message });
    }
    if (!account.account)
      return { ...emptyClaudeUsage(account.error), accountKey: null, reset: true };
    if (!force && this.usageFetchedAt && Date.now() - this.usageFetchedAt < 60000)
      return claudeUsageSnapshot(this.usage, { error: this.usageError });
    if (this.usagePending) return this.usagePending;
    const identity = this.accountIdentity;
    this.usagePending = (async () => {
      try {
        const response = await this.capture(
          [
            '-p',
            '/usage',
            '--output-format',
            'json',
            '--restricted',
            '--tools',
            '',
            '--strict-mcp-config',
            '--mcp-config',
            JSON.stringify({ mcpServers: {} }),
            '--no-session-persistence',
            '--settings',
            JSON.stringify({ fastMode: false }),
          ],
          { allowFailure: true },
        );
        const parsed = parseClaudeUsage(response.stdout),
          usage = { ...parsed, accountKey: identity, reset: !!parsed.emptyMeters };
        if (!usage.available && !usage.emptyMeters)
          throw new Error(usage.error || 'Claude Code did not report subscription usage');
        if (identity !== this.accountIdentity)
          return emptyClaudeUsage('The Claude account changed. Refresh its usage again.');
        this.usage = usage;
        this.usageError = null;
        this.notify('account/rateLimits/updated', { usage });
        return usage;
      } catch (error) {
        if (identity !== this.accountIdentity)
          return emptyClaudeUsage('The Claude account changed. Refresh its usage again.');
        this.usageError = error.message;
        return claudeUsageSnapshot(this.usage, { error: error.message });
      } finally {
        if (identity === this.accountIdentity) this.usageFetchedAt = Date.now();
        this.usagePending = null;
      }
    })();
    return this.usagePending;
  }
  async discoverModels() {
    if (this.modelDiscovery) return this.modelDiscovery;
    this.modelDiscovery = (async () => {
      try {
        await this.start();
        const requestId = randomUUID();
        const result = await this.capture(
          [
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--restricted',
            '--tools',
            '',
            '--strict-mcp-config',
            '--mcp-config',
            JSON.stringify({ mcpServers: {} }),
            '--no-session-persistence',
          ],
          {
            allowFailure: true,
            input:
              JSON.stringify({
                type: 'control_request',
                request_id: requestId,
                request: { subtype: 'initialize', hooks: null },
              }) + '\n',
          },
        );
        const response = result.stdout
          .split('\n')
          .flatMap(line => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .find(
            message =>
              message.type === 'control_response' && message.response?.request_id === requestId,
          );
        if (response?.response?.subtype !== 'success')
          throw new Error('Claude Code model discovery is unavailable');
        this.lastCatalogError = null;
        return claudeModelsFromInitialization(response.response.response?.models);
      } catch (error) {
        this.lastCatalogError = error.message;
        return claudeModels();
      }
    })().finally(() => {
      this.modelDiscovery = null;
    });
    return this.modelDiscovery;
  }
  async request(method, params = {}) {
    if (method === 'account/read') {
      // Starting the CLI to ask costs seconds. A turn uses the last good answer, and a new one is read behind it.
      const old = this.accountRead;
      if (params.cached && old?.value.account) {
        if (Date.now() - old.at > 60000)
          this.account().then(
            value => {
              this.accountRead = { value, at: Date.now() };
            },
            () => {},
          );
        return old.value;
      }
      const value = await this.account();
      this.accountRead = { value, at: Date.now() };
      return value;
    }
    if (method === 'model/list') return { data: await this.discoverModels(), nextCursor: null };
    if (method === 'config/read') return { config: { model: 'default' } };
    if (method === 'thread/start' || method === 'thread/resume') {
      const threadId = params.threadId || randomUUID();
      if (!uuid.test(threadId)) throw new Error('Invalid Claude session ID');
      if (this.turns.has(threadId)) throw new Error('This Claude session is already running');
      const old = this.threads.get(threadId);
      this.threads.set(threadId, {
        ...old,
        ...params,
        id: threadId,
        resume: old ? old.resume : method === 'thread/resume',
        dynamicTools: params.dynamicTools || old?.dynamicTools || [],
      });
      return {
        thread: { id: threadId },
        model: params.model || 'default',
        reasoningEffort: null,
        serviceTier: 'default',
      };
    }
    if (method === 'turn/start') {
      await this.start();
      const thread = this.threads.get(params.threadId);
      if (!thread) throw new Error('Claude session is not initialized');
      if (this.turns.has(thread.id)) throw new Error('This Claude session is already running');
      if (params.serviceTier && params.serviceTier !== 'default')
        throw new Error('Claude subscription mode currently supports Standard speed only.');
      const effort = params.effort || thread.config?.model_reasoning_effort || null;
      if (effort && !efforts.includes(effort))
        throw new Error('Unsupported Claude reasoning effort');
      const turn = {
        id: randomUUID(),
        threadId: thread.id,
        cancelled: false,
        closed: false,
        items: new Map(),
        messages: new Set(),
        nativeTools: new Map(),
        params: { ...params, effort },
      };
      this.turns.set(thread.id, turn);
      // Always return the turn ID before forwarding a completion or permission event.
      setImmediate(() =>
        this.run(thread, turn).catch(error => this.finish(turn, 'failed', error.message)),
      );
      return { turn: { id: turn.id } };
    }
    if (method === 'turn/interrupt') {
      const turn = this.turns.get(params.threadId);
      if (turn && (!params.turnId || params.turnId === turn.id)) {
        turn.cancelled = true;
        await this.kill(turn);
        await this.finish(turn, 'interrupted');
      }
      return {};
    }
    if (method === 'account/rateLimits/read')
      return this.readUsage({ force: params.force === true || params.refresh === true });
    throw new Error(`Claude Code does not support ${method}`);
  }
  // The engine awaits this before returning external content to the model.
  blockNativeActions(threadId) {
    const thread = this.threads.get(threadId);
    if (thread) thread.blockActions = true;
    const flag = this.turns.get(threadId)?.externalFlag;
    if (flag) fs.writeFileSync(flag, '1', { mode: 0o600 });
  }
  notify(method, params) {
    this.emit('notification', { method, params });
  }
  ask(turn, method, params) {
    if (turn.closed || turn.cancelled) return Promise.reject(new Error('Claude turn stopped'));
    return new Promise((resolve, reject) => {
      const id = `claude-${++this.seq}`,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Claude approval or tool request timed out'));
        }, 610000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, turn });
      this.emit('request', {
        id,
        method,
        params: { threadId: turn.threadId, turnId: turn.id, ...params },
      });
    });
  }
  respond(id, result) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result);
  }
  reject(id, message) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error(message));
  }
  async run(thread, turn) {
    const permissionArgs = claudePermissionArgs(thread.claudePermissionMode || 'manual', {
      blockActions: !!thread.blockActions,
    });
    if (thread.executionBoundary) {
      const at = permissionArgs.indexOf('--settings') + 1;
      permissionArgs[at] = JSON.stringify({
        ...JSON.parse(permissionArgs[at]),
        disableAllHooks: true,
      });
    }
    const auth = await this.account();
    if (!auth.account) throw new Error(auth.error);
    if (turn.cancelled) return this.finish(turn, 'interrupted');
    const bridge = await createClaudeBridge({
      tools: thread.dynamicTools,
      call: async (tool, args) => {
        const itemId = randomUUID();
        this.notify('item/started', {
          threadId: thread.id,
          item: { type: 'dynamicToolCall', id: itemId, tool },
        });
        const result = await this.ask(turn, 'item/tool/call', {
          callId: itemId,
          tool,
          arguments: args,
        });
        this.notify('item/completed', {
          threadId: thread.id,
          item: {
            type: 'dynamicToolCall',
            id: itemId,
            tool,
            status: result.success ? 'completed' : 'failed',
          },
        });
        return result;
      },
      approve: async ({ tool_name, input, tool_use_id }) => {
        if (thread.executionBoundary)
          return {
            allow: false,
            message:
              'Native host tools are disabled for guest execution. Use the approved StellarCortex guest tools.',
          };
        if (thread.blockActions)
          return {
            allow: false,
            message:
              'This task read external content, so shell commands and file changes are blocked. There is no approval path.',
          };
        if (recognizedElevation(input.command || ''))
          return {
            allow: false,
            message:
              'OS elevation is not permitted. Do not retry it through another tool, script or bot.',
          };
        const method = ['Write', 'Edit', 'NotebookEdit'].includes(tool_name)
          ? 'item/fileChange/requestApproval'
          : 'item/commandExecution/requestApproval';
        const result = await this.ask(turn, method, {
          tool: tool_name,
          command: input.command || null,
          input,
          itemId: tool_use_id || randomUUID(),
          reason: 'Claude Code requests your permission for this native action.',
        });
        return ['accept', 'acceptForSession'].includes(result.decision);
      },
    });
    turn.bridge = bridge;
    if (turn.cancelled || turn.closed) {
      await bridge.close();
      return this.finish(turn, 'interrupted');
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-claude-'));
    turn.temp = temp;
    const promptFile = path.join(temp, 'instructions.txt');
    fs.writeFileSync(promptFile, thread.developerInstructions || '', { mode: 0o600 });
    turn.externalFlag = path.join(temp, 'external-content');
    if (!thread.executionBoundary) {
      const at = permissionArgs.indexOf('--settings') + 1;
      permissionArgs[at] = JSON.stringify({
        ...JSON.parse(permissionArgs[at]),
        hooks: claudeExternalHook(turn.externalFlag),
      });
    }
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--restricted',
      ...permissionArgs,
      '--permission-prompts',
      'host',
      '--permission-prompt-tool',
      bridge.permissionTool,
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify(bridge.config),
      '--tools',
      thread.executionBoundary || thread.blockActions ? '' : 'Read,Write,Edit,Bash,Glob,Grep',
      '--allowedTools',
      bridge.permissionTool,
      ...thread.dynamicTools.map(t => `mcp__stellarcortex__${t.name}`),
      '--disable-slash-commands',
      '--append-system-prompt-file',
      promptFile,
      '--system-prompt-snapshot',
      'off',
      '--model',
      turn.params.model || thread.model || 'default',
    ];
    if (turn.params.effort) args.push('--effort', turn.params.effort);
    args.push(thread.resume ? '--resume' : '--session-id', thread.id);
    const env = { ...this.environment };
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    const child = this.child(args, {
      cwd: thread.cwd,
      detached: process.platform !== 'win32',
      env,
    });
    turn.child = child;
    turn.stderr = '';
    this.notify('turn/started', { threadId: thread.id, turn: { id: turn.id } });
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => {
      turn.stderr = (turn.stderr + data.toString()).slice(-3000);
    });
    child.once('error', error =>
      this.finish(turn, 'failed', `Cannot run Claude Code: ${error.code || error.message}`),
    );
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.length > 8 * 1024 * 1024) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.handle(thread, turn, message);
    });
    child.once('close', (code, signal) => {
      if ((code || signal) && !turn.cancelled)
        logProcessOutput('Claude Code', turn.stderr, signal && 'signal ' + signal);
      thread.resume = turn.initialized || thread.resume;
      this.finish(
        turn,
        turn.cancelled
          ? 'interrupted'
          : turn.result?.is_error || code !== 0
            ? 'failed'
            : 'completed',
        turn.cancelled
          ? null
          : turn.result?.is_error
            ? (turn.result.errors || [turn.result.result || 'Claude Code task failed']).join('\n')
            : code !== 0
              ? `Claude Code exited (${code ?? signal}). Details are in the server log.`
              : !turn.result
                ? 'Claude Code ended without a completion result'
                : null,
      );
    });
    const content = (turn.params.input || [])
      .filter(item => item.type === 'text')
      .map(item => ({ type: 'text', text: item.text }));
    child.stdin.end(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        session_id: thread.id,
        parent_tool_use_id: null,
      }) + '\n',
    );
  }
  textState(turn, messageId) {
    turn.textStates ??= new Map();
    if (!turn.textStates.has(messageId))
      turn.textStates.set(messageId, { byIndex: new Map(), items: [] });
    return turn.textStates.get(messageId);
  }
  textItem(turn, messageId, ordinal) {
    const state = this.textState(turn, messageId);
    state.items[ordinal] ??= { id: `${messageId}:text:${ordinal}`, text: '' };
    return state.items[ordinal];
  }
  finishText(thread, turn, item) {
    if (!turn.messages.has(item.id) || item.emittedText !== item.text) {
      this.notify('item/completed', {
        threadId: thread.id,
        turnId: turn.id,
        item: { id: item.id, type: 'agentMessage', text: item.text },
      });
      turn.messages.add(item.id);
      item.emittedText = item.text;
    }
    item.finalized = true;
  }
  handle(thread, turn, message) {
    if (turn.closed) return;
    const quota =
      message.type === 'assistant' && message.usage_report
        ? parseClaudeUsage(message)
        : mergeClaudeRateLimitEvent(this.usage, message);
    if (quota?.available || quota?.emptyMeters) {
      this.usage = { ...quota, accountKey: this.accountIdentity, reset: !!quota.emptyMeters };
      this.usageError = null;
      this.notify('account/rateLimits/updated', { usage: this.usage });
    }
    if (message.type === 'system' && message.subtype === 'init') {
      const expected = CLAUDE_PERMISSION_MODES[thread.claudePermissionMode || 'manual'];
      if (
        message.permissionMode &&
        message.permissionMode !== expected &&
        !(expected === 'default' && message.permissionMode === 'manual')
      ) {
        void this.finish(
          turn,
          'failed',
          `Claude Code did not activate the requested permission mode (${expected}); reported ${message.permissionMode}. Choose a supported mode in Settings. No automatic retry was attempted.`,
        );
        return;
      }
      turn.initialized = true;
      this.notify('thread/settingsUpdated', {
        threadId: thread.id,
        model: message.model || null,
        reasoningEffort: null,
        serviceTier: 'default',
      });
      return;
    }
    if (message.parent_tool_use_id) return;
    if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') {
        turn.messageId = event.message?.id || randomUUID();
        turn.items.clear();
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        const state = this.textState(turn, turn.messageId || turn.id);
        let item = state.byIndex.get(event.index);
        if (!item) {
          item = this.textItem(turn, turn.messageId || turn.id, state.items.length);
          item.text = event.content_block.text || '';
          state.byIndex.set(event.index, item);
        }
        turn.items.set(event.index, item);
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const state = this.textState(turn, turn.messageId || turn.id);
        let item = state.byIndex.get(event.index);
        if (!item) {
          item = this.textItem(turn, turn.messageId || turn.id, state.items.length);
          state.byIndex.set(event.index, item);
        }
        if (item.finalized) return;
        turn.items.set(event.index, item);
        item.text += event.delta.text;
        this.notify('item/agentMessage/delta', {
          threadId: thread.id,
          turnId: turn.id,
          itemId: item.id,
          delta: event.delta.text,
        });
      }
      if (event.type === 'content_block_stop') {
        const item = turn.items.get(event.index);
        if (item) {
          this.finishText(thread, turn, item);
          turn.items.delete(event.index);
        }
      }
    }
    if (message.type === 'assistant') {
      let textOrdinal = 0;
      for (const [index, block] of (message.message?.content || []).entries()) {
        if (block.type === 'text') {
          const item = this.textItem(
            turn,
            message.message?.id || turn.messageId || turn.id,
            textOrdinal++,
          );
          item.text = block.text;
          this.finishText(thread, turn, item);
        } else if (block.type === 'tool_use' && !block.name.startsWith('mcp__stellarcortex__')) {
          turn.nativeTools.set(block.id, block);
          this.notify('item/started', {
            threadId: thread.id,
            item: {
              id: block.id,
              type: block.name === 'Bash' ? 'commandExecution' : 'mcpToolCall',
              tool: block.name,
            },
          });
        }
      }
    }
    if (message.type === 'user')
      for (const block of message.message?.content || []) {
        if (block.type === 'tool_result') {
          const native = turn.nativeTools.get(block.tool_use_id);
          if (native) {
            this.notify('item/completed', {
              threadId: thread.id,
              item: {
                id: native.id,
                type: native.name === 'Bash' ? 'commandExecution' : 'mcpToolCall',
                tool: native.name,
                command: native.input?.command,
                status: block.is_error ? 'failed' : 'completed',
              },
            });
            turn.nativeTools.delete(native.id);
          }
        }
      }
    if (message.type === 'result') {
      turn.result = message;
      if (!turn.messages.size && typeof message.result === 'string' && message.result)
        this.notify('item/completed', {
          threadId: thread.id,
          item: { id: `${turn.id}:result`, type: 'agentMessage', text: message.result },
        });
    }
  }
  async kill(turn) {
    const child = turn.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const windows = process.platform === 'win32',
      tree = windows ? [] : descendantPids(child.pid, this.procDir),
      starts = new Map([child.pid, ...tree].map(pid => [pid, processStart(pid, this.procDir)]));
    const reused = pid => {
      const start = processStart(pid, this.procDir);
      return start !== null && start !== starts.get(pid);
    };
    const signal = name => {
      if (!reused(child.pid))
        try {
          process.kill(-child.pid, name);
        } catch {
          child.kill(name);
        }
      for (const pid of tree)
        if (!reused(pid))
          try {
            process.kill(pid, name);
          } catch {}
    };
    await new Promise(resolve => {
      let finished = false,
        timer;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (!windows) signal('SIGKILL');
        resolve();
      };
      child.once('close', done);
      if (windows) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => {
          child.kill();
          done();
        });
        killer.once('close', done);
      } else signal('SIGTERM');
      timer = setTimeout(() => {
        if (windows && child.exitCode === null) child.kill('SIGKILL');
        done();
      }, 2000);
      timer.unref();
    });
  }
  async finish(turn, status, error = null) {
    if (turn.closed) return;
    turn.closed = true;
    for (const [id, pending] of this.pending)
      if (pending.turn === turn) this.reject(id, 'Claude turn stopped');
    await this.kill(turn);
    await turn.bridge?.close();
    if (turn.temp) {
      const tempRoot = path.resolve(os.tmpdir()),
        target = path.resolve(turn.temp);
      if (
        path.dirname(target) !== tempRoot ||
        !path.basename(target).startsWith('stellarcortex-claude-')
      )
        throw new Error('Invalid Claude temporary directory');
      fs.rmSync(target, { recursive: true, force: true });
    }
    this.turns.delete(turn.threadId);
    this.notify('turn/completed', {
      threadId: turn.threadId,
      turn: {
        id: turn.id,
        status: error && status === 'completed' ? 'failed' : status,
        error: error ? { message: error } : null,
      },
    });
  }
  async stop() {
    this.ready = false;
    await Promise.all(
      [...this.turns.values()].map(async turn => {
        turn.cancelled = true;
        await this.kill(turn);
        await this.finish(turn, 'interrupted');
      }),
    );
  }
}
