import { randomUUID } from 'node:crypto';
const valid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function desktopScope(scope) {
  if (!scope || !['accountId', 'botId', 'vmId', 'generation'].every(k => valid(scope[k])))
    throw Error('Trusted desktop scope required');
  const keys = ['accountId', 'botId', 'vmId', 'generation'];
  if (['environmentId', 'computerId', 'sessionId'].some(k => scope[k] !== undefined)) {
    if (!['environmentId', 'computerId', 'sessionId'].every(k => valid(scope[k])))
      throw Error('Complete trusted desktop session identity required');
    keys.push('environmentId', 'computerId', 'sessionId');
  }
  return Object.freeze(Object.fromEntries(keys.map(k => [k, scope[k]])));
}
export const STOPPED_COMPUTER = 'The computer is not running. Press Start in Settings > Computer.';
export const scopeKey = scope => JSON.stringify(desktopScope(scope));
export class DesktopSessionCoordinator {
  constructor({
    clock = () => performance.now(),
    leaseMs = 30000,
    onClaim = async () => {},
    onRelease = async () => {},
    releaseInputs = async () => {
      throw Error('Input cleanup adapter required');
    },
  } = {}) {
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.onClaim = onClaim;
    this.onRelease = onRelease;
    this.releaseInputs = releaseInputs;
    this.sessions = new Map();
  }
  state(scope) {
    const key = scopeKey(scope);
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        scope: desktopScope(scope),
        epoch: 0,
        human: null,
        queue: Promise.resolve(),
        recovering: false,
      };
      this.sessions.set(key, s);
    }
    return s;
  }
  async claim(scope, sessionId) {
    if (!valid(sessionId)) throw Error('Authenticated session identity required');
    await this.expire(scope);
    const s = this.state(scope);
    if (s.recovering) throw Error('Desktop input recovery is pending');
    if (s.human && s.human.sessionId !== sessionId) throw Error('Another user session has control');
    if (s.human) throw Error('Return existing control before opening another controller');
    s.epoch++;
    const epoch = s.epoch;
    s.human = { sessionId, connectionId: randomUUID(), expiresAt: this.clock() + this.leaseMs };
    try {
      await this.onClaim(scope);
    } catch (error) {
      void this.release(scope, { ...s.human, epoch }).catch(() => {});
      throw Error(
        'Could not confirm interruption; observe the desktop while input cleanup completes',
        { cause: error },
      );
    }
    await s.queue;
    if (s.epoch !== epoch || s.recovering || !s.human)
      throw Error('Control changed while waiting for active input');
    s.human.expiresAt = this.clock() + this.leaseMs;
    return { ...s.human, epoch };
  }
  canWrite(scope, { sessionId, connectionId, epoch }) {
    const s = this.state(scope);
    return (
      !s.recovering &&
      !!s.human &&
      s.epoch === epoch &&
      s.human.sessionId === sessionId &&
      s.human.connectionId === connectionId &&
      s.human.expiresAt > this.clock()
    );
  }
  heartbeat(scope, lease) {
    if (!this.canWrite(scope, lease)) throw Error('Control lease expired or changed');
    this.state(scope).human.expiresAt = this.clock() + this.leaseMs;
  }
  async release(scope, lease) {
    const s = this.state(scope);
    if (
      !s.human ||
      s.epoch !== lease.epoch ||
      s.human.sessionId !== lease.sessionId ||
      s.human.connectionId !== lease.connectionId
    )
      return false;
    s.epoch++;
    s.human = null;
    s.recovering = true;
    const release = (async () => {
      try {
        await s.queue;
        await this.releaseInputs(s.scope);
        await this.onRelease(s.scope).catch(() => {});
        s.recovering = false;
        return true;
      } catch (error) {
        throw Error('Input release was not confirmed; observe desktop before resuming', {
          cause: error,
        });
      }
    })();
    s.releasePromise = release;
    try {
      return await release;
    } finally {
      if (s.releasePromise === release) s.releasePromise = null;
    }
  }
  async expire(scope) {
    const s = this.state(scope);
    if (s.human && s.human.expiresAt <= this.clock())
      return this.release(scope, { ...s.human, epoch: s.epoch });
    return false;
  }
  runAgent(scope, operation) {
    const s = this.state(scope),
      epoch = s.epoch;
    if (s.human || s.recovering)
      return Promise.reject(Error('Human control or input recovery is active'));
    if (s.agentActive)
      return Promise.reject(
        Error(
          'Desktop input is already active; cancel the active operation or retry after it completes',
        ),
      );
    s.agentActive = true;
    const run = s.queue.then(() => {
      if (s.epoch !== epoch || s.human || s.recovering)
        throw Error('Queued agent input cancelled by human control');
      return operation({ scope: s.scope, epoch });
    });
    const settled = run.finally(() => {
      s.agentActive = false;
    });
    s.queue = settled.catch(() => {});
    return settled;
  }
  observation(scope) {
    const s = this.state(scope);
    return {
      scope: s.scope,
      epoch: s.epoch,
      mode: s.recovering ? 'recovering' : s.human ? 'human' : 'agent',
      leaseExpired: !!s.human && s.human.expiresAt <= this.clock(),
    };
  }
}
