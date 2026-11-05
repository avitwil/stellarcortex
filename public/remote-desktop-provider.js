import { mountDesktopLayout } from './desktop-view-layout.js';
import { mountDesktopOperations } from './desktop-operation-panel.js';
import { mountDesktopTeaching } from './desktop-teaching-panel.js';
import RFB from './vendor/novnc/core/rfb.js';
import { RemoteDesktopView } from './remote-desktop.js';
import { computerSetupText, desktopConnectionText, desktopFailureText } from './computer-status.js';
// Explicit new-provider entry point; not mounted by the legacy viewer.
export async function mountRemoteDesktop({ element, botId, api, tr = (_h, e) => e }) {
  const container = document.createElement('section');
  container.className = 'remote-desktop-provider';
  const toolbar = document.createElement('div'),
    status = document.createElement('span'),
    claim = document.createElement('button'),
    release = document.createElement('button'),
    reconnect = document.createElement('button'),
    screen = document.createElement('div');
  status.setAttribute('role', 'status');
  claim.textContent = tr('שימוש במחשב', 'Use desktop');
  release.textContent = tr('החזרה לבוט', 'Return to agent');
  screen.className = 'remote-desktop-screen';
  toolbar.className = 'remote-desktop-toolbar';
  reconnect.textContent = tr('חיבור מחדש לצפייה', 'Reconnect to view');
  toolbar.append(status, claim, release, reconnect);
  container.append(toolbar, screen);
  element.replaceChildren(container);
  let mode = 'connecting';
  const view = new RemoteDesktopView({
    element: screen,
    botId,
    RFB,
    api,
    onState: value => {
      mode = value;
      status.dataset.state = value;
      status.textContent = desktopConnectionText(value, tr);
      claim.disabled = value !== 'observing';
      release.disabled = value !== 'controlling';
      reconnect.disabled = !['disconnected', 'configuration-error'].includes(value);
    },
  });
  const report = async error => {
    const machine = await api('/api/desktops/' + botId).then(
      info => info.state,
      () => null,
    );
    status.textContent = desktopFailureText(machine, error.message, tr);
  };
  claim.onclick = () => view.claim().catch(report);
  release.onclick = () => view.release().catch(report);
  reconnect.onclick = () => view.connect('view').catch(report);
  const layout = mountDesktopLayout({ container, toolbar, tr, onError: report });
  screen.addEventListener(
    'pointerdown',
    event => {
      if (mode === 'observing') {
        event.preventDefault();
        event.stopImmediatePropagation();
        view.claim().catch(report);
      }
    },
    { capture: true },
  );
  const unmountOperations = mountDesktopOperations({ element: toolbar, botId, api, tr });
  const unmountTeaching = mountDesktopTeaching({ element: toolbar, view, botId, api, tr });
  await view.connect('view').catch(report);
  return {
    view,
    unmount() {
      layout.close();
      unmountOperations();
      unmountTeaching();
      view.disconnect();
      container.remove();
    },
  };
}

// Unallocated bots must never fall through to the old computer viewer.
export async function mountComputerSetup({ element, botId, api, tr = (_h, e) => e }) {
  let closed = false,
    timer,
    mounted;
  const text = document.createElement('p'),
    retry = document.createElement('button');
  text.setAttribute('role', 'status');
  retry.textContent = tr('בדיקת הכנת המחשב', 'Check computer setup');
  element.replaceChildren(text, retry);
  const check = async (start = false) => {
    try {
      const state = await api(
        '/api/desktops/' + botId + '/setup',
        start ? { method: 'POST', body: {} } : undefined,
      );
      if (closed) return;
      if (state.state === 'ready') {
        mounted = await mountRemoteDesktop({ element, botId, api, tr });
        if (closed) mounted.unmount();
        return;
      }
      text.textContent = computerSetupText(state, tr);
      retry.disabled = state.active === true;
      if (
        ['allocation-available', 'applying', 'building', 'starting', 'unreachable'].includes(
          state.state,
        )
      )
        timer = setTimeout(() => check(), 5000);
    } catch (error) {
      if (!closed) text.textContent = error.message;
    }
  };
  retry.onclick = () => check(true);
  await check();
  return {
    unmount() {
      closed = true;
      clearTimeout(timer);
      mounted?.unmount();
    },
  };
}
