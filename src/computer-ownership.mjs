export class ComputerOwnership {
  constructor() {
    this.sessions = new Map();
  }
  session(botId) {
    let s = this.sessions.get(botId);
    if (!s) {
      s = { human: false, epoch: 0, queue: Promise.resolve() };
      this.sessions.set(botId, s);
    }
    return s;
  }
  reject() {
    return Object.assign(
      Error('Computer control changed. Read a fresh screen before further input.'),
      { rejectedBeforeEffects: true },
    );
  }
  async takeover(botId, enabled, apply) {
    const s = this.session(botId);
    s.epoch++;
    s.human = enabled;
    // Claim priority immediately. Already-running input settles before the UI
    // receives ownership; older queued agent input is rejected at execution.
    const epoch = s.epoch;
    const work = s.queue
      .catch(() => {})
      .then(async () => {
        if (s.epoch !== epoch) throw this.reject();
        await apply(enabled);
        return { ok: true, takeover: enabled, epoch };
      });
    s.queue = work.catch(() => {});
    return work;
  }
  input(botId, manual, apply) {
    const s = this.session(botId),
      epoch = s.epoch;
    if (s.human !== manual) return Promise.reject(this.reject());
    const work = s.queue
      .catch(() => {})
      .then(() => {
        if (s.epoch !== epoch || s.human !== manual) throw this.reject();
        return apply();
      });
    s.queue = work.catch(() => {});
    return work;
  }
}
