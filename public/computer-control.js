// Keep the remote lease attached to the context that requested it, even if the
// visible bot changes while a request is in flight.
export class ComputerControlSession {
  owner = null;
  transition = null;
  constructor({ setTakeover, idle }) {
    this.setTakeover = setTakeover;
    this.idle = idle;
  }
  get accepting() {
    return !!this.owner && !this.transition;
  }
  revoked() {
    if (!this.transition) this.owner = null;
  }
  acquire(owner, isCurrent) {
    if (this.transition || this.owner) return Promise.resolve(false);
    const transition = { kind: 'acquire', owner, cancelled: false };
    this.transition = transition;
    transition.promise = (async () => {
      try {
        await this.idle();
        if (transition.cancelled || !isCurrent()) return false;
        await this.setTakeover(owner, true);
        if (transition.cancelled || !isCurrent()) {
          await this.setTakeover(owner, false);
          return false;
        }
        this.owner = owner;
        return true;
      } finally {
        if (this.transition === transition) this.transition = null;
      }
    })();
    return transition.promise;
  }
  release() {
    if (this.transition) {
      if (this.transition.kind === 'acquire') this.transition.cancelled = true;
      return this.transition.promise.then(() => undefined);
    }
    if (!this.owner) return Promise.resolve();
    const owner = this.owner,
      transition = { kind: 'release', owner };
    this.transition = transition;
    transition.promise = (async () => {
      try {
        await this.idle();
        await this.setTakeover(owner, false);
      } finally {
        if (this.owner === owner) this.owner = null;
        if (this.transition === transition) this.transition = null;
      }
    })();
    return transition.promise;
  }
}
