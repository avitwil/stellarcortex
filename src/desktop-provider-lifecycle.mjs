import { desktopScope, scopeKey } from './desktop-provider-session.mjs';
// The adapter is a narrowly-scoped broker, never a caller-supplied shell command.
export class DesktopProviderLifecycle {
  constructor({ broker, registry, approved = false }) {
    this.broker = broker;
    this.registry = registry;
    this.approved = approved;
    this.pending = new Map();
  }
  record(accountId, botId) {
    const record = this.registry.get(accountId, botId);
    if (!record) throw Error('Registered desktop required');
    return { ...record, accountId, botId };
  }
  async status(accountId, botId) {
    const record = this.record(accountId, botId);
    return this.broker.status(desktopScope(record));
  }
  async change(accountId, botId, action, { expectedGeneration, requestId } = {}) {
    if (!this.approved) throw Error('Desktop provisioning approval is pending');
    if (!['start', 'shutdown'].includes(action))
      throw Error('Unsupported desktop lifecycle operation');
    const record = this.record(accountId, botId),
      scope = desktopScope(record),
      key = scopeKey(scope);
    if (
      expectedGeneration !== scope.generation ||
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)
    )
      throw Error('Current generation and durable request identity required');
    if (this.pending.has(key)) throw Error('Desktop lifecycle operation already pending');
    const operation = this.broker.change({ scope, action, requestId });
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }
}
