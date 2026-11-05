// Layout changes never remount the viewer, renew a ticket, or change ownership.
export function mountDesktopLayout({
  container,
  toolbar,
  tr = (_he, en) => en,
  document = container.ownerDocument,
  onError = () => {},
}) {
  const windowButton = document.createElement('button'),
    fullscreenButton = document.createElement('button');
  windowButton.type = fullscreenButton.type = 'button';
  windowButton.dataset.desktopWindow = '';
  fullscreenButton.dataset.desktopFullscreen = '';
  let expanded = false,
    closed = false;
  const render = () => {
    container.classList.toggle('desktop-window-expanded', expanded);
    windowButton.textContent =
      expanded || document.fullscreenElement === container
        ? tr('חזרה לתצוגה צדדית', 'Return to side view')
        : tr('חלון מלא', 'Fill window');
    windowButton.setAttribute('aria-pressed', String(expanded));
    fullscreenButton.textContent =
      document.fullscreenElement === container
        ? tr('יציאה ממסך מלא', 'Exit fullscreen')
        : tr('מסך מלא', 'Device fullscreen');
    fullscreenButton.setAttribute('aria-pressed', String(document.fullscreenElement === container));
  };
  windowButton.onclick = async () => {
    try {
      const wasFullscreen = document.fullscreenElement === container;
      if (wasFullscreen) await document.exitFullscreen();
      if (closed) return;
      expanded = wasFullscreen ? false : !expanded;
      render();
    } catch (error) {
      onError(error);
    }
  };
  fullscreenButton.onclick = async () => {
    try {
      if (document.fullscreenElement === container) await document.exitFullscreen();
      else if (container.requestFullscreen) await container.requestFullscreen();
      else
        throw Error(
          tr(
            'מסך מלא אינו נתמך בדפדפן זה; אפשר להשתמש בחלון מלא',
            'This browser does not support fullscreen; use Fill window',
          ),
        );
    } catch (error) {
      onError(error);
    }
  };
  const key = event => {
    if (
      event.key === 'Escape' &&
      expanded &&
      !document.fullscreenElement &&
      !document.querySelector('dialog[open]')
    ) {
      expanded = false;
      render();
      windowButton.focus();
    }
  };
  document.addEventListener('fullscreenchange', render);
  document.addEventListener('keydown', key);
  toolbar.append(windowButton, fullscreenButton);
  render();
  return {
    get expanded() {
      return expanded;
    },
    close() {
      closed = true;
      document.removeEventListener('fullscreenchange', render);
      document.removeEventListener('keydown', key);
      container.classList.remove('desktop-window-expanded');
      windowButton.remove();
      fullscreenButton.remove();
    },
  };
}
