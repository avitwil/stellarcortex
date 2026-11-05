export class GuestDesktop {
  constructor(rpc, { enabled = false } = {}) {
    this.rpc = rpc;
    this.enabled = enabled;
    this.mode = 'guest-desktop';
    this.queues = new Map();
    this.runs = new Map();
  }
  invoke(method, botId, args = {}) {
    if (!this.enabled && !['desktop.status', 'desktop.release'].includes(method))
      return Promise.reject(Error('Desktop access disabled'));
    const key = botId || 'status',
      prior = this.queues.get(key) || Promise.resolve(),
      work = prior
        .catch(() => {})
        .then(async () => {
          if (botId) await this.rpc.ensureBot?.(botId);
          return this.rpc.call(method, botId, args);
        });
    this.queues.set(key, work);
    return work;
  }
  status(botId) {
    if (!this.enabled)
      return Promise.resolve({
        enabled: false,
        available: false,
        mode: this.mode,
        reason: 'Desktop access disabled',
      });
    if (botId === undefined || botId === null)
      return Promise.resolve({
        enabled: true,
        available: false,
        mode: this.mode,
        state: 'unselected',
        reason: 'Select an agent to inspect its guest desktop',
      });
    return this.invoke('desktop.status', botId);
  }
  async acquire(botId, runId) {
    const r = await this.invoke('desktop.acquire', botId, { runId });
    this.runs.set(runId, botId);
    return r;
  }
  release(runId) {
    const botId = this.runs.get(runId);
    this.runs.delete(runId);
    return botId ? this.invoke('desktop.release', botId, { runId }) : Promise.resolve();
  }
  setTakeover(botId, enabled) {
    return this.invoke('desktop.takeover', botId, { enabled });
  }
  snapshot(botId) {
    return this.invoke('desktop.snapshot', botId);
  }
  action(botId, args, manual = false) {
    return this.invoke('desktop.action', botId, { input: args, manual });
  }
  removeBot(botId) {
    return this.invoke('desktop.remove', botId);
  }
  async close() {
    await Promise.allSettled([...this.queues.values()]);
    this.enabled = false;
  }
}
