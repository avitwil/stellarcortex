// Request from the original click handler so the browser retains user activation.
// Embedded browsers may reject fullscreen; the CSS viewer remains available.
export class ComputerFullscreen {
  constructor(document, onExit, onError = () => {}) {
    this.document = document;
    this.onExit = onExit;
    this.onError = onError;
    this.wanted = false;
    this.active = false;
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === this.element) {
        if (!this.wanted) {
          this.close().catch(onError);
          return;
        }
        this.active = true;
      } else if (this.active) {
        this.active = false;
        this.wanted = false;
        Promise.resolve(onExit()).catch(onError);
      }
    });
  }
  open(element) {
    this.element = element;
    this.wanted = true;
    if (element && this.document.fullscreenElement === element) return Promise.resolve(true);
    if (!element?.requestFullscreen) return Promise.resolve(false);
    try {
      return Promise.resolve(element.requestFullscreen()).then(
        async () => {
          if (!this.wanted) await this.close();
          return this.document.fullscreenElement === element;
        },
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }
  async close() {
    this.wanted = false;
    this.active = false;
    if (this.element && this.document.fullscreenElement === this.element) {
      await this.document.exitFullscreen();
    }
  }
}
