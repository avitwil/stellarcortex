// noVNC is injected from the pinned packaged module by the enabled provider UI.
// This controller never chooses a guest address or replays inputs on reconnect.
export class RemoteDesktopView {
  constructor({ element, botId, RFB, api, origin = location.origin, onState = () => {} }) {
    Object.assign(this, { element, botId, RFB, api, origin, onState });
    this.rfb = null;
    this.lease = null;
    this.sequence = 0;
    this.heartbeat = null;
  }
  path(action) {
    return `/api/desktops/${encodeURIComponent(this.botId)}/${action}`;
  }
  async connect(mode = 'view') {
    const sequence = ++this.sequence;
    this.rfb?.disconnect();
    this.rfb = null;
    this.onState('connecting');
    let ticket;
    try {
      ticket = await this.api(this.path('ticket'), { mode, lease: this.lease });
    } catch (error) {
      if (sequence === this.sequence) this.onState('disconnected');
      throw error;
    }
    if (sequence !== this.sequence) return;
    const url = new URL(this.path('display'), this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new this.RFB(this.element, url.href, {
      wsProtocols: [ticket.protocol],
      shared: true,
    });
    this.rfb = rfb;
    rfb.viewOnly = mode !== 'control';
    rfb.scaleViewport = true;
    rfb.resizeSession = false; // Scale the stable guest desktop; narrow phone/sidebar views must not resize it.
    rfb.addEventListener('connect', () => {
      if (sequence === this.sequence)
        this.onState(mode === 'control' ? 'controlling' : 'observing');
    });
    rfb.addEventListener('disconnect', () => {
      if (this.rfb === rfb) this.rfb = null;
      if (sequence === this.sequence) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.lease = null;
        this.onState('disconnected');
      }
    });
    rfb.addEventListener('credentialsrequired', () => {
      rfb.disconnect();
      this.onState('configuration-error');
    });
  }
  async claim() {
    if (this.lease || this.claiming) return;
    this.claiming = true;
    const sequence = this.sequence;
    this.onState('waiting-for-control');
    let lease;
    try {
      lease = await this.api(this.path('control'), { enabled: true });
    } finally {
      this.claiming = false;
    }
    if (sequence !== this.sequence) {
      await this.api(this.path('control'), { enabled: false, lease });
      return;
    }
    this.lease = lease;
    try {
      await this.connect('control');
      this.heartbeat = setInterval(
        () =>
          this.api(this.path('heartbeat'), { lease: this.lease }).catch(() => this.disconnect()),
        10000,
      );
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  async release() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    const lease = this.lease,
      sequence = this.sequence;
    this.lease = null;
    if (this.rfb) this.rfb.viewOnly = true;
    if (lease) await this.api(this.path('control'), { enabled: false, lease });
    if (sequence === this.sequence) await this.connect('view');
  }
  disconnect() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.sequence++;
    this.rfb?.disconnect();
    this.rfb = null;
    this.lease = null;
    this.onState('disconnected');
  }
}
