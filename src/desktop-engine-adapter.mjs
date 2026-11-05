import { randomUUID, createHash } from 'node:crypto';
import { GuestExecution } from './guest-execution.mjs';
import { desktopScope, scopeKey } from './desktop-provider-session.mjs';
import { computerStatusText } from './desktop-provider-runtime.mjs';
// Reuse the verified model-tool isolation policy, never the old VM transport.
export function desktopEngineExecution(provider, { accountId, isolation }) {
  if (!provider.enabled || !isolation?.enabled)
    throw Error('Enabled desktop and verified guest isolation configuration required');
  const scopeFor = botId => {
    const record = provider.lookup(accountId, botId);
    if (!record) throw Error('No desktop registered for this bot; host fallback is disabled');
    return desktopScope(record);
  };
  const records = [...provider.records.values()].filter(r => r.accountId === accountId);
  const generation = createHash('sha256')
    .update(
      JSON.stringify(
        records
          .map(r => [
            r.botId,
            r.vmId,
            r.generation,
            ...(r.sessionId ? [r.environmentId, r.computerId, r.sessionId] : []),
          ])
          .sort(),
      ),
    )
    .digest('hex');
  const rpc = {
    generation,
    uncertain: new Set(),
    ensureBot: async botId => scopeFor(botId),
    call: (method, botId, args = {}, requestId = randomUUID(), transient) =>
      provider.agent(scopeFor(botId), method, args, requestId, transient),
    reconcile: () => {
      throw Error('Desktop broker audit review is required; no local-only clearing');
    },
  };
  const execution = new GuestExecution(rpc, {
    enabled: true,
    providerIsolation: { ...isolation.providerIsolation },
  });
  execution.codexExecutable = isolation.codexExecutable;
  execution.claudeExecutable = isolation.claudeExecutable;
  execution.problems = isolation.problems || {};
  execution.admissionPaused = false;
  execution.boundary = 'qemu-kvm-ubuntu-desktop';
  // Uncertainty belongs to its VM and remains enforced by the durable broker and
  // guest ledgers. A different bot must not inherit another VM's transport state.
  execution.health = async botId => {
    if (!provider.lookup(accountId, botId)) {
      const setup = await provider.onboarding(accountId, botId, true);
      throw Error(computerStatusText(setup));
    }
    const scope = scopeFor(botId),
      state = await provider.refresh(accountId, botId);
    if (state.state !== 'running') throw Error('This bot desktop is not running');
    const status = await provider.agent(scope, 'execution.ping');
    return status;
  };
  execution.reconcile = async () => {
    throw Error(
      'Review the specific durable desktop operation through the broker; legacy reconciliation is unavailable',
    );
  };
  const frames = new Map(),
    runs = new Map();
  execution.desktop = {
    mode: execution.boundary,
    enabled: true,
    status: async botId =>
      botId
        ? {
            ...(await provider.refresh(accountId, botId)),
            enabled: true,
            available: provider.lookup(accountId, botId)?.state === 'running',
            mode: execution.boundary,
          }
        : { enabled: true, available: false, mode: execution.boundary, state: 'unselected' },
    acquire: async (botId, runId) => {
      const scope = scopeFor(botId);
      runs.set(runId, botId);
      return provider.coordinator.observation(scope);
    },
    release: async runId => {
      runs.delete(runId);
    },
    snapshot: async botId => {
      const scope = scopeFor(botId),
        frame = {
          ...(await provider.broker.capture(scope)),
          frameId: randomUUID(),
          scopeKey: scopeKey(scope),
          capturedAt: Date.now(),
          available: true,
        };
      frames.set(botId, frame);
      return frame;
    },
    action: async (botId, action, manual = false, { signal } = {}) => {
      if (manual) throw Error('Manual input uses the authenticated live desktop control channel');
      const scope = scopeFor(botId),
        frame = frames.get(botId);
      if (
        !frame ||
        frame.scopeKey !== scopeKey(scope) ||
        frame.frameId !== action.frameId ||
        Date.now() - frame.capturedAt > 30000
      )
        throw Error('Use coordinates from a fresh desktop screenshot and its frameId');
      if (signal?.aborted) throw Error('Desktop action cancelled before dispatch');
      if (action.action !== 'type')
        return provider.desktopAction(scope, action, { width: frame.width, height: frame.height });
      const requestId = randomUUID(),
        abort = () => {
          provider.cancel(scope, requestId).catch(() => {});
        };
      const work = provider.agent(scope, 'desktop.type', { text: action.text }, requestId);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        return await work;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    setTakeover: async () => {
      throw Error('Use the live desktop control lease');
    },
    removeBot: async () => {
      throw Error('Preserve the desktop disk; removal requires explicit lifecycle review');
    },
    close: async () => {
      frames.clear();
      runs.clear();
    },
  };
  execution.browser.setTakeover = async () => {
    throw Error('Use the shared live desktop control lease');
  };
  return execution;
}
