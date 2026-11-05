import { validateDesktopRegistrations } from './desktop-session-registration.mjs';
import {
  environmentComputerPolicy,
  botComputerAccess,
  registeredBotSession,
} from './environment-computer.mjs';
import { randomUUID } from 'node:crypto';
import { desktopScope, scopeKey, DesktopSessionCoordinator } from './desktop-provider-session.mjs';
import { DesktopProviderLifecycle } from './desktop-provider-lifecycle.mjs';
import { DesktopTeachingDrafts } from './desktop-provider-teaching.mjs';
import { redactDesktopFrame } from './desktop-frame-redaction.mjs';
import { saveDemonstration, saveReviewedFrame } from './computer-demonstration.mjs';
import { passiveGuestMethod } from './desktop-guest-channel.mjs';
const STAGE_TEXT = {
  download: 'downloading Ubuntu',
  prepare: 'preparing the installation',
  install: 'installing Ubuntu',
  'first-boot': 'finishing its first start',
};
// For the model, which tells the owner in their own language. The UI has its own text in computer-status.js.
export function computerStatusText(setup) {
  if (setup.state === 'building')
    return (
      'The virtual computer is being built: ' +
      (STAGE_TEXT[setup.stage] || setup.stage) +
      ', step ' +
      setup.step +
      ' of ' +
      setup.steps +
      (setup.percent == null ? '' : ', ' + setup.percent + '%') +
      '.'
    );
  if (setup.state === 'failed')
    return 'Building the virtual computer stopped. The owner can press Retry in Settings > Computer.';
  if (setup.state === 'unreachable') return 'The computer service is not answering.';
  if (setup.state === 'session-limit')
    return 'This bot has no desktop: the computer has no room for another one. The chat works as usual, and the bot gets a desktop when another bot is deleted.';
  return setup.message || 'The computer is not ready yet (' + setup.state + ').';
}
// A computer that is off fails each session unit, so a bot waits this long between tries.
export const SESSION_RETRY_MS = 120000;
// Explicitly constructed by deployment; importing this module never enables a VM.
export class DesktopProviderRuntime {
  constructor({
    records,
    broker,
    enabled = false,
    approved = false,
    redact = redactDesktopFrame,
    loadRecords = null,
    environmentPolicy = null,
  }) {
    this.environmentPolicy = environmentPolicy
      ? environmentComputerPolicy(environmentPolicy)
      : null;
    this.loadRecords = loadRecords;
    this.enabled = enabled === true;
    this.broker = broker;
    this.redact = redact;
    this.records = new Map();
    this.activeRequests = new Map();
    this.sessionAsked = new Map();
    this.sessionsGone = new Set();
    for (const input of validateDesktopRegistrations(records)) {
      const scope = desktopScope(input),
        key = scope.accountId + '\0' + scope.botId;
      if (this.records.has(key)) throw Error('Duplicate desktop identity');
      this.records.set(key, { ...input, ...scope, state: 'unknown' });
    }
    this.registry = { get: (account, bot) => this.records.get(account + '\0' + bot) };
    this.coordinator = new DesktopSessionCoordinator({
      onClaim: async scope => {
        for (const [id, pending] of this.activeRequests)
          if (
            scopeKey(pending.scope) === scopeKey(scope) &&
            ['shell.run', 'desktop.type'].includes(pending.method)
          )
            await this.cancel(scope, id);
      },
      onRelease: async scope => this.onHandBack?.(scope.botId),
      releaseInputs: scope => broker.release({ scope, requestId: randomUUID() }),
    });
    this.lifecycle = new DesktopProviderLifecycle({ broker, registry: this.registry, approved });
  }
  reload() {
    if (!this.loadRecords) return;
    const current = new Set();
    for (const input of validateDesktopRegistrations(this.loadRecords())) {
      const scope = desktopScope(input),
        key = scope.accountId + '\0' + scope.botId,
        old = this.records.get(key);
      if (old && scopeKey(old) !== scopeKey(scope))
        throw Error('Computer identity changed; controlled migration required');
      if (!old) this.records.set(key, { ...input, ...scope, state: 'unknown' });
      current.add(key);
    }
    for (const key of this.records.keys()) if (!current.has(key)) this.records.delete(key);
  }
  async onboarding(account, bot, start = false) {
    this.reload();
    if (!this.accessAllowed(account, bot))
      return { state: 'access-disabled', message: 'Computer access is disabled for this bot.' };
    if (this.lookup(account, bot)) return { state: 'ready' };
    if (this.store && !this.store.data.bots.some(b => b.id === bot && !b.deletedAt))
      throw Error('Unknown bot');
    const chosen = this.store?.data.bots.find(b => b.id === bot).computer;
    if (chosen && chosen !== 'vm')
      return { state: 'access-disabled', message: 'Computer access is disabled for this bot.' };
    // Only the install and the owner's Retry build the computer. This asks for a session on it, or how the build is going.
    try {
      if (this.environmentPolicy) {
        if (!this.broker.sessionSetup)
          throw Error('Environment session provisioning is not installed');
        return await this.broker.sessionSetup(
          account,
          this.environmentPolicy.environmentId,
          bot,
          start,
        );
      }
      return await this.computerBuild();
    } catch (error) {
      if (error.message === 'Environment session provisioning is not installed') throw error;
      return { state: 'unreachable', message: error.message };
    }
  }
  async computerBuild(retry = false) {
    if (!this.broker.computerBuild) return { state: 'setup-required' };
    const build = await this.broker.computerBuild(retry);
    return build.state === 'ready' ? { state: 'allocation-available' } : build;
  }
  // The computer is a service next to the chat: each bot set to it gets a desktop, and a deleted bot loses its own.
  async syncSessions(wantsComputer, now = Date.now()) {
    if (this.syncing || !this.store || !this.accountId) return;
    this.syncing = true;
    try {
      this.reload();
      const environment = this.environmentPolicy?.environmentId;
      if (!environment || !this.broker.sessionSetup) return;
      for (const bot of this.store.data.bots) {
        const session = this.registry.get(this.accountId, bot.id);
        if (!bot.deletedAt) this.sessionsGone.delete(bot.id);
        // A deleted bot with no session may still have a half-made one, which only the broker can see.
        if (
          !(bot.deletedAt
            ? session || !this.sessionsGone.has(bot.id)
            : !session && wantsComputer(bot)) ||
          now - (this.sessionAsked.get(bot.id) ?? -SESSION_RETRY_MS) < SESSION_RETRY_MS
        )
          continue;
        const result = await (bot.deletedAt
          ? this.broker.sessionRemove?.(this.accountId, environment, bot.id)
          : this.broker.sessionSetup(this.accountId, environment, bot.id, true));
        this.sessionAsked.set(bot.id, now);
        if (result?.state === 'removed') this.sessionsGone.add(bot.id);
      }
    } finally {
      this.syncing = false;
    }
  }
  accessAllowed(account, bot) {
    if (!this.environmentPolicy) return true;
    const candidate = this.store?.data.bots.find(b => b.id === bot);
    return botComputerAccess(
      this.environmentPolicy,
      candidate
        ? {
            ...candidate,
            environmentId: candidate.environmentId || this.environmentPolicy.environmentId,
          }
        : null,
      { accountId: account, environmentId: this.environmentPolicy.environmentId },
    );
  }
  lookup(account, bot) {
    this.reload();
    if (!this.accessAllowed(account, bot)) return null;
    const r = this.registry.get(account, bot);
    if (r && this.environmentPolicy) {
      const candidate = this.store.data.bots.find(b => b.id === bot);
      registeredBotSession(
        this.environmentPolicy,
        {
          ...candidate,
          environmentId: candidate.environmentId || this.environmentPolicy.environmentId,
        },
        { accountId: account, environmentId: this.environmentPolicy.environmentId },
        [...this.records.values()],
      );
    }
    return r ? { ...r } : null;
  }
  record(scope) {
    const r = this.lookup(scope.accountId, scope.botId);
    if (!r || scopeKey(r) !== scopeKey(scope)) throw Error('Desktop identity changed');
    return r;
  }
  async refresh(account, bot) {
    this.reload();
    if (!this.accessAllowed(account, bot)) return null;
    const record = this.registry.get(account, bot);
    if (!record) return null;
    try {
      const result = await this.broker.status(desktopScope(record));
      record.state = result.state;
    } catch (error) {
      record.state = 'unavailable';
      throw error;
    }
    return this.lookup(account, bot);
  }
  connectConsole(scope, options) {
    if (!this.enabled || this.record(scope).state !== 'running') throw Error('Desktop unavailable');
    return this.broker.connectConsole(scope, options);
  }
  async agent(scope, method, args = {}, requestId = randomUUID(), transient) {
    this.record(scope);
    if (!this.enabled) throw Error('Desktop provider disabled');
    if (method === 'execution.cancel') return this.cancel(scope, args.requestId);
    if (method === 'execution.reconcile')
      throw Error('Use the authenticated operation-review route');
    const invoke = () =>
      this.broker.guest({
        scope: desktopScope(scope),
        requestId,
        method,
        args,
        ...(transient ? { transient } : {}),
      });
    if (passiveGuestMethod(method) || method === 'files.write') return invoke();
    if (this.activeRequests.has(requestId)) throw Error('Request already active');
    const pending = { scope: desktopScope(scope), method, submitted: false, cancelled: false };
    this.activeRequests.set(requestId, pending);
    try {
      return await this.coordinator.runAgent(scope, () => {
        if (pending.cancelled)
          throw Object.assign(Error('Operation cancelled before dispatch'), {
            rejectedBeforeEffects: true,
          });
        pending.submitted = true;
        return invoke();
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
  async cancel(scope, targetRequestId) {
    this.record(scope);
    if (!this.enabled) throw Error('Desktop provider disabled');
    const pending = this.activeRequests.get(targetRequestId);
    if (pending) {
      if (scopeKey(pending.scope) !== scopeKey(scope)) throw Error('Cancellation scope mismatch');
      if (!['shell.run', 'desktop.type'].includes(pending.method))
        throw Error('This operation has no safe cancellation adapter');
      pending.cancelled = true;
      if (!pending.submitted) return { requested: true, state: 'cancelled-before-start' };
    }
    return this.broker.cancel({
      scope: desktopScope(scope),
      requestId: randomUUID(),
      targetRequestId,
    });
  }
  async desktopAction(scope, action, expectedFrame = null) {
    this.record(scope);
    if (!this.enabled) throw Error('Desktop provider disabled');
    // Native text is a cancellable guest operation, in the bot's own session.
    if (action.action === 'type') return this.agent(scope, 'desktop.type', { text: action.text });
    return this.coordinator.runAgent(scope, async () => {
      const frame = await this.broker.capture(scope);
      if (
        expectedFrame &&
        (frame.width !== expectedFrame.width || frame.height !== expectedFrame.height)
      )
        throw Error('Desktop dimensions changed; capture a fresh screenshot');
      return this.broker.input({
        scope: desktopScope(scope),
        requestId: randomUUID(),
        action,
        frame: { width: frame.width, height: frame.height },
      });
    });
  }
  attachStore(store) {
    if (this.teaching) throw Error('Teaching store is already attached');
    this.store = store;
    this.teaching = new DesktopTeachingDrafts({
      coordinator: this.coordinator,
      capture: scope => this.broker.capture(scope),
      redact: this.redact,
      saveSkill: async value => {
        this.record(value.scope);
        const frameIds = value.frames.map(
          (frame, index) =>
            saveReviewedFrame(store, {
              botId: value.scope.botId,
              demoId: value.demonstrationId,
              frameId: value.demonstrationId + '-' + index,
              reviewed: true,
              ...frame,
            }).id,
        );
        return saveDemonstration(store, {
          botId: value.scope.botId,
          demoId: value.demonstrationId,
          mode: 'desktop',
          objective: value.objective,
          name: value.name,
          instructions: value.instructions,
          steps: value.steps,
          frameIds,
          reviewed: true,
        });
      },
    });
  }
  async close() {
    this.teaching?.close();
    for (const state of this.coordinator.sessions.values()) {
      if (state.releasePromise) await state.releasePromise;
      else if (state.human)
        await this.coordinator.release(state.scope, { ...state.human, epoch: state.epoch });
    }
  }
}
