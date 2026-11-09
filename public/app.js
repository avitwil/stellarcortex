import { renderToolDetails } from './tool-details.js';
import { providerTermsNote } from './provider-terms.js';
import { mountRemoteDesktop, mountComputerSetup } from './remote-desktop-provider.js';
import { VisualDemonstration } from './visual-demonstration.js';
import { openVisualStep } from './visual-teaching-panel.js';
import { ComputerDemonstration, demonstrationText } from './computer-demonstration.js';
import { KanbanPage } from './kanban.js';
import {
  modelId,
  botModelValues,
  botModelContext,
  changeBotModel,
  validateBotModelValues,
  botProvider,
  providerModelDefaults,
  changeBotProvider,
  botEffortControl,
  modelChoiceGroups,
  availableProviderIds,
  isCustomProvider,
} from './bot-models.js';
import { computerKeyAction, screenPoint, ComputerInputQueue } from './computer-input.js';
import { ComputerControlSession } from './computer-control.js';
import { ComputerFullscreen } from './computer-fullscreen.js';
import {
  latestUsageReport,
  reportUsageWindows,
  accountUpdateAction,
  tokenUsageSummary,
} from './provider-usage.js';
import {
  CONNECTION_PROVIDER_IDS,
  LOCAL_ENGINE_PRESETS,
  API_PROVIDER_PRESETS,
  API_PROTOCOLS,
  isConnectionProvider,
  connectionDraft,
  connectionUpdate,
  changeLocalEngine,
  safeConnectionMetadata,
  connectionNeedsSave,
  newConnectionDraft,
  connectionCreate,
  endpointKeyRequired,
  isOpenCodeEndpoint,
} from './provider-connections.js';
import { VoiceCall } from './voice-call.js';
import { VoiceTaskScope } from './voice-chat.js';
import { AppsHub } from './apps-hub.js';
import { mountClaudePermissions, mountSoftwareUpdates } from './software-settings.js';
import { mountClaudeLogin } from './claude-login.js';
import { localizeDefaultBots } from './default-bot.js';
import { usageErrorText } from './usage-errors.js';
import { chatErrorText, withoutProgramOutput } from './chat-errors.js';
import { providerText } from './provider-text.js';
import { mountComputerBoot, mountComputerBuild, mountComputerModes } from './computer-settings.js';
import { computerEmptyState } from './computer-status.js';
import { renderSecretDialog } from './secret-dialog.js';
import { createDesignHost, designPickerMarkup } from './themes/design.js';
import { createMission } from './themes/mission.js';
const $ = s => document.querySelector(s);
const esc = v =>
  String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const paths = {
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow: 'm6 12 6-6 6 6M12 6v14',
  attach: 'M8 12 15 5a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M5 16 16 5',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8',
  computer: 'M3 4h18v13H3ZM8 21h8M12 17v4',
  info: 'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  library: 'M4 4h4v17H4ZM10 4h4v17h-4ZM16 5l4-1 4 16-4 1Z',
  spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  settings:
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M9 2h6l1 3 3 1 3 3v6l-3 1-1 3-3 3H9l-1-3-3-1-3-3V9l3-1 1-3Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  copy: 'M9 8h12v14H9ZM15 5V2H2v14h4',
  stop: 'M6 6h12v12H6Z',
  pin: 'm9 3 9 3-2 5 3 4-7 1-5 5 2-7-4-3 5-3Z',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  edit: 'm15 3 6 6M3 21l5-1L21 7a2 2 0 0 0-4-4L4 16Z',
  sound: 'M3 9h4l5-5v16l-5-5H3ZM16 8a6 6 0 0 1 0 8M19 4a11 11 0 0 1 0 16',
  link: 'm10 13 4-4M7 15l-2 2a3 3 0 0 0 4 4l4-4a3 3 0 0 0 0-4M11 11a3 3 0 0 1 0-4l4-4a3 3 0 0 1 4 4l-2 2',
  check: 'm4 12 5 5L20 6',
  close: 'm6 6 12 12M18 6 6 18',
};
const icon = name =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.spark}"/></svg>`;
paths.phone =
  'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z';
paths.minimize = 'M5 12h14';
paths.micOff =
  'm3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 11v1a7 7 0 0 0 12 5M19 11v1M12 19v3M8 22h8';
const colors = {
  violet: '#aa92ee',
  mint: '#79c9b0',
  amber: '#e5c466',
  blue: '#78ade1',
  rose: '#dc92ab',
  orange: '#dc9d6f',
};
let state,
  account,
  chatId = localStorage.getItem('stellarcortex-chat'),
  view = 'chat',
  details = false,
  detailTab = 'computer',
  files = [],
  source,
  refreshing = false,
  refreshAgain = false,
  lastChat = null,
  screenTimer,
  screenBusy = false,
  streamMessage = null;
const providerAccounts = {},
  providerRequests = new Map(),
  providerUsageRevisions = {};
let connectionSettings = null,
  connectionSettingsRequest = null;
let voiceSession = null,
  voicePanelOpen = false,
  voiceMinimized = false,
  voiceMode = 'browser',
  voiceServer = null,
  voiceStatusError = '',
  voiceSetupLoading = false,
  dictation = null;
const providerName = provider =>
  ({
    codex: 'Codex',
    claude: 'Claude',
    'openai-api': 'OpenAI API',
    'anthropic-api': 'Claude API',
    local: tr('מודל מקומי', 'Local model'),
  })[provider] ||
  connectionSettings?.connections.find(item => item.provider === provider)?.name ||
  state?.providers?.find(item => item.id === provider)?.name ||
  provider;
const providerOptionName = provider =>
  provider === 'codex'
    ? tr('Codex · מנוי ChatGPT', 'Codex · ChatGPT plan')
    : provider === 'claude'
      ? tr('Claude · מנוי Claude', 'Claude · Claude plan')
      : providerName(provider);
const providerDefaultLabel = provider =>
  tr('ברירת המחדל של ' + providerName(provider), providerName(provider) + ' default');
const providerInheritLabel = provider =>
  provider === 'claude'
    ? tr('לפי Claude Code', 'Inherit Claude Code')
    : provider === 'codex'
      ? tr('לפי סביבת העבודה', 'Inherit workspace')
      : tr('לפי הגדרות החיבור', 'Inherit connection');
const providerAccount = provider => (provider === 'codex' ? account : providerAccounts[provider]);
let standardDesktop = null,
  standardDesktopEpoch = 0;
let detailBotId = null,
  computerMode = localStorage.getItem('stellarcortex-computer-mode') || 'desktop',
  computerExpanded = false,
  computerShot = null,
  desktopStatus = null,
  computerOperation = false,
  dragStart = null;
let teamRootFilter = '',
  replyToId = null;
const computerInputs = new ComputerInputQueue();
const computerDemonstration = new ComputerDemonstration();
const computerVisual = new VisualDemonstration({
  captureRedacted: request => api('/api/computer-demonstrations/frame', request),
});
const computerControl = new ComputerControlSession({
  setTakeover: (owner, enabled) => api(`/api/${owner.mode}/${owner.botId}/takeover`, { enabled }),
  idle: () => computerInputs.idle(),
});
const computerFullscreen = new ComputerFullscreen(
  document,
  () => closeComputerViewer(),
  error => reportComputerError(error),
);
let computerManual = false,
  computerSession = 0,
  computerTextTimer,
  computerPendingText = '',
  computerClickTimer,
  computerPendingClick = null,
  computerWheelTimer,
  computerWheel = 0,
  computerMoveTimer;
const composerSubmissions = new Set();
document.addEventListener('click', event => {
  if (event.target.closest?.('[data-open-connections]')) settings('connections');
  const use = event.target.closest?.('[data-use-provider]');
  if (use)
    api(`/api/bots/${activeBot().id}`, { provider: use.dataset.useProvider }, 'PATCH')
      .then(refresh)
      .catch(error => alert(error.message));
});
const drafts = JSON.parse(localStorage.getItem('stellarcortex-drafts') || '{}');
const tr = (he, en) => (state?.settings.language === 'he' ? he : en);
const direction = () => (state?.settings.language === 'he' ? 'rtl' : 'ltr');
const activeChat = () => state?.chats.find(c => c.id === chatId);
const botById = id => state?.bots.find(b => b.id === id);
const activeBot = () =>
  activeChat()
    ?.botIds.map(botById)
    .find(b => b && !b.deletedAt);
const kanbanPage = new KanbanPage({
  api,
  tr,
  toast,
  modal,
  openChat: async id => {
    await openChat(id);
  },
  isVisible: () => ['tasks', 'projects'].includes(view),
});
const appsHub = new AppsHub({
  api,
  tr,
  modal,
  toast,
  icon,
  isVisible: () => !!state && view === 'apps',
});
const chatAvailable = c => c.botIds.some(id => botById(id) && !botById(id).deletedAt);
const detailBot = () =>
  activeChat()?.botIds.includes(detailBotId) && !botById(detailBotId)?.deletedAt
    ? botById(detailBotId)
    : activeBot();
const statusLabel = s =>
  ({
    completed: tr('הושלם', 'Completed'),
    failed: tr('נכשל', 'Failed'),
    interrupted: tr('נעצר', 'Stopped'),
    queued: tr('בתור', 'Queued'),
    running: tr('עובד', 'Working'),
    waiting: tr('ממתין לאישור', 'Needs approval'),
  })[s] ||
  s ||
  '';
function toolLabel(m) {
  let item = {};
  try {
    item = JSON.parse(m.detail || '{}');
  } catch {}
  const name = item.toolName || item.tool || item.name || m.text || m.kind;
  return (
    {
      stellarcortex_connections: tr('אפליקציות מחוברות', 'Connected apps'),
      stellarcortex_team: tr('ניהול הצוות', 'Manage team'),
      stellarcortex_bots: tr('חברי הצוות', 'List teammates'),
      stellarcortex_handoff: tr('העברת משימה', 'Delegate task'),
      stellarcortex_tasks: tr('תוצאות הצוות', 'Team results'),
      stellarcortex_memory: tr('זיכרון', 'Memory'),
      stellarcortex_browser: tr('דפדפן', 'Browser'),
      stellarcortex_computer: tr('שליטה במחשב', 'Computer control'),
      stellarcortex_desktop: tr('שליטה במחשב', 'Computer control'),
      stellarcortex_skill: tr('מיומנות', 'Skill'),
      stellarcortex_routine: tr('שגרה', 'Routine'),
      stellarcortex_artifact: tr('פרסום תוצר', 'Publish artifact'),
      dynamicToolCall: tr('פעולת כלי', 'Tool action'),
      commandExecution: tr('פקודה', 'Command'),
      fileChange: tr('עדכון קבצים', 'File changes'),
      mcpToolCall: tr('פעולה בחיבור', 'Connected tool'),
      webSearch: tr('חיפוש ברשת', 'Web search'),
    }[name] || name
  );
}
const jobsFor = id =>
  state?.jobs.filter(j => j.botId === id && ['running', 'waiting', 'queued'].includes(j.status)) ||
  [];
function avatar(bot, size = '') {
  const color = colors[bot?.color] || colors.violet;
  const job = jobsFor(bot?.id)[0];
  const shape = bot?.shape || 'round';
  const body =
    shape === 'square'
      ? '<rect x="6" y="6" width="36" height="36" rx="9"/>'
      : shape === 'flower'
        ? '<path d="M24 3c6 0 7 6 11 7s10 2 10 8-5 8-5 12-1 12-8 13-7-3-11-3-10 5-14-1 0-9 0-13S0 18 4 13s10-3 13-6 3-4 7-4Z"/>'
        : '<path d="M7 15Q7 6 17 6h14q10 0 10 9v18q0 9-10 9H17Q7 42 7 33Z"/>';
  return `<span class="avatar ${size} ${job?.status === 'running' ? 'working' : job?.status === 'waiting' ? 'waiting' : ''}" title="${esc(job?.activity || bot?.title || '')}"><svg viewBox="0 0 48 48" aria-hidden="true"><g fill="${color}">${body}</g><ellipse cx="18" cy="24" rx="4.2" ry="6.2" fill="#25212b"/><ellipse cx="31" cy="24" rx="4.2" ry="6.2" fill="#25212b"/><circle cx="19" cy="22" r="1.4" fill="#fff"/><circle cx="32" cy="22" r="1.4" fill="#fff"/></svg></span>`;
}
function chatAvatar(chat) {
  return chat.type === 'direct'
    ? avatar(botById(chat.botIds[0]))
    : `<span class="group-avatar">${chat.botIds
        .slice(0, 4)
        .map(b => avatar(botById(b)))
        .join('')}</span>`;
}
// A pinned message is not replaced: a toast that arrives meanwhile is shown after it.
function toast(text, ms = 4500, pinned = false) {
  if (toast.pinned && !pinned) {
    toast.next = text;
    return;
  }
  toast.pinned = pinned;
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $('#toast').hidden = true;
    toast.pinned = false;
    const next = toast.next;
    toast.next = null;
    if (next) toast(next);
  }, ms);
}
// Lock and an expired session both drop workspace data, so nothing can be read from behind the login screen.
function showLogin() {
  source?.close();
  settingsSession = null;
  $('#modal').close();
  state = undefined;
  account = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
}
async function api(url, data, method, options = {}) {
  const r = await fetch(url, {
    signal: options.signal,
    method: method || (data ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await r.json();
  if (!r.ok) {
    if (r.status === 401) {
      void stopVoiceCall({ close: true, cancel: false });
      showLogin();
    }
    throw new Error(withoutProgramOutput(value.error, tr) || `HTTP ${r.status}`);
  }
  return value;
}
const act = fn => async event => {
  try {
    await fn(event);
  } catch (e) {
    toast(e.message);
  }
};
function modal(title, html, wide = false) {
  closeBotModelPopover();
  $('#modal').dataset.kind = '';
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-body')
    .querySelectorAll('label')
    .forEach((label, i) => {
      const field = label.nextElementSibling;
      if (field?.matches('input,textarea,select')) {
        field.id ||= `modal-field-${i}`;
        label.htmlFor = field.id;
      }
    });
  $('#modal').classList.toggle('wide', wide);
  if (!$('#modal').open) $('#modal').showModal();
  $('#modal-body').dir = direction();
}
$('#modal-close').onclick = () => $('#modal').close();
$('#modal').addEventListener('close', () => {
  $('#modal-body')
    .querySelectorAll('[data-connection-secret]')
    .forEach(field => (field.value = ''));
});
$('#modal').onclick = e => {
  if (e.target === $('#modal') && e.offsetX < 0) $('#modal').close();
};
const design = createDesignHost({
  state: () => state,
  view: () => view,
  chatId: () => chatId,
  detailTab: () => detailTab,
  online: () => source?.readyState === 1,
  tr,
  esc,
  api,
  toast,
  colors,
  relativeTime,
  toolLabel,
  statusLabel,
  openChat,
  settings,
  search,
  taskDetails,
  setTheme: act(async theme => {
    await api('/api/settings', { theme }, 'PATCH');
    await refresh();
  }),
  showTab: act(async tab => {
    if (tab === 'chat') {
      details = false;
      render();
    } else await openConversationDetails(activeChat(), tab);
  }),
  createMission,
});
function relativeTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleTimeString(state?.settings.language === 'he' ? 'he-IL' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
function applyTheme() {
  const theme = state.settings.theme,
    light =
      theme === 'light' ||
      (theme === 'system' && matchMedia('(prefers-color-scheme:light)').matches);
  document.body.classList.toggle('light', light);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', light ? '#f7f7fd' : '#0a0f1c');
  document.documentElement.lang = state.settings.language;
  document.documentElement.dir = direction();
  $('#modal').dir = direction();
}
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    state = await api('/api/state');
    localizeDefaultBots(state.bots, tr);
    if (!chatId || !state.chats.some(c => c.id === chatId && chatAvailable(c)))
      chatId = state.chats.find(chatAvailable)?.id || null;
    $('#login').hidden = true;
    $('#app').hidden = false;
    applyTheme();
    render();
    refreshBotConversation();
    renderUsageSurfaces();
    processVoiceReplies();
    showNotices();
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}
function connectEvents() {
  source?.close();
  source = new EventSource('/api/events');
  const currentSource = source,
    listen = (name, handler) =>
      currentSource.addEventListener(name, event => {
        if (source !== currentSource || currentSource.readyState === 2 || !state) return;
        handler(event);
      });
  listen('change', () => refresh().catch(() => {}));
  listen('delta', e => {
    const m = JSON.parse(e.data).message;
    const old = state.messages.find(x => x.id === m.id);
    if (old) Object.assign(old, m);
    else state.messages.push(m);
    if (view === 'chat') renderConversation();
    refreshBotConversation();
  });
  listen('account', handleAccountUpdate);
  listen('connections', () => appsHub.invalidate());
  listen('runtime', () => refresh().catch(() => {}));
  listen('completed', e => {
    const d = JSON.parse(e.data);
    if (voiceIsLive()) refresh().catch(() => {});
    if (
      state.settings.notifications &&
      document.hidden &&
      'Notification' in window &&
      Notification.permission === 'granted'
    )
      new Notification(`${d.bot} · ${d.status}`, {
        body: tr(
          'המשימה עודכנה — פתיחת StellarCortex לצפייה',
          'Your task has an update. Open StellarCortex to review.',
        ),
        icon: '/stellar-cortex-icon-512.png',
      });
  });
  source.onerror = () => {
    if (source !== currentSource || !state) return;
    if (voiceIsLive()) {
      voiceSession.error = tr(
        'החיבור לשרת נותק. יש להתחיל שיחה מחדש לאחר החיבור.',
        'Server connection lost. Start a new call after reconnecting.',
      );
      void stopVoiceCall();
    }
    if (state) {
      $('#runtime-notice').hidden = false;
      $('#runtime-notice').textContent = tr(
        'החיבור לשרת נותק. מנסה להתחבר מחדש…',
        'Connection lost. Reconnecting…',
      );
    }
    // A browser retries a lost stream by itself, but not after a refused
    // answer such as a proxy's 502 while the app restarts.
    if (currentSource.readyState === 2) setTimeout(() => reopenEvents(currentSource), 3000);
  };
  listen('connected', () => refresh().catch(() => {}));
}
async function reopenEvents(closed) {
  if (source !== closed || !state) return;
  // Refresh first: an ended session goes to login instead of retrying.
  await refresh().catch(() => {});
  if (source === closed && state) connectEvents();
}
function handleAccountUpdate(event) {
  let action;
  try {
    action = accountUpdateAction(JSON.parse(event.data || '{}'));
  } catch {
    return;
  }
  if (!action) return;
  const provider = action.provider;
  providerUsageRevisions[provider] = (providerUsageRevisions[provider] || 0) + 1;
  if (action.kind === 'usage') {
    const current = providerAccount(provider) || {};
    providerAccounts[provider] = {
      ...current,
      usage: action.usage,
      usageError: action.usage.error || null,
    };
    if (provider === 'codex') account = providerAccounts[provider];
    if (state) {
      state.providerUsage ||= {};
      state.providerUsage[provider] = action.usage;
      renderUsageSurfaces();
    }
    return;
  }
  const current = providerAccount(provider);
  if (current) {
    current.usage = null;
    current.usageError = null;
  }
  if (state?.providerUsage) delete state.providerUsage[provider];
  renderUsageSurfaces();
  const pending = providerRequests.get(provider);
  if (pending)
    pending
      .catch(() => {})
      .then(() => loadProviderAccount(provider, { refresh: true }).catch(() => {}));
  else loadProviderAccount(provider, { refresh: true }).catch(() => {});
}
async function loadAccount() {
  return loadProviderAccount('codex');
}
async function loadConnectionSettings() {
  if (connectionSettingsRequest) return connectionSettingsRequest;
  connectionSettingsRequest = (async () => {
    const result = await api('/api/provider-connections');
    connectionSettings = {
      connections: (result.connections || [])
        .filter(item => isConnectionProvider(item.provider))
        .map(safeConnectionMetadata),
      localEngines: Array.isArray(result.localEngines) ? result.localEngines : LOCAL_ENGINE_PRESETS,
      apiPresets:
        Array.isArray(result.apiPresets) && result.apiPresets.length
          ? result.apiPresets
          : API_PROVIDER_PRESETS,
    };
    if (state) {
      renderUsageSurfaces();
      renderComposerModelControls();
    }
    return connectionSettings;
  })().finally(() => (connectionSettingsRequest = null));
  return connectionSettingsRequest;
}
async function loadProviderAccount(provider = 'codex', { refresh = false } = {}) {
  if (providerRequests.has(provider)) return providerRequests.get(provider);
  const usageRevision = providerUsageRevisions[provider] || 0;
  const request = (async () => {
    const result = await api(
      provider === 'codex' && !refresh
        ? '/api/account'
        : '/api/providers/' + provider + '/account' + (refresh ? '?refresh=1' : ''),
    );
    if (usageRevision !== (providerUsageRevisions[provider] || 0)) {
      result.usage = providerAccount(provider)?.usage || null;
      result.usageError = providerAccount(provider)?.usageError || null;
    }
    if (isConnectionProvider(provider) && result.configured !== undefined)
      rememberConnection(result);
    providerAccounts[provider] = result;
    if (provider === 'codex') account = result;
    if (state) {
      renderSidebar();
      renderComposerModelControls();
      renderProviderNotice();
      renderUsageSurfaces();
      if (view === 'chat' && chatId && !state.messages.some(m => m.chatId === chatId))
        renderConversation();
    }
    return result;
  })().finally(() => providerRequests.delete(provider));
  providerRequests.set(provider, request);
  return request;
}
async function openChat(id) {
  if (chatId !== id) {
    await stopVoiceCall({ close: true });
    replyToId = null;
    renderReplyContext();
  }
  if (chatId) drafts[chatId] = $('#prompt').value;
  chatId = id;
  view = 'chat';
  localStorage.setItem('stellarcortex-chat', id);
  $('#sidebar').classList.remove('open');
  render();
  await api(`/api/chats/${id}/read`, {});
}
function render() {
  renderSecretDialog({ state, tr, esc, api, refresh, botById, direction });
  reconcileComputerContext();
  reconcileVoiceContext();
  renderSidebar();
  renderHeader();
  $('#composer-wrap').hidden = view !== 'chat' || !activeChat();
  renderProviderNotice();
  if (view === 'chat') {
    renderConversation();
    renderQueue();
    if (lastChat !== chatId) {
      $('#prompt').value = drafts[chatId] || '';
      lastChat = chatId;
    }
  } else renderPage();
  $('#details').hidden = !details || view !== 'chat';
  if (details && view === 'chat') renderDetails();
  $('#prompt').placeholder = tr(
    `הודעה ל${activeChat()?.name || 'Stellar'}…`,
    `Message ${activeChat()?.name || 'Stellar'}…`,
  );
  $('#composer-caption').textContent = tr(
    'פועל על המחשב או השרת שלך · כל בוט דרך החשבון שנבחר עבורו',
    'Runs on your computer or server · Each bot uses its selected provider account',
  );
  $('#composer-hint').textContent = tr('Enter לשליחה', 'Enter to send');
  renderComposerModelControls();
  renderInterfaceLabels();
  renderVoicePanel();
  design.render();
}
function voiceIsLive(session = voiceSession) {
  return !!session && !session.ending && !session.scope.closed;
}
function renderInterfaceLabels() {
  const labels = {
    'new-chat': ['שיחה חדשה', 'New chat'],
    attach: ['צירוף קבצים', 'Attach files'],
    mention: ['אזכור בוט', 'Mention a bot'],
    'skill-picker': ['בחירת מיומנות', 'Choose a skill'],
    send: ['שליחת הודעה', 'Send message'],
    prompt: ['הודעה', 'Message'],
    'modal-close': ['סגירה', 'Close'],
    'show-details': ['פרטים', 'Details'],
    'mobile-menu': ['תפריט', 'Menu'],
    'header-menu': ['אפשרויות שיחה', 'Conversation options'],
    'share-bot': ['תבנית הבוט', 'Bot template'],
  };
  for (const [id, text] of Object.entries(labels)) {
    const element = document.getElementById(id);
    if (element) {
      element.title = tr(...text);
      element.setAttribute('aria-label', tr(...text));
    }
  }
}
function voiceCanUse(mode) {
  const capabilities = VoiceCall.capabilities();
  return (
    capabilities.secure &&
    (mode === 'openai'
      ? !!capabilities.openai && !!voiceServer?.openaiAvailable
      : !!capabilities.browser)
  );
}
function voiceErrorText(error) {
  const text = String(error?.message || error || '');
  if (/not.allowed|permission.denied|permission.*dismiss|denied.*permission/i.test(text))
    return tr(
      'הגישה למיקרופון נחסמה. אפשר את המיקרופון בהרשאות האתר והתחל את השיחה מחדש.',
      'Microphone access was denied. Allow microphone access in site permissions, then start the call again.',
    );
  if (/not.found|no microphone|audio.capture/i.test(text))
    return tr(
      'לא נמצא מיקרופון זמין. חבר מיקרופון ובדוק את הגדרות הקלט.',
      'No microphone is available. Connect a microphone and check your audio input settings.',
    );
  if (/requires HTTPS|secure context/i.test(text))
    return tr(
      'גישה למיקרופון דורשת HTTPS או פתיחה מקומית דרך localhost.',
      'Microphone access requires HTTPS or localhost.',
    );
  if (/timed out/i.test(text))
    return tr(
      'החיבור הקולי לא הושלם בזמן. בדוק את ההרשאות והחיבור והתחל שוב.',
      'Voice setup timed out. Check permissions and your connection, then start again.',
    );
  return text;
}
function voiceStatusLabel(session = voiceSession) {
  if (!session) return tr('מוכנים לדבר?', 'Ready to talk?');
  if (session.ending) return tr('מסיים את השיחה…', 'Ending call…');
  if (session.error) return tr('השיחה נעצרה', 'Call stopped');
  if (session.scope.closed) return tr('השיחה הסתיימה', 'Call ended');
  if (session.transportState?.status === 'connecting') return tr('מתחבר…', 'Connecting…');
  if (session.transportState?.muted) return tr('המיקרופון מושתק', 'Microphone muted');
  if (session.transportState?.status === 'speaking') return tr('מדבר…', 'Speaking…');
  if (session.scope.pending(state?.jobs).some(job => job.status === 'waiting'))
    return tr('ממתין לאישור שלך', 'Waiting for your approval');
  if (session.submitting || session.scope.pending(state?.jobs).length)
    return tr('עובד על הבקשה שלך…', 'Working on your request…');
  return tr('מקשיב…', 'Listening…');
}
function voiceModeNote() {
  return voiceMode === 'openai'
    ? tr(
        'קול דרך OpenAI API · חיוב נפרד ממנוי ChatGPT. שימוש קולי אינו כלול במוני טוקני הטקסט. התוכן נשלח לבוט ולמודל שבחרת.',
        'Voice via OpenAI API · Billed separately from ChatGPT. Voice usage is not included in text token counters. Your selected bot and model handle the conversation.',
      )
    : tr(
        'זיהוי והקראת דיבור דרך הדפדפן. שירות הדיבור של הדפדפן עשוי לדרוש אינטרנט. הזמינות והקול בעברית תלויים בדפדפן ובמערכת.',
        'Speech recognition and playback use the browser’s speech service, which may require internet. Hebrew voice availability depends on your browser and system.',
      );
}
async function openVoicePanel() {
  closeBotModelPopover();
  voicePanelOpen = true;
  voiceMinimized = false;
  renderVoicePanel();
  if (voiceIsLive() || voiceSetupLoading) return;
  voiceSetupLoading = true;
  voiceStatusError = '';
  renderVoicePanel();
  try {
    voiceServer = await api('/api/voice/status');
    if (!voiceCanUse(voiceMode))
      voiceMode = voiceCanUse('browser') ? 'browser' : voiceCanUse('openai') ? 'openai' : 'browser';
  } catch (error) {
    voiceStatusError = error.message;
  } finally {
    voiceSetupLoading = false;
    renderVoicePanel();
  }
}
function renderVoicePanel() {
  const panel = $('#voice-panel'),
    mini = $('#voice-call-mini');
  if (!panel) return;
  const session = voiceSession,
    live = voiceIsLive(session),
    bot = session && !session.scope.closed ? botById(session.botId) : composerSettingsBot();
  const visible = voicePanelOpen && !!state && !!bot && view === 'chat';
  panel.hidden = !visible || voiceMinimized;
  mini.hidden = !visible || !voiceMinimized;
  for (const button of [$('#voice-call'), $('#header-voice-call')].filter(Boolean)) {
    button.innerHTML = icon('phone');
    button.title = tr('שיחה קולית', 'Voice call');
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('voice-launcher-active', live);
  }
  $('#dictate').disabled = live;
  $('#dictate').title = live
    ? tr('המיקרופון בשיחה הקולית', 'Microphone is in the voice call')
    : tr('הכתבה', 'Dictate');
  $('#dictate').setAttribute('aria-label', $('#dictate').title);
  if (!visible) return;
  const muted = !!session?.transportState?.muted,
    status = voiceStatusLabel(session),
    endNote = tr(
      'סיום השיחה עוצר גם משימות שהתחילו בשיחה זו.',
      'Ending the call also stops tasks started by this call.',
    );
  panel.dir = mini.dir = direction();
  panel.dataset.status = live ? session.transportState?.status || 'connecting' : 'idle';
  panel.setAttribute('aria-label', tr('שיחה קולית עם ', 'Voice call with ') + bot.name);
  if (voiceMinimized) {
    mini.innerHTML = `<button class="voice-mini-open" id="voice-expand"><span class="voice-mini-dot ${muted || !live ? 'muted' : ''}"></span><span><strong>${esc(bot.name)}</strong><small>${esc(status)} · ${tr('שיחה קולית', 'Voice call')}</small></span></button><button class="icon voice-mini-end" id="voice-mini-end" title="${esc(endNote)}" aria-label="${tr('סיום שיחה', 'End call')}">${icon('phone')}</button>`;
    $('#voice-expand').onclick = () => {
      voiceMinimized = false;
      renderVoicePanel();
    };
    $('#voice-mini-end').onclick = act(() => stopVoiceCall({ close: true }));
    return;
  }
  const canStart = !voiceSetupLoading && !session?.ending && voiceCanUse(voiceMode),
    error = session?.error || session?.taskError || voiceStatusError;
  const pending = live ? session.scope.pending(state.jobs) : [],
    waiting = pending.some(job => job.status === 'waiting');
  panel.innerHTML = `<div class="voice-heading">${avatar(bot)}<div><h2 id="voice-heading">${esc(bot.name)}</h2><p>${esc(providerName(botProvider(bot)))} · ${tr('שיחה קולית', 'Voice call')}</p></div>${live ? `<button class="icon" id="voice-minimize" title="${tr('מזעור השיחה', 'Minimize call')}" aria-label="${tr('מזעור השיחה', 'Minimize call')}">${icon('minimize')}</button>` : ''}<button class="icon" id="voice-close" title="${esc(live ? endNote : tr('סגירה', 'Close'))}" aria-label="${tr(live ? 'סיום וסגירה' : 'סגירה', live ? 'End and close' : 'Close')}">${icon('close')}</button></div>
    <div class="voice-orb-wrap" aria-hidden="true"><div class="voice-orb"></div></div><p class="voice-status" role="status">${esc(status)}</p><p class="voice-substatus">${live ? tr('אפשר לדבר באופן טבעי', 'Speak naturally') : tr('הקול יישלח לבוט שנבחר בשיחה', 'Your voice goes to the bot selected in this chat')}</p>
    ${!live ? `<label for="voice-mode">${tr('חיבור קולי', 'Voice connection')}</label><select id="voice-mode" ${voiceSetupLoading || session?.ending ? 'disabled' : ''}><option value="browser" ${voiceMode === 'browser' ? 'selected' : ''}>${tr('דיבור דרך הדפדפן', 'Browser speech')}</option><option value="openai" ${voiceMode === 'openai' ? 'selected' : ''}>OpenAI Realtime · API</option></select>` : ''}
    <p class="voice-mode-note">${esc(voiceModeNote())}</p>
    ${!live && !voiceCanUse(voiceMode) && !voiceSetupLoading ? `<p class="voice-error">${voiceMode === 'openai' ? tr('נדרש מפתח OpenAI API בהגדרות ← מודלים וחיבורים, ודפדפן עם מיקרופון ו־WebRTC.', 'Add an OpenAI API key in Settings → Models & connections, and use a browser with microphone and WebRTC support.') : tr('זיהוי דיבור אינו נתמך בדפדפן זה. נסה Chrome או Edge, או בחר OpenAI Realtime עם מפתח API. חיבור מרוחק דורש HTTPS.', 'Speech recognition is unavailable in this browser. Try Chrome or Edge, or choose OpenAI Realtime with an API key. Remote access requires HTTPS.')}</p>` : ''}
    ${error ? `<p class="voice-error" role="alert">${esc(error)}</p>` : ''}
    ${live ? `<div class="voice-controls"><button class="voice-control" id="voice-mute" aria-pressed="${muted}" ${session.transportState?.status === 'connecting' ? 'disabled' : ''}><span>${icon(muted ? 'micOff' : 'mic')}</span>${tr(muted ? 'ביטול השתקה' : 'השתקה', muted ? 'Unmute' : 'Mute')}</button><button class="voice-control" id="voice-interrupt"><span>${icon('stop')}</span>${tr('הפסקת הקראה', 'Interrupt')}</button><button class="voice-control end" id="voice-end" title="${esc(endNote)}"><span>${icon('phone')}</span>${tr('סיום', 'End call')}</button></div><p class="voice-end-note">${esc(endNote)}</p>` : `<button class="primary voice-start" id="voice-start" ${canStart ? '' : 'disabled'}>${icon('phone')}${tr(voiceSetupLoading ? 'בודק חיבור…' : 'התחלת שיחה', voiceSetupLoading ? 'Checking connection…' : 'Start call')}</button>`}
    ${waiting ? `<button class="secondary voice-approval" id="voice-approval">${tr('יש פעולה שממתינה לאישור — הצג בשיחה', 'An action needs approval — show in chat')}</button>` : ''}
    ${session?.transcript || session?.reply ? `<div class="voice-transcript">${session.transcript ? `<p dir="auto"><strong>${tr('אתה', 'You')}</strong>${esc(session.transcript)}</p>` : ''}${session.reply ? `<p dir="auto"><strong>${esc(bot.name)}</strong>${esc(session.reply)}</p>` : ''}</div>` : ''}`;
  $('#voice-close').onclick = act(() => stopVoiceCall({ close: true }));
  if ($('#voice-mode'))
    $('#voice-mode').onchange = e => {
      voiceMode = e.target.value;
      voiceStatusError = '';
      if (voiceSession?.scope.closed) voiceSession = null;
      renderVoicePanel();
    };
  if ($('#voice-start')) $('#voice-start').onclick = act(startVoiceCall);
  if ($('#voice-minimize'))
    $('#voice-minimize').onclick = () => {
      voiceMinimized = true;
      renderVoicePanel();
    };
  if ($('#voice-mute'))
    $('#voice-mute').onclick = act(() =>
      session.transport.setMuted(!session.transportState?.muted),
    );
  if ($('#voice-interrupt'))
    $('#voice-interrupt').onclick = act(() => session.transport.interrupt());
  if ($('#voice-end')) $('#voice-end').onclick = act(() => stopVoiceCall());
  if ($('#voice-approval'))
    $('#voice-approval').onclick = () => {
      voiceMinimized = true;
      renderVoicePanel();
      $('#pending-approvals').scrollIntoView({ block: 'center' });
      $('#pending-approvals').querySelector('button,input')?.focus();
    };
}
async function startVoiceCall() {
  if (voiceIsLive() || !voiceCanUse(voiceMode)) return;
  const bot = composerSettingsBot();
  if (!bot || !activeChat()) return;
  dictation?.abort();
  dictation = null;
  const session = {
    botId: bot.id,
    chatId,
    provider: botProvider(bot),
    language: state.settings.language,
    scope: new VoiceTaskScope({ chatId, botId: bot.id }),
    transportState: { status: 'connecting' },
    submitChain: Promise.resolve(),
    replyChain: Promise.resolve(),
    transcript: '',
    reply: '',
    error: '',
    submitting: false,
    ending: false,
  };
  voiceSession = session;
  voicePanelOpen = true;
  voiceMinimized = false;
  session.transport = new VoiceCall({
    api: (url, data, options = {}) => api(url, data, undefined, options),
    onState: update => {
      session.transportState = update;
      if (session !== voiceSession) return;
      if (update.status === 'error' && !session.ending && !session.scope.closed) {
        session.error =
          voiceErrorText(update.error) ||
          tr('לא ניתן להמשיך את השיחה הקולית.', 'The voice call could not continue.');
        void stopVoiceCall().catch(error => toast(error.message));
      }
      renderVoicePanel();
    },
    onTranscript: text => submitVoiceTranscript(session, text),
    onSpeechStart: () => {
      if (voiceIsLive(session)) session.transport.interrupt();
    },
  });
  renderVoicePanel();
  try {
    await session.transport.start({
      mode: voiceMode,
      language: session.language,
      botId: session.botId,
    });
  } catch (error) {
    session.error = voiceErrorText(error);
    await stopVoiceCall();
  }
  renderVoicePanel();
}
async function cancelVoiceRoots(roots, { unload = false } = {}) {
  const unique = [...new Set(roots)];
  const results = await Promise.allSettled(
    unique.map(id =>
      unload
        ? fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', 'X-StellarCortex-Client': '1' },
            body: JSON.stringify({ tree: true }),
          })
        : api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { tree: true }),
    ),
  );
  const failed = results.find(result => result.status === 'rejected');
  if (failed && !unload) throw failed.reason;
}
function submitVoiceTranscript(session, text) {
  text = String(text || '').trim();
  if (!text || session !== voiceSession || !voiceIsLive(session)) return;
  const turn = session.scope.beginUtterance();
  session.transport.interrupt();
  session.transcript = text;
  session.reply = '';
  session.error = '';
  session.taskError = '';
  session.submitting = true;
  renderVoicePanel();
  session.submitChain = session.submitChain
    .catch(() => {})
    .then(async () => {
      await cancelVoiceRoots(turn.roots);
      if (!session.scope.current(turn.generation)) return;
      const result = await api(`/api/chats/${session.chatId}/messages`, {
        text,
        botIds: [session.botId],
        attachments: [],
      });
      const accepted = session.scope.accept(result.jobs, turn.generation);
      if (!accepted.accepted) {
        await cancelVoiceRoots(accepted.roots);
        return;
      }
      await refresh();
    })
    .catch(error => {
      if (session.scope.current(turn.generation)) {
        session.error = error.message;
        void stopVoiceCall().catch(problem => toast(problem.message));
      }
    })
    .finally(() => {
      if (session.scope.current(turn.generation)) session.submitting = false;
      renderVoicePanel();
    });
}
function processVoiceReplies() {
  const session = voiceSession;
  if (!voiceIsLive(session) || !state) return;
  const failed = state.jobs.find(
    job =>
      session.scope.owns(job) &&
      job.botId === session.botId &&
      ['failed', 'interrupted'].includes(job.status),
  );
  if (failed)
    session.taskError =
      tr(
        'הבוט לא הצליח להשלים את הבקשה. אפשר לנסות שוב: ',
        'The bot could not finish the request. You can try again: ',
      ) + (withoutProgramOutput(failed.error, tr) || statusLabel(failed.status));
  for (const reply of session.scope.takeReplies(state.jobs, state.messages)) {
    session.replyChain = session.replyChain
      .catch(() => {})
      .then(async () => {
        if (session !== voiceSession || !session.scope.current(reply.generation)) return;
        session.reply = reply.text;
        renderVoicePanel();
        await session.transport.speak(reply.text);
      })
      .catch(error => {
        if (session.scope.current(reply.generation)) {
          session.error = error.message;
          void stopVoiceCall().catch(problem => toast(problem.message));
        }
      });
  }
  renderVoicePanel();
}
async function stopVoiceCall({ close = false, cancel = true, unload = false } = {}) {
  const session = voiceSession;
  if (close) {
    voicePanelOpen = false;
    voiceMinimized = false;
  }
  if (!session || session.ending || session.scope.closed) {
    renderVoicePanel();
    return;
  }
  session.ending = true;
  const roots = session.scope.close();
  renderVoicePanel();
  const stopping = session.transport.stop();
  try {
    await Promise.all([stopping, cancel ? cancelVoiceRoots(roots, { unload }) : Promise.resolve()]);
  } catch (error) {
    session.error =
      tr(
        'המיקרופון נסגר, אבל לא ניתן לאשר שכל המשימות נעצרו: ',
        'The microphone is closed, but some tasks may still be running: ',
      ) + error.message;
    if (!unload) toast(session.error);
  } finally {
    session.ending = false;
    renderVoicePanel();
  }
}
function reconcileVoiceContext() {
  const session = voiceSession;
  if (!voiceIsLive(session)) return;
  const bot = botById(session.botId);
  if (
    !state ||
    view !== 'chat' ||
    chatId !== session.chatId ||
    !bot ||
    bot.deletedAt ||
    composerSettingsBot()?.id !== session.botId ||
    state.settings.language !== session.language ||
    botProvider(bot) !== session.provider
  )
    void stopVoiceCall({ close: true });
}
window.addEventListener('pageshow', event => {
  if (event.persisted && state) connectEvents();
});
window.addEventListener('pagehide', () => {
  source?.close();
  dictation?.abort();
  void stopVoiceCall({ close: true, unload: true });
});
function renderProviderNotice() {
  const provider = botProvider(composerSettingsBot()),
    notice = $('#runtime-notice');

  if (provider === 'codex') {
    notice.hidden = state.runtime.connected;
    if (!notice.hidden)
      notice.textContent =
        withoutProgramOutput(state.runtime.error, tr) ||
        tr('מתחבר למנוע Codex…', 'Connecting to Codex…');
    return;
  }
  const connection = providerAccount(provider),
    available = state.providers?.find(item => item.id === provider)?.available;
  notice.hidden = !!connection?.connected && available !== false;
  if (!notice.hidden)
    notice.textContent =
      withoutProgramOutput(connection?.error, tr) ||
      tr(
        'כדי להפעיל בוט באמצעות ' + providerName(provider) + ', השלם את החיבור בהגדרות.',
        'To run a bot using ' + providerName(provider) + ', complete its connection in Settings.',
      );
}
function renderSidebar() {
  $('#search').innerHTML = icon('search');
  $('#search').title = tr('חיפוש · Ctrl K', 'Search · Ctrl K');
  $('#search').setAttribute('aria-label', tr('חיפוש', 'Search'));
  const visible = state.chats.filter(
    c =>
      !c.kanbanCardId && chatAvailable(c) && (c.type === 'group' || !botById(c.botIds[0])?.hidden),
  );
  const renderRow = c => {
    const last = state.messages.filter(m => m.chatId === c.id && !['tool'].includes(m.role)).at(-1);
    const jobs = state.jobs.filter(
      j => j.chatId === c.id && ['running', 'waiting', 'queued'].includes(j.status),
    );
    return `<div class="bot-row-wrap"><button class="bot-row ${view === 'chat' && c.id === chatId ? 'active' : ''}" data-chat="${c.id}">${chatAvatar(c)}<span class="bot-info"><span class="bot-name"><span>${esc(c.name)}</span></span><span class="bot-preview" dir="auto">${esc(jobs.length ? (jobs.some(j => j.status === 'waiting') ? tr('ממתין לתשובה שלך', 'Needs your attention') : tr('עובד על המשימה…', 'Working on it…')) : (last?.kind === 'error' ? chatErrorText(last.text, tr).text : last?.text) || (c.type === 'direct' ? botById(c.botIds[0])?.title : tr('שיחה קבוצתית', 'Group conversation')))}</span></span>${c.unread && c.id !== chatId ? '<i class="unread"></i>' : ''}</button><button class="icon bot-row-menu" data-chat-menu="${c.id}" title="${esc(tr('אפשרויות שיחה', 'Conversation options'))}" aria-label="${esc(tr(`אפשרויות ${c.name}`, `${c.name} options`))}" aria-haspopup="menu">⋯</button></div>`;
  };
  const pinned = visible.filter(c => c.type === 'direct' && botById(c.botIds[0])?.pinned),
    rest = visible.filter(c => !pinned.includes(c));
  const sections = [
    ...new Set(rest.map(c => (c.type === 'direct' ? botById(c.botIds[0]).section || '' : ''))),
  ];
  const hidden = state.chats.filter(
    c => !c.kanbanCardId && c.type === 'direct' && chatAvailable(c) && botById(c.botIds[0])?.hidden,
  );
  $('#bot-list').innerHTML =
    (pinned.length
      ? `<div class="section-label">${tr('מוצמדים', 'PINNED')}</div>${pinned.map(renderRow).join('')}`
      : '') +
    sections
      .map(
        section =>
          `<div class="section-label">${esc(section || tr('הבוטים שלך', 'YOUR BOTS'))}<span>${rest.filter(c => (c.type === 'direct' ? botById(c.botIds[0]).section || '' : '') === section).length}</span></div>${rest
            .filter(
              c => (c.type === 'direct' ? botById(c.botIds[0]).section || '' : '') === section,
            )
            .map(renderRow)
            .join('')}`,
      )
      .join('') +
    (hidden.length
      ? `<details class="hidden-bots" ${localStorage.getItem('stellarcortex-hidden-open') === 'true' ? 'open' : ''}><summary>${tr('בוטים מוסתרים', 'Hidden bots')} <span>${hidden.length}</span></summary>${hidden.map(renderRow).join('')}</details>`
      : '');
  $('#bot-list')
    .querySelectorAll('[data-chat]')
    .forEach(b => {
      b.onclick = act(() => openChat(b.dataset.chat));
      b.oncontextmenu = e => {
        e.preventDefault();
        conversationMenu(
          state.chats.find(c => c.id === b.dataset.chat),
          e,
        );
      };
    });
  $('#bot-list')
    .querySelectorAll('[data-chat-menu]')
    .forEach(
      b =>
        (b.onclick = () =>
          conversationMenu(
            state.chats.find(c => c.id === b.dataset.chatMenu),
            b,
          )),
    );
  $('#bot-list .hidden-bots')?.addEventListener('toggle', e =>
    localStorage.setItem('stellarcortex-hidden-open', String(e.target.open)),
  );
  $('#navigation').innerHTML =
    `<button class="nav-item ${view === 'apps' ? 'active' : ''}" id="connect-apps-nav">${icon('grid')}${tr('חיבור אפליקציות', 'Connect apps')}</button><button class="nav-item ${view === 'tasks' ? 'active' : ''}" id="tasks-nav">${icon('check')}${tr('קנבן', 'Kanban')}</button><button class="nav-item" id="more-nav" aria-haspopup="menu">${icon('menu')}${tr('עוד', 'More')}</button>`;
  $('#tasks-nav').onclick = () => navigateWorkspace('tasks');
  $('#connect-apps-nav').onclick = () => navigateWorkspace('apps');
  $('#more-nav').onclick = () => workspaceMenu($('#more-nav'));
  $('#account').innerHTML =
    `<span class="account-circle">A</span><span style="flex:1">${esc(account?.account?.email?.split('@')[0] || tr('סביבת העבודה שלי', 'My workspace'))}<small class="muted" style="display:block;font-size:10px"><i class="connection-dot ${account?.account?.type === 'chatgpt' ? '' : 'off'}"></i>${account?.account?.type === 'chatgpt' ? `ChatGPT ${esc(account.account.planType || '')}` : tr('חיבור חשבון OpenAI', 'Connect OpenAI account')}</small></span>${icon('settings')}`;
  design.sidebar();
}
function renderHeader() {
  const c = activeChat();
  const names = {
    tasks: tr('קנבן', 'Kanban'),
    projects: tr('קנבן', 'Kanban'),
    team: tr('הצוות', 'Team'),
    teamtalk: tr('שיחות הבוטים', 'Bot conversations'),
    library: tr('ספרייה', 'Library'),
    routines: tr('שגרות', 'Routines'),
    skills: tr('מיומנויות', 'Skills'),
    apps: tr('חיבור אפליקציות', 'Connect apps'),
    activity: tr('פעילות', 'Activity'),
  };
  $('#header').innerHTML =
    `<button class="icon mobile-menu" id="mobile-menu" aria-label="Menu">${icon('menu')}</button>${view === 'chat' && c ? chatAvatar(c) : ''}<button class="header-title" id="header-name">${esc(view === 'chat' ? c?.name : names[view])}${view === 'chat' ? `<small>${c?.type === 'group' ? `${c.botIds.filter(id => !botById(id)?.deletedAt).length} ${tr('בוטים', 'teammates')}` : esc(activeBot()?.title || '')}</small>` : ''}</button><div class="header-right">${view === 'chat' && c ? `<button class="icon" id="header-voice-call" title="${tr('שיחה קולית', 'Voice call')}" aria-label="${tr('שיחה קולית', 'Voice call')}">${icon('phone')}</button><button class="icon" id="show-computer" title="${tr('מחשב', 'Computer')}" aria-label="${tr('מחשב', 'Computer')}">${icon('computer')}</button><button class="icon" id="show-details" title="Details" aria-label="Details">${icon('info')}</button>${c.type === 'direct' ? `<button class="icon" id="share-bot" title="${tr('תבנית הבוט', 'Bot template')}" aria-label="Bot template" aria-haspopup="menu">${icon('link')}</button>` : ''}<button class="icon" id="header-menu" title="${tr('אפשרויות שיחה', 'Conversation options')}" aria-label="Conversation options" aria-haspopup="menu">⋯</button>` : ''}</div>`;
  $('#mobile-menu').onclick = () => $('#sidebar').classList.toggle('open');
  $('#header-name').onclick = () => {
    if (view === 'chat') {
      details = !details;
      if (!['media', 'computer', 'routines'].includes(detailTab)) detailTab = 'media';
      render();
    }
  };
  if (view === 'chat' && c) {
    $('#header-voice-call').onclick = act(openVoicePanel);
    $('#show-computer').onclick = () => {
      details = true;
      detailTab = 'computer';
      render();
    };
    $('#show-details').onclick = () => {
      details = !details;
      render();
    };
    $('#header-menu').onclick = () => conversationMenu(c, $('#header-menu'));
    if ($('#share-bot')) $('#share-bot').onclick = () => templateMenu(activeBot(), $('#share-bot'));
  }
}
function markdown(text) {
  let safe = esc(text);
  safe = safe
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  return safe;
}
function closeWorkspaceMenu() {
  const menu = $('#workspace-popover');
  if (menu) {
    menu.cleanup?.();
    menu.remove();
  }
}
function showWorkspaceMenu(items, anchor) {
  closeWorkspaceMenu();
  const menu = document.createElement('div');
  menu.id = 'workspace-popover';
  menu.className = 'workspace-popover';
  menu.dir = direction();
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items
    .map((item, i) =>
      item.separator
        ? '<div class="menu-separator" role="separator"></div>'
        : `<button role="menuitem" class="${item.danger ? 'menu-danger' : ''}" data-menu-index="${i}">${icon(item.icon || 'info')}<span>${esc(item.label)}</span>${item.checked ? icon('check') : ''}</button>`,
    )
    .join('');
  document.body.append(menu);
  const rect = anchor?.getBoundingClientRect?.();
  const x = rect ? rect.left : anchor?.clientX || 12,
    y = rect ? rect.bottom + 6 : anchor?.clientY || 70;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  const outside = e => {
    if (!menu.contains(e.target) && e.target !== anchor) closeWorkspaceMenu();
  };
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', closeWorkspaceMenu);
  menu.cleanup = () => {
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', closeWorkspaceMenu);
  };
  menu.querySelectorAll('button').forEach(
    button =>
      (button.onclick = act(async () => {
        const item = items[Number(button.dataset.menuIndex)];
        closeWorkspaceMenu();
        await item.action();
      })),
  );
  menu.onkeydown = e => {
    const buttons = [...menu.querySelectorAll('button')],
      index = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeWorkspaceMenu();
      anchor?.focus?.();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[
        (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ]?.focus();
    }
  };
  menu.querySelector('button')?.focus();
}
function navigateWorkspace(destination) {
  void stopVoiceCall({ close: true });
  closeWorkspaceMenu();
  view = destination;
  computerExpanded = false;
  $('#sidebar').classList.remove('open');
  render();
}
function workspaceMenu(anchor) {
  showWorkspaceMenu(
    [
      { label: tr('הצוות', 'Team'), icon: 'grid', action: () => navigateWorkspace('team') },
      {
        label: tr('ספרייה', 'Library'),
        icon: 'library',
        action: () => navigateWorkspace('library'),
      },
      {
        label: tr('שגרות', 'Routines'),
        icon: 'clock',
        action: () => navigateWorkspace('routines'),
      },
      {
        label: tr('מיומנויות', 'Skills'),
        icon: 'spark',
        action: () => navigateWorkspace('skills'),
      },
      {
        label: tr('פעילות', 'Activity'),
        icon: 'activity',
        action: () => navigateWorkspace('activity'),
      },
      { separator: true },
      { label: tr('סל מחזור', 'Trash'), icon: 'close', action: trashView },
    ],
    anchor,
  );
}
async function continueInNewConversation(chat) {
  if (
    !confirm(
      tr(
        'לשלוח שוב את ההודעה האחרונה שלך בשיחה חדשה ונקייה? ההודעות הקודמות יישארו לקריאה, אבל הבוט לא יראה אותן.',
        'Send your last message again in a clean new conversation? The earlier messages stay readable, but the bot will not see them.',
      ),
    )
  )
    return;
  await api(`/api/chats/${chat.id}/continue`, {});
  if (chatId === chat.id) {
    replyToId = null;
    renderReplyContext();
  }
  await refresh();
}
async function openConversationDetails(chat, tab = 'media', botId = null) {
  await openChat(chat.id);
  details = true;
  detailTab = tab;
  computerExpanded = false;
  if (botId) detailBotId = botId;
  render();
}
function conversationMenu(chat, anchor) {
  if (!chat) return;
  const bot = chat.type === 'direct' ? botById(chat.botIds[0]) : null;
  const items = [
    {
      label: tr('הצגת פרטי השיחה', 'View conversation details'),
      icon: 'info',
      action: () => openConversationDetails(chat),
    },
  ];
  const clear = chat.kanbanCardId
    ? []
    : [
        ...(chat.externalContent
          ? [
              {
                label: tr('המשך בשיחה חדשה', 'Continue in a new conversation'),
                icon: 'plus',
                action: () => continueInNewConversation(chat),
              },
            ]
          : []),
        {
          label: tr('ניקוי השיחה…', 'Clear conversation…'),
          icon: 'close',
          danger: true,
          action: async () => {
            if (
              !confirm(
                tr(
                  `לנקות את השיחה "${chat.name}"? כל ההודעות יימחקו והבוט לא יזכור אותן. אי אפשר לבטל את הפעולה. הזיכרון והקבצים של הבוט יישמרו.`,
                  `Clear the conversation "${chat.name}"? All messages will be deleted and the bot will not remember them. This cannot be undone. The bot's memory and files are kept.`,
                ),
              )
            )
              return;
            await api(`/api/chats/${chat.id}/clear`, {});
            if (chatId === chat.id) {
              replyToId = null;
              renderReplyContext();
            }
            await refresh();
            toast(tr('השיחה נוקתה.', 'Conversation cleared.'));
          },
        },
      ];
  if (chat.type === 'group')
    items.push({
      label: tr('עריכת שם וחברי הקבוצה', 'Edit group name and members'),
      icon: 'edit',
      action: () => groupForm(chat),
    });
  if (bot)
    items.push({
      label: tr('מודל וביצועים', 'Model settings'),
      icon: 'spark',
      action: () => botForm(bot, true),
    });
  if (bot)
    items.push({
      label: tr('ייצוא תבנית הבוט', 'Export bot template'),
      icon: 'download',
      action: () => exportBotTemplate(bot),
    });
  if (bot)
    items.push({
      label: bot.pinned ? tr('ביטול הצמדה', 'Unpin') : tr('הצמדה', 'Pin'),
      icon: 'pin',
      action: async () => {
        await api(`/api/bots/${bot.id}`, { pinned: !bot.pinned }, 'PATCH');
        await refresh();
      },
    });
  items.push({
    label: tr('סימון כנקרא', 'Mark as read'),
    icon: 'check',
    action: async () => {
      await api(`/api/chats/${chat.id}/read`, {});
      await refresh();
    },
  });
  if (bot)
    items.push(
      {
        label: tr('העברה למקטע…', 'Move to section…'),
        icon: 'grid',
        action: () => sectionForm(bot),
      },
      {
        label: bot.hidden
          ? tr('הצגה בסרגל הצד', 'Show in sidebar')
          : tr('הסתרה מסרגל הצד', 'Hide from sidebar'),
        icon: 'menu',
        action: async () => {
          await api(`/api/bots/${bot.id}`, { hidden: !bot.hidden }, 'PATCH');
          await refresh();
        },
      },
      { separator: true },
      {
        label: tr('זיכרון הבוט', 'Bot memory'),
        icon: 'spark',
        action: () => openConversationDetails(chat, 'memory', bot.id),
      },
      {
        label: tr('צוות ומשימות שהועברו', 'Team and delegated tasks'),
        icon: 'activity',
        action: () => openConversationDetails(chat, 'team', bot.id),
      },
      { separator: true },
      ...clear,
      {
        label: tr('מחיקת בוט…', 'Delete bot…'),
        icon: 'close',
        danger: true,
        action: () => deleteBotConfirm(bot),
      },
    );
  else if (clear.length) items.push({ separator: true }, ...clear);
  showWorkspaceMenu(items, anchor);
}
function sectionForm(bot) {
  const sections = [
    ...new Set(state.bots.filter(b => !b.deletedAt && b.section).map(b => b.section)),
  ];
  modal(
    tr('העברה למקטע', 'Move to section'),
    `<form id="section-form"><p class="small muted">${esc(bot.name)}</p><label>${tr('מקטע קיים או חדש', 'Existing or new section')}</label><input name="section" list="sidebar-sections" maxlength="80" value="${esc(bot.section || '')}"><datalist id="sidebar-sections">${sections.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist><p class="small muted">${tr('השאר ריק כדי להחזיר לרשימת הבוטים.', 'Leave empty to return to the default bot list.')}</p><div class="actions"><button class="primary">${tr('העברה', 'Move')}</button></div></form>`,
  );
  $('#section-form').onsubmit = act(async e => {
    e.preventDefault();
    await api(
      `/api/bots/${bot.id}`,
      { section: String(new FormData(e.target).get('section')).trim() },
      'PATCH',
    );
    await refresh();
    $('#modal').close();
  });
}
async function exportBotTemplate(bot) {
  const template = await api(`/api/bots/${bot.id}/template`);
  download(`${bot.name}-template.json`, JSON.stringify(template, null, 2));
}
function templateMenu(bot, anchor) {
  if (!bot) return;
  showWorkspaceMenu(
    [
      {
        label: tr('ייצוא תבנית הבוט', 'Export bot template'),
        icon: 'download',
        action: () => exportBotTemplate(bot),
      },
    ],
    anchor,
  );
}
function handoffSummary(rootId) {
  const jobs = state.jobs.filter(
      j => j.parentJobId && !j.resultForJobId && (j.rootJobId || j.parentJobId) === rootId,
    ),
    ids = new Set(jobs.map(j => j.id));
  const replies = state.messages.filter(m => m.role === 'assistant' && ids.has(m.jobId) && m.text);
  const participants = [...new Set(jobs.map(j => j.botId))].map(botById).filter(Boolean),
    count = jobs.length + replies.length;
  return `<button class="handoff-summary" data-conversation-root="${rootId}" aria-label="${esc(tr('פתיחת ההודעות בין הבוטים', 'Open messages between bots'))}"><span>${count} ${tr('הודעות עם', 'messages with')}</span>${participants
    .slice(0, 3)
    .map(b => `<span class="handoff-participant">${avatar(b)}<span>${esc(b.name)}</span></span>`)
    .join(
      '',
    )}${participants.length > 3 ? `<span>+${participants.length - 3}</span>` : ''}<span class="handoff-chevron">›</span></button>`;
}
function bindTeamTranscript(el) {
  el.querySelectorAll('[data-task]').forEach(b => (b.onclick = () => taskDetails(b.dataset.task)));
  el.querySelectorAll('[data-exchange-chat]').forEach(
    b =>
      (b.onclick = act(async () => {
        $('#modal').close();
        await openChat(b.dataset.exchangeChat);
      })),
  );
}
function inspectBotConversation(rootId) {
  teamRootFilter = rootId;
  modal(tr('הודעות בין הבוטים', 'Messages between bots'), teamConversationMarkup(true), true);
  $('#modal').dataset.kind = 'bot-conversation';
  $('#modal').dataset.root = rootId;
  bindTeamTranscript($('#modal-body'));
  $('#modal-body').scrollTop = $('#modal-body').scrollHeight;
}
function refreshBotConversation() {
  const dialog = $('#modal');
  if (!dialog.open || dialog.dataset.kind !== 'bot-conversation') return;
  const el = $('#modal-body'),
    nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100,
    scroll = el.scrollTop;
  teamRootFilter = dialog.dataset.root;
  el.innerHTML = teamConversationMarkup(true);
  bindTeamTranscript(el);
  el.scrollTop = nearBottom ? el.scrollHeight : scroll;
}
function renderReplyContext() {
  const el = $('#reply-context'),
    message = state?.messages.find(m => m.id === replyToId);
  el.hidden = !message;
  if (!message) return;
  el.innerHTML = `<div><strong>${tr('תשובה ל־', 'Reply to ')}${esc(message.botId ? botById(message.botId)?.name : tr('ההודעה שלך', 'your message'))}</strong><span dir="auto">${esc(message.text.slice(0, 130))}</span></div><button class="icon" id="clear-reply" type="button" title="${tr('ביטול תשובה', 'Cancel reply')}" aria-label="${tr('ביטול תשובה', 'Cancel reply')}">×</button>`;
  $('#clear-reply').onclick = () => {
    replyToId = null;
    renderReplyContext();
  };
}
// Unknown until its account is read, and then the first screen updates.
const providerConnected = provider => {
  const connection = providerAccount(provider);
  return !!(connection?.connected || connection?.account);
};
function providerReady(bot) {
  const provider = botProvider(bot);
  return !providerAccount(provider) || providerConnected(provider);
}
const connectedProvider = () =>
  ['codex', 'claude', 'openai-api', 'anthropic-api', 'local'].find(providerConnected);
function renderConversation() {
  const el = $('#content'),
    nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120,
    changed = el.dataset.chat !== chatId || el.dataset.view !== 'chat';
  el.dataset.chat = chatId;
  el.dataset.view = 'chat';
  const msgs = state.messages.filter(m => m.chatId === chatId),
    shownHandoffs = new Set();
  const bot = activeBot();
  if (!msgs.length) {
    el.innerHTML = `<div class="empty-state" dir="${direction()}">${avatar(bot, 'huge')}${providerReady(bot) ? '' : `<div class="first-step"><strong>${tr('צעד ראשון: חברו ספק מודלים', 'First step: connect a model provider')}</strong><p>${tr('חשבון אצל ספק, מפתח API או מודל מקומי. לפני החיבור בדקו את תנאי השימוש של הספק.', 'A provider account, an API key or a local model. Check the provider’s terms of use before you connect.')}</p>${connectedProvider() ? `<button class="primary" type="button" data-use-provider="${esc(connectedProvider())}">${tr('הבוט ישתמש ב־', 'Use ')}${esc(providerName(connectedProvider()))}${tr('', ' for this bot')}</button> ` : ''}<button class="${connectedProvider() ? 'secondary' : 'primary'}" type="button" data-open-connections>${tr('חיבור ספק', 'Connect a provider')}</button></div>`}<h1>${tr('יש לך למי להעביר את העבודה.', 'A little more off your plate.')}</h1><p>${tr(`זה ${esc(bot?.name || 'Stellar')}. ספר לו מה צריך לקרות, תן לו הקשר, ותוכל לחזור לכאן כשהתוצאה מוכנה.`, `Meet ${esc(bot?.name || 'Stellar')}. Give your teammate a job, share the context, and come back to work that’s done.`)}</p><div class="suggestions"><button class="suggestion" data-prompt="${tr('עזור לי לתכנן את השבוע. שאל אותי קודם מה המשימות החשובות.', 'Help me plan this week. First ask about my priorities.')}">${tr('לעשות סדר בשבוע', 'Plan my week')}<span>${tr('מתחילים ממה שחשוב', 'Start with what matters')}</span></button><button class="suggestion" data-prompt="${tr('אני רוצה מחקר בנושא. שאל אותי מה הנושא ומה התוצר שאני צריך.', 'Help me research a topic. Ask what I need to find out.')}">${tr('לחקור נושא לעומק', 'Research something')}<span>${tr('מידע, מקורות ותוצאה ברורה', 'Sources, context, a clear result')}</span></button><button class="suggestion" data-prompt="${tr('בוא נבנה כלי קטן. שאל אותי איזו בעיה הוא צריך לפתור.', 'Let’s build a small tool. Ask what problem it should solve.')}">${tr('לבנות משהו שימושי', 'Build something useful')}<span>${tr('מרעיון לכלי שעובד', 'Turn an idea into a working tool')}</span></button><button class="suggestion" data-prompt="${tr('זכור שאני מעדיף תשובות בעברית, קצרות ומעשיות.', 'Remember that I prefer concise, practical answers.')}">${tr('ללמד אותך איך אני עובד', 'Get to know how I work')}<span>${tr('העדפות שנשמרות לפעם הבאה', 'Preferences that stay with you')}</span></button></div></div>`;
    el.querySelectorAll('[data-prompt]').forEach(
      b =>
        (b.onclick = () => {
          $('#prompt').value = b.dataset.prompt;
          $('#prompt').focus();
        }),
    );
    return;
  }
  el.innerHTML = `<div class="conversation">${msgs
    .map(m => {
      if (m.role === 'tool')
        return `<details class="tool-entry"><summary>${esc(toolLabel(m))} · ${esc(statusLabel(m.status))}</summary>${renderToolDetails(m.detail || m.text, { tr, fallbackCommand: m.kind === 'commandExecution' ? m.text : '' })}</details>`;
      if (
        m.role === 'system' &&
        ['handoff', 'handoff-result'].includes(m.kind) &&
        activeChat()?.type === 'direct' &&
        ((m.kind === 'handoff' && m.sourceChatId === chatId) ||
          (m.kind === 'handoff-result' && m.targetChatId === chatId))
      ) {
        const child = state.jobs.find(j => j.id === (m.childJobId || m.jobId)),
          root = m.rootJobId || child?.rootJobId || m.relatedJobId;
        if (root) {
          if (shownHandoffs.has(root)) return '';
          shownHandoffs.add(root);
          return handoffSummary(root);
        }
      }
      if (m.role === 'system' && ['handoff', 'handoff-result', 'team'].includes(m.kind))
        return `<div class="team-message ${m.kind}" dir="auto"><strong>${m.kind === 'handoff-result' ? tr('תוצאה מהצוות', 'Team result') : m.kind === 'handoff' ? tr('העברת משימה', 'Task handoff') : tr('עדכון בצוות', 'Team update')}</strong><div>${markdown(m.text)}</div>${m.jobId ? `<button class="secondary" data-task="${m.jobId}">${tr('פרטי המשימה', 'Task details')}</button>` : ''}</div>`;
      if (m.role === 'system' && m.kind === 'error') {
        const shown = chatErrorText(m.text, tr);
        return `<div class="message system error" dir="${direction()}">${esc(shown.text)}${shown.action ? ` <button class="secondary" type="button" data-open-connections>${tr('חיבור ספק', 'Connect a provider')}</button>` : ''}${shown.detail ? `<details><summary>${tr('פרטים', 'Details')}</summary><span dir="auto">${esc(shown.detail)}</span></details>` : ''}</div>`;
      }
      if (m.role === 'system')
        return `<div class="message system" dir="auto">${m.kind === 'artifact' ? `<button class="secondary" data-artifact="${m.artifactId}">${icon('library')} ${esc(m.text)}</button>` : m.kind === 'external-block' ? `${esc(tr('בשיחה הזו נקרא תוכן חיצוני, ולכן פקודות מעטפת ושינויי קבצים חסומים כאן. הוראות שבתוך התוכן הזה אינן מבוצעות. כדי להמשיך עם פעולות, בחרו "המשך בשיחה חדשה" כאן או בתפריט ⋯ של השיחה: ההודעה האחרונה שלכם תישלח שוב בשיחה נקייה, וההודעות הקודמות יישארו לקריאה. אפשר גם ⋯ ← "ניקוי השיחה…", שמוחק את ההודעות.', 'External content was read in this conversation, so shell commands and file changes are blocked here. Instructions inside that content are not followed. To continue with actions, choose "Continue in a new conversation" here or in the ⋯ conversation menu: your last message is sent again in a clean conversation, and the old messages stay readable. Or ⋯ → "Clear conversation…", which deletes the messages.'))}${activeChat()?.externalContent && !activeChat()?.kanbanCardId ? ` <button class="secondary" type="button" data-continue-chat>${tr('המשך בשיחה חדשה', 'Continue in a new conversation')}</button>` : ''}` : m.kind === 'fresh-start' ? esc(tr('שיחה חדשה. ההודעות שלמעלה נשארות לקריאה, אבל הבוטים כבר לא רואים אותן ואי אפשר לצטט אותן.', 'New conversation. The messages above stay readable, but bots no longer see them and they cannot be quoted.')) : esc(m.text)}</div>`;
      return `<article class="message ${m.role}" id="msg-${m.id}">${m.role === 'assistant' ? avatar(botById(m.botId)) : ''}<div class="message-content">${m.role === 'assistant' ? `<div class="message-label">${esc(botById(m.botId)?.name || 'Bot')}<time>${relativeTime(m.createdAt)}</time></div>` : ''}<div class="message-text" dir="auto">${markdown(m.text)}</div>${m.attachments?.map(a => `<div class="attachment">${esc(a.name)}</div>`).join('') || ''}<div class="message-actions"><button class="icon" data-copy="${m.id}" title="${tr('העתקה', 'Copy')}" aria-label="${tr('העתקה', 'Copy')}">${icon('copy')}</button><button class="icon" data-quote="${m.id}" title="${tr('תשובה', 'Reply')}" aria-label="${tr('תשובה', 'Reply')}">↩</button>${m.role === 'assistant' ? `<button class="icon" data-speak="${m.id}" title="${tr('הקראה', 'Read aloud')}" aria-label="${tr('הקראה', 'Read aloud')}">${icon('sound')}</button>` : ''}</div></div></article>`;
    })
    .join('')}</div>`;
  el.querySelectorAll('[data-continue-chat]').forEach(
    b => (b.onclick = act(() => continueInNewConversation(activeChat()))),
  );
  el.querySelectorAll('[data-copy]').forEach(
    b =>
      (b.onclick = act(async () => {
        await navigator.clipboard.writeText(state.messages.find(m => m.id === b.dataset.copy).text);
        toast(tr('הועתק', 'Copied'));
      })),
  );
  el.querySelectorAll('[data-quote]').forEach(
    b =>
      (b.onclick = () => {
        const m = state.messages.find(m => m.id === b.dataset.quote);
        replyToId = m.id;
        renderReplyContext();
        $('#prompt').value =
          `${m.botId ? '@' + botById(m.botId).name + ' ' : ''}> ${m.text.slice(0, 500)}\n\n`;
        $('#prompt').focus();
      }),
  );
  el.querySelectorAll('[data-speak]').forEach(
    b =>
      (b.onclick = () => {
        if (!('speechSynthesis' in window))
          return toast(tr('הקראה אינה נתמכת בדפדפן זה', 'Speech is not supported in this browser'));
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(
          state.messages.find(m => m.id === b.dataset.speak).text,
        );
        u.lang = state.settings.language === 'he' ? 'he-IL' : 'en-US';
        speechSynthesis.speak(u);
      }),
  );
  el.querySelectorAll('[data-task]').forEach(b => (b.onclick = () => taskDetails(b.dataset.task)));
  el.querySelectorAll('[data-conversation-root]').forEach(
    b => (b.onclick = () => inspectBotConversation(b.dataset.conversationRoot)),
  );
  bindArtifacts(el);
  if (changed || nearBottom) el.scrollTop = el.scrollHeight;
}
function renderQueue() {
  const jobs = state.jobs.filter(
    j => j.chatId === chatId && ['running', 'waiting', 'queued'].includes(j.status),
  );
  $('#queue').innerHTML = jobs.length
    ? `<span class="pulse"></span><span>${esc(jobs.map(j => `${botById(j.botId)?.name}: ${j.status === 'waiting' ? tr('ממתין לאישור', 'waiting for approval') : j.status === 'queued' ? tr('בתור', 'queued') : tr('עובד', 'working')}`).join(' · '))}</span><button class="icon" id="stop-jobs" aria-label="${tr('עצירת המשימות וכל מה שהן הפעילו', 'Stop these tasks and everything they started')}" title="${tr('עצירת המשימות וכל מה שהן הפעילו', 'Stop these tasks and everything they started')}">${icon('stop')}</button>`
    : '';
  if (jobs.length)
    $('#stop-jobs').onclick = act(async () => {
      await Promise.all(jobs.map(j => api(`/api/jobs/${j.id}/cancel`, { tree: true })));
      await refresh();
    });
  const approvals = state.approvals.filter(
    a => a.chatId === chatId && a.status === 'pending' && a.kind !== 'secret',
  );
  const existing = [...$('#pending-approvals').querySelectorAll('[data-approval]')]
    .map(x => x.dataset.approval)
    .join();
  if (existing === approvals.map(a => a.id).join()) return;
  $('#pending-approvals').innerHTML = approvals
    .map(
      a =>
        `<div class="approval" data-approval="${a.id}" dir="${direction()}"><strong>${esc(botById(a.botId)?.name)} · ${tr('צריך את התשובה שלך', 'Needs your input')}</strong>${a.external ? `<p class="error">${tr('המשימה הזו קראה תוכן חיצוני. אשרו רק אם ביקשתם את הפעולה הזו בעצמכם.', 'This task read external content. Approve only if you asked for this action yourself.')}</p>` : ''}${a.kind === 'item/tool/requestUserInput' ? `<p>${esc(a.details.reason || a.kind)}</p><p class="small">${tr('הבוט קורא את התשובה הזו. אל תכתבו כאן סיסמה.', 'The bot reads this answer. Do not type a password here.')}</p>` : ''}${a.kind === 'item/tool/requestUserInput' ? (a.details.questions || []).map(q => `<label>${esc(q.question)}</label><input data-question="${esc(q.id)}" placeholder="${esc(q.options?.map(o => o.label).join(' / ') || '')}" autocomplete="off">`).join('') : renderToolDetails(a.details, { tr, approval: true })}<div class="actions"><button class="primary" data-answer="${a.id}" data-allow="yes">${tr('אישור פעם אחת', 'Allow once')}</button><button class="secondary" data-answer="${a.id}" data-allow="no">${tr('דחייה', 'Deny')}</button></div></div>`,
    )
    .join('');
  $('#pending-approvals')
    .querySelectorAll('[data-answer]')
    .forEach(
      b =>
        (b.onclick = act(async () => {
          const answers = {};
          b.closest('.approval')
            .querySelectorAll('[data-question]')
            .forEach(i => (answers[i.dataset.question] = { answers: [i.value] }));
          await api(`/api/approvals/${b.dataset.answer}`, {
            approve: b.dataset.allow === 'yes',
            answers,
          });
          await refresh();
        })),
    );
}
function renderDetails() {
  const bot = detailBot();
  if (!bot) return;
  const profileKey = JSON.stringify([
    bot.name,
    bot.title,
    bot.color,
    bot.shape,
    bot.managerBotId,
    bot.computer,
    activeChat().name,
    activeChat().botIds,
    state.settings.language,
  ]);
  const panel = $('#details'),
    preserve =
      panel.dataset.tab === detailTab &&
      panel.dataset.bot === bot.id &&
      panel.dataset.mode === computerMode &&
      panel.dataset.profile === profileKey &&
      detailTab === 'computer' &&
      $('#computer-workspace');
  panel.classList.toggle('computer-expanded', computerExpanded && detailTab === 'computer');
  if (preserve) return;
  if ($('#computer-workspace')) reconcileComputerContext(true);
  panel.dataset.tab = detailTab;
  panel.dataset.bot = bot.id;
  panel.dataset.mode = computerMode;
  panel.dataset.profile = profileKey;
  const members = activeChat()
    .botIds.map(botById)
    .filter(b => b && !b.deletedAt);
  panel.innerHTML = `<div class="details-top">${tr('פרטי השיחה', 'Conversation details')}<button class="icon" id="close-details" aria-label="Close details">${icon('close')}</button></div>
    ${activeChat().type === 'group' ? `<div class="group-details-header"><button id="edit-group-details"><strong>${esc(activeChat().name)}</strong><span>${members.length} ${tr('חברים · עריכת הקבוצה', 'members · Edit group')}</span></button></div>` : ''}
    ${members.length > 1 ? `<label class="detail-bot-label" for="detail-bot">${tr('הבוט שמוצג', 'Viewing teammate')}</label><select id="detail-bot">${members.map(b => `<option value="${b.id}" ${b.id === bot.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` : ''}
    <div class="profile"><button class="profile-avatar-button" id="edit-avatar" aria-label="${tr('עריכת תמונת הבוט', 'Edit bot avatar')}">${avatar(bot, 'large')}</button><h2><button id="edit-bot" title="${tr('עריכת שם הבוט', 'Edit bot name')}">${esc(bot.name)}</button></h2><button class="profile-label-button" id="edit-label">${esc(bot.title) || tr('הוספת תווית', 'Add a label')}</button><div><span class="provider-badge ${botProvider(bot)}" dir="ltr">${esc(providerName(botProvider(bot)))}</span></div>${bot.managerBotId ? `<p class="manager-label">${tr('מנהל', 'Reports to')}: ${esc(botById(bot.managerBotId)?.name || '—')}</p>` : ''}<button class="icon profile-options" id="profile-options" aria-label="Bot options" aria-haspopup="menu">⋯</button></div>
    <div class="tabs">${[
      ['media', tr('מדיה', 'Media')],
      ['computer', tr('מחשב', 'Computer')],
      ['routines', tr('שגרות', 'Routines')],
    ]
      .map(
        ([v, l]) =>
          `<button class="${v === detailTab ? 'active' : ''}" data-tab="${v}">${l}</button>`,
      )
      .join(
        '',
      )}</div>${['memory', 'team'].includes(detailTab) ? `<div class="detail-extra-heading"><span>${detailTab === 'memory' ? tr('זיכרון הבוט', 'Bot memory') : tr('צוות ומשימות', 'Team and tasks')}</span><small>StellarCortex</small></div>` : ''}<div class="detail-body" id="detail-body"></div>`;
  $('#close-details').onclick = () => {
    details = false;
    computerExpanded = false;
    render();
  };
  $('#edit-bot').onclick = () => botForm(bot);
  $('#edit-avatar').onclick = () => botForm(bot);
  $('#edit-label').onclick = () => botForm(bot);
  $('#profile-options').onclick = () =>
    conversationMenu(
      state.chats.find(c => c.type === 'direct' && c.botIds[0] === bot.id),
      $('#profile-options'),
    );
  $('#edit-group-details')?.addEventListener('click', () => groupForm(activeChat()));
  $('#detail-bot')?.addEventListener('change', e => {
    detailBotId = e.target.value;
    computerShot = null;
    renderDetails();
  });
  panel.querySelectorAll('[data-tab]').forEach(
    b =>
      (b.onclick = () => {
        detailTab = b.dataset.tab;
        renderDetails();
      }),
  );
  const body = $('#detail-body');
  if (detailTab === 'memory') {
    body.innerHTML = `<p class="small muted" dir="${direction()}">${tr('העדפות ומידע שהבוט שומר בין משימות.', 'Preferences and facts this bot keeps between tasks.')}</p>${bot.memory.map(m => `<div class="memory-item"><span dir="auto">${esc(m.text)}</span><button class="icon" data-remove-memory="${m.id}" aria-label="Remove memory">×</button></div>`).join('') || `<p class="muted small">${tr('עדיין אין זיכרונות שמורים.', 'No memories saved yet.')}</p>`}<form id="memory-form"><label for="memory-text">${tr('זיכרון חדש', 'New memory')}</label><textarea id="memory-text" name="text" required rows="3"></textarea><button class="secondary" style="margin-top:10px">${tr('שמירה', 'Save memory')}</button></form>`;
    body.querySelectorAll('[data-remove-memory]').forEach(
      b =>
        (b.onclick = act(async () => {
          await api(`/api/bots/${bot.id}/memory`, { remove: b.dataset.removeMemory });
          await refresh();
        })),
    );
    $('#memory-form').onsubmit = act(async e => {
      e.preventDefault();
      await api(`/api/bots/${bot.id}/memory`, { text: new FormData(e.target).get('text') });
      await refresh();
    });
  }
  if (detailTab === 'media') {
    body.innerHTML =
      state.artifacts
        .filter(a => a.botId === bot.id)
        .map(
          a =>
            `<button class="detail-card" data-artifact="${a.id}">${esc(a.title)}<small>${esc(a.path)}</small></button>`,
        )
        .join('') ||
      `<p class="muted small" dir="${direction()}">${tr('תוצרים שהבוט יפרסם יופיעו כאן.', 'Files your bot publishes will appear here.')}</p>`;
    bindArtifacts(body);
  }
  if (detailTab === 'routines') {
    body.innerHTML =
      state.routines
        .filter(r => r.botId === bot.id)
        .map(
          r =>
            `<button class="detail-card" data-routine="${r.id}">${esc(r.name)}<small>${r.enabled ? tr('פעיל', 'Active') : tr('מושהה', 'Paused')} · ${scheduleLabel(r)}</small></button>`,
        )
        .join('') +
      `<button class="secondary" id="detail-new-routine" style="margin-top:15px">+ ${tr('שגרה חדשה', 'New routine')}</button>`;
    body
      .querySelectorAll('[data-routine]')
      .forEach(
        b =>
          (b.onclick = () => routineDetails(state.routines.find(r => r.id === b.dataset.routine))),
      );
    $('#detail-new-routine').onclick = () => routineForm(bot.id);
  }
  if (detailTab === 'team') {
    const reports = state.bots.filter(b => b.managerBotId === bot.id && !b.deletedAt);
    const delegated = state.jobs
      .filter(
        j =>
          j.parentJobId &&
          !j.resultForJobId &&
          state.jobs.find(p => p.id === j.parentJobId)?.botId === bot.id,
      )
      .slice(-12)
      .reverse();
    body.innerHTML = `<p class="small muted" dir="${direction()}">${tr('אפשר לבקש מהבוט ליצור מומחים, לחלק להם עבודה ולחזור עם התוצאות.', 'Ask this bot to create specialists, delegate work, and return with their results.')}</p><h3>${tr('חברי הצוות', 'Teammates')}</h3>${reports.map(b => `<button class="detail-card teammate-link" data-bot-chat="${b.id}">${avatar(b)}<span>${esc(b.name)}<small>${esc(b.title)}</small></span></button>`).join('') || `<p class="small muted">${tr('לבוט הזה עדיין אין צוות משלו.', 'This bot has not created its own team yet.')}</p>`}<button class="secondary" id="ask-team">${tr('בקשת הקמת צוות', 'Ask to build a team')}</button><h3 style="margin-top:24px">${tr('משימות שנמסרו', 'Delegated tasks')}</h3>${delegated.map(j => `<button class="detail-card" data-task="${j.id}">${esc(botById(j.botId)?.name)} · ${statusLabel(j.status)}<small dir="auto">${esc(j.text.slice(0, 160))}</small>${j.reportedAt ? `<small class="result-delivered">${tr('התוצאה הוחזרה למנהל', 'Result returned to manager')}</small>` : ''}</button>`).join('') || `<p class="small muted">${tr('אין משימות שנמסרו עדיין.', 'No delegated tasks yet.')}</p>`}`;
    body
      .querySelectorAll('[data-bot-chat]')
      .forEach(b => (b.onclick = act(() => openBotChat(b.dataset.botChat))));
    body
      .querySelectorAll('[data-task]')
      .forEach(b => (b.onclick = () => taskDetails(b.dataset.task)));
    $('#ask-team').onclick = () => {
      $('#prompt').value = tr(
        `@${bot.name} בנה צוות מומחים למשימה הבאה, חלק להם משימות, אסוף את התוצאות והחזר סיכום: `,
        `@${bot.name} Build a team of specialists for the following task, delegate the work, collect results, and summarize: `,
      );
      $('#prompt').focus();
    };
  }
  if (detailTab === 'computer') renderComputerPanel(bot);
}
function renderComputerPanel(bot) {
  const modes = `<div class="computer-toolbar"><div class="mode-switch" role="group" aria-label="Computer mode"><button data-computer-mode="desktop" class="${computerMode === 'desktop' ? 'active' : ''}">${tr('שולחן עבודה', 'Desktop')}</button><button data-computer-mode="browser" class="${computerMode === 'browser' ? 'active' : ''}">${tr('דפדפן', 'Browser')}</button></div></div>`;
  const bindModes = () =>
    $('#detail-body')
      .querySelectorAll('[data-computer-mode]')
      .forEach(
        b =>
          (b.onclick = computerAction(async () => {
            if (computerControl.owner || computerControl.transition) await releaseComputerControl();
            computerMode = b.dataset.computerMode;
            localStorage.setItem('stellarcortex-computer-mode', computerMode);
            renderDetails();
          })),
      );
  if (state.desktopProvider?.vmBots.includes(bot.id)) {
    const host = document.createElement('div');
    host.id = 'computer-workspace';
    $('#detail-body').replaceChildren(host);
    const epoch = ++standardDesktopEpoch;
    (state.desktopProvider.bots.includes(bot.id) ? mountRemoteDesktop : mountComputerSetup)({
      element: host,
      botId: bot.id,
      api,
      tr,
    })
      .then(mount => {
        if (epoch !== standardDesktopEpoch || !host.isConnected) {
          mount.unmount();
          return;
        }
        standardDesktop = { botId: bot.id, mount };
      })
      .catch(error => {
        if (host.isConnected) host.textContent = error.message;
      });
    return;
  }
  resetComputerInput();
  computerShot = null;
  computerManual = false;
  const empty = computerEmptyState({
    computer: bot.computer ?? state.computerDefault ?? 'none',
    provider: !!state.desktopProvider,
    mode: computerMode,
    tr,
  });
  if (empty) {
    $('#detail-body').innerHTML =
      `<div id="computer-workspace">${empty.modes ? modes : ''}<div class="computer-screen"><div class="computer-placeholder computer-empty">${icon('computer')}<strong>${esc(empty.title)}</strong><p dir="${direction()}">${esc(empty.text)}</p><button id="computer-open-settings" class="secondary">${tr('להגדרת המחשב של הבוט', 'Set this bot’s computer')}</button></div></div></div>`;
    bindModes();
    $('#computer-open-settings').onclick = computerAction(() =>
      settings('computer', { computerBot: bot.id }),
    );
    return;
  }
  $('#detail-body').innerHTML = `<div id="computer-workspace">
    <div class="computer-header"><div class="computer-title"><strong>${esc(tr(`המחשב של ${bot.name}`, `${bot.name}'s computer`))}</strong><span id="computer-status" class="small muted" role="status">${tr('מתחבר…', 'Connecting…')}</span></div><div class="computer-primary-actions"><button id="takeover" class="secondary" disabled>${tr('לקיחת שליטה', 'Take control')}</button><button class="icon" id="refresh-computer" title="${tr('רענון', 'Refresh')}" aria-label="Refresh computer">↻</button><button class="icon" id="expand-computer" title="${tr('פתיחת המחשב', 'Open computer')}" aria-label="Open computer">↗</button></div></div>
    <div id="computer-demonstration"></div>${modes}
    <div id="computer-screen" class="computer-screen" tabindex="0" role="group" aria-label="${tr('מסך המחשב', 'Computer screen')}"><div class="computer-placeholder">${icon('computer')}<p>${tr('מתחבר למחשב…', 'Connecting to the computer…')}</p></div></div>
    <textarea id="computer-keyboard-input" aria-label="Remote computer keyboard" autocomplete="off" autocapitalize="off" spellcheck="false" rows="1" tabindex="-1" disabled></textarea>
    <p id="computer-location" class="small muted" dir="auto"></p>
    <div id="manual-controls" hidden><p id="manual-control-hint" class="small muted" dir="${direction()}">${tr('העכבר והמקלדת פועלים במסך. Ctrl+Shift+Esc לסיום.', 'Use your mouse and keyboard on the screen. Ctrl+Shift+Esc to finish.')}</p>
      <details id="computer-advanced"><summary>${tr('כלים נוספים', 'More controls')}</summary><div class="computer-advanced-body">
        ${computerMode === 'browser' ? `<div class="browser-controls"><input id="browser-address" aria-label="Browser URL" placeholder="https://example.com"><button id="browser-go" class="secondary">Go</button></div>` : ''}
        <p class="small muted">${tr('להדבקה ארוכה או למקשים שהדפדפן המקומי שומר לעצמו.', 'For long text or shortcuts reserved by your local browser.')}</p>
        <div class="browser-controls"><input id="computer-text" type="password" autocomplete="off" aria-label="Text to type into computer" placeholder="${tr('טקסט להקלדה', 'Text to type')}"><button id="computer-type" class="secondary">${tr('הקלדה', 'Type')}</button></div>
        <div class="computer-input-options"><label for="computer-mouse-mode">${tr('עכבר', 'Mouse')}</label><select id="computer-mouse-mode"><option value="auto">${tr('עכבר רגיל', 'Normal mouse')}</option>${computerMode === 'desktop' ? `<option value="doubleClick">${tr('לחיצה כפולה', 'Double click')}</option><option value="rightClick">${tr('לחיצה ימנית', 'Right click')}</option><option value="drag">${tr('גרירה', 'Drag')}</option>` : ''}</select></div>
        <div class="computer-keyboard">${['Tab', 'Enter', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'Control+A', 'Control+C', 'Control+V', ...(computerMode === 'desktop' ? ['Alt+Tab', 'Meta'] : [])].map(k => `<button class="secondary computer-key" data-key="${k}">${{ Escape: 'Esc', Backspace: '⌫', ArrowUp: '↑', ArrowDown: '↓', Meta: '⊞' }[k] || k.replace('Control', 'Ctrl')}</button>`).join('')}<button class="secondary computer-scroll" data-amount="-600" title="Scroll up">⇡</button><button class="secondary computer-scroll" data-amount="600" title="Scroll down">⇣</button></div>
        <div class="browser-controls"><input id="computer-key" aria-label="Keyboard shortcut" placeholder="Ctrl+S"><button id="computer-send-key" class="secondary">${tr('שליחת קיצור', 'Send shortcut')}</button></div>
      </div></details>
    </div><p id="computer-boundary" class="small muted computer-boundary" dir="${direction()}"></p></div>`;
  bindModes();
  $('#expand-computer').onclick = computerAction(async () =>
    computerExpanded ? closeComputerViewer() : openComputerViewer(),
  );
  $('#refresh-computer').onclick = () => updateScreen(true);
  $('#takeover').onclick = computerAction(async () => {
    if (computerControl.transition) return;
    if (computerManual) {
      await releaseComputerControl();
      return;
    }
    if (!computerExpanded) openComputerViewer();
    else computerFullscreen.open($('#details')).catch(reportComputerError);
    resetComputerInput();
    const owner = { botId: bot.id, mode: computerMode, chatId, session: computerSession };
    const acquiring = computerControl.acquire(
      owner,
      () => computerContextCurrent(owner) && computerExpanded,
    );
    updateComputerTransition();
    try {
      if (!(await acquiring) || !computerContextCurrent(owner) || !computerExpanded) return;
      computerShot = null;
      setManualControls(true);
      await updateScreen(true);
      focusComputer();
    } finally {
      updateComputerTransition();
    }
  });
  if ($('#browser-go'))
    $('#browser-go').onclick = computerAction(() =>
      operateComputer({ action: 'open', url: $('#browser-address').value }),
    );
  $('#computer-type').onclick = computerAction(async () => {
    const text = $('#computer-text').value;
    if (!text) return;
    $('#computer-text').value = '';
    await operateComputer({ action: 'type', text });
  });
  $('#computer-text').onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#computer-type').click();
    }
  };
  $('#detail-body')
    .querySelectorAll('.computer-key')
    .forEach(
      b =>
        (b.onclick = computerAction(() => operateComputer({ action: 'key', key: b.dataset.key }))),
    );
  $('#detail-body')
    .querySelectorAll('.computer-scroll')
    .forEach(
      b =>
        (b.onclick = computerAction(() =>
          operateComputer({ action: 'scroll', amount: Number(b.dataset.amount) }),
        )),
    );
  $('#computer-send-key').onclick = computerAction(() =>
    operateComputer({ action: 'key', key: $('#computer-key').value }),
  );
  const screen = $('#computer-screen'),
    input = $('#computer-keyboard-input');
  screen.onclick = () => {
    if (!computerExpanded) openComputerViewer();
    else if (computerManual) focusComputer();
    else if (!computerControl.transition) $('#takeover').click();
  };
  screen.onkeydown = e => {
    if (!computerExpanded && ['Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openComputerViewer();
    } else if (computerManual) {
      focusComputer();
      handleComputerKey(e);
    }
  };
  input.onkeydown = handleComputerKey;
  input.oninput = e => {
    if (!e.isComposing) readComputerText();
  };
  input.oncompositionend = () => readComputerText();
  input.onfocus = () => screen.classList.add('keyboard-active');
  input.onblur = () => {
    screen.classList.remove('keyboard-active');
    flushComputerText();
  };
  $('#computer-advanced').ontoggle = () => {
    if ($('#computer-advanced')?.open) flushComputerText();
  };
  updateComputerLayout();
  renderDemonstrationControls();
  updateScreen(true);
}
function updateComputerLayout() {
  if (!computerExpanded) computerFullscreen.close().catch(reportComputerError);
  const panel = $('#details');
  panel.classList.toggle('computer-expanded', computerExpanded);
  panel.classList.toggle('manual-takeover', computerManual);
  $('#sidebar').inert = computerExpanded;
  $('.main').inert = computerExpanded;
  if (computerExpanded) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', tr('מחשב הבוט', 'Bot computer'));
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('aria-label');
  }
  const expand = $('#expand-computer');
  if (expand) {
    expand.textContent = computerExpanded ? '×' : '↗';
    expand.setAttribute('aria-label', computerExpanded ? 'Close computer' : 'Open computer');
    expand.title = tr(
      computerExpanded ? 'סגירת המחשב' : 'פתיחת המחשב',
      computerExpanded ? 'Close computer' : 'Open computer',
    );
  }
  if ($('#takeover')) $('#takeover').hidden = false;
}
function setComputerExpanded(value) {
  computerExpanded = value;
  updateComputerLayout();
  if (value) {
    if (computerManual) focusComputer();
    else $('#takeover')?.focus({ preventScroll: true });
  } else $('#expand-computer')?.focus({ preventScroll: true });
}
function openComputerViewer() {
  if (voiceIsLive()) {
    void stopVoiceCall({ close: true });
    toast(
      tr(
        'השיחה הקולית הסתיימה לפני מעבר לשליטה במסך מלא.',
        'The voice call ended before opening full-screen computer control.',
      ),
    );
  }
  setComputerExpanded(true);
  computerFullscreen.open($('#details')).catch(reportComputerError);
}
function computerContextCurrent(owner) {
  return (
    !!owner &&
    details &&
    view === 'chat' &&
    detailTab === 'computer' &&
    detailBot()?.id === owner.botId &&
    computerMode === owner.mode &&
    chatId === owner.chatId &&
    computerSession === owner.session
  );
}
function updateComputerTransition() {
  const pending = !!computerControl.transition;
  if ($('#takeover'))
    $('#takeover').disabled =
      pending ||
      (computerMode === 'desktop' && (!desktopStatus?.enabled || !desktopStatus?.available));
  if ($('#computer-keyboard-input'))
    $('#computer-keyboard-input').disabled = pending || !computerManual;
  if ($('#manual-controls')) $('#manual-controls').inert = pending;
  $('#computer-workspace')?.setAttribute('aria-busy', String(pending));
}
function reportComputerError(error) {
  if ($('#computer-status')) $('#computer-status').textContent = error.message;
  toast(error.message);
}
function computerAction(fn) {
  return async event => {
    try {
      return await fn(event);
    } catch (error) {
      reportComputerError(error);
    }
  };
}
function reconcileComputerContext(force = false) {
  if (
    force ||
    !details ||
    view !== 'chat' ||
    detailTab !== 'computer' ||
    (standardDesktop && standardDesktop.botId !== detailBot()?.id)
  ) {
    standardDesktopEpoch++;
    standardDesktop?.mount.unmount();
    standardDesktop = null;
  }

  const owner = computerControl.owner || computerControl.transition?.owner;
  if (owner && (force || !computerContextCurrent(owner))) {
    releaseComputerControl({ discard: true }).catch(reportComputerError);
    setComputerExpanded(false);
  } else if (!details || view !== 'chat' || detailTab !== 'computer') {
    resetComputerInput();
    computerManual = false;
    setComputerExpanded(false);
  } else updateComputerLayout();
}
async function releaseComputerControl({ discard = false } = {}) {
  const owner = computerControl.owner || computerControl.transition?.owner;
  if (discard) resetComputerInput();
  else if (computerControl.accepting) {
    flushComputerClick();
    flushComputerText();
    clearTimeout(computerWheelTimer);
    if (computerWheel) {
      const amount = computerWheel;
      computerWheel = 0;
      operateComputer({ action: 'scroll', amount }).catch(reportComputerError);
    }
  }
  // release() freezes admission synchronously; already accepted input drains first.
  const releasing = computerControl.release();
  updateComputerTransition();
  try {
    await releasing;
  } finally {
    if (!computerControl.owner || computerControl.owner === owner) {
      resetComputerInput();
      setManualControls(false);
      computerShot = null;
    }
    updateComputerTransition();
  }
}
async function closeComputerViewer() {
  try {
    await releaseComputerControl();
  } finally {
    resetComputerInput();
    setManualControls(false);
    setComputerExpanded(false);
  }
}
function resetComputerInput() {
  computerSession++;
  computerInputs.cancel();
  clearTimeout(computerTextTimer);
  clearTimeout(computerClickTimer);
  clearTimeout(computerWheelTimer);
  clearTimeout(computerMoveTimer);
  computerPendingText = '';
  computerPendingClick = null;
  computerWheel = 0;
  dragStart = null;
  if ($('#computer-keyboard-input')) $('#computer-keyboard-input').value = '';
}
function setManualControls(enabled) {
  enabled = !!enabled && computerContextCurrent(computerControl.owner);
  const changed = computerManual !== enabled;
  computerManual = enabled;
  if (!enabled) {
    computerDemonstration.pause();
    computerVisual.pause();
  }
  if (!$('#manual-controls')) return;
  $('#manual-controls').hidden = !enabled;
  $('#takeover').textContent = enabled
    ? tr('סיימתי', 'I’m done')
    : tr('לקיחת שליטה', 'Take control');
  $('#computer-keyboard-input').disabled = !enabled || !!computerControl.transition;
  $('#computer-screen').classList.toggle('manual', !!enabled);
  if (changed && !enabled) {
    resetComputerInput();
    $('#computer-advanced').open = false;
  }
  if (enabled && !computerExpanded) setComputerExpanded(true);
  updateComputerLayout();
  renderDemonstrationControls();
  if (changed && enabled) focusComputer();
}
function focusComputer() {
  if (computerManual && computerControl.accepting)
    $('#computer-keyboard-input')?.focus({ preventScroll: true });
}
function readComputerText() {
  const input = $('#computer-keyboard-input');
  if (!input) return;
  if (!computerManual || !computerControl.accepting) {
    input.value = '';
    return;
  }
  flushComputerClick();
  computerPendingText += input.value;
  input.value = '';
  clearTimeout(computerTextTimer);
  computerTextTimer = setTimeout(flushComputerText, 70);
}
function flushComputerText() {
  clearTimeout(computerTextTimer);
  const text = computerPendingText;
  computerPendingText = '';
  if (text && computerManual) {
    for (let i = 0; i < text.length; i += 4000)
      operateComputer({ action: 'type', text: text.slice(i, i + 4000) }).catch(reportComputerError);
  }
}
function handleComputerKey(e) {
  if (!computerManual) return;
  e.stopPropagation();
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Escape') {
    e.preventDefault();
    computerAction(closeComputerViewer)();
    return;
  }
  if (!computerControl.accepting) {
    e.preventDefault();
    return;
  }
  const action = computerKeyAction(e);
  if (!action) return;
  e.preventDefault();
  flushComputerClick();
  flushComputerText();
  operateComputer(action).catch(reportComputerError);
}
function flushComputerClick() {
  clearTimeout(computerClickTimer);
  const pending = computerPendingClick;
  computerPendingClick = null;
  if (pending && pending.session === computerSession && computerManual)
    operateComputer(pending.args).catch(reportComputerError);
}
async function operateComputer(args) {
  if (!computerManual) throw new Error(tr('צריך לקחת שליטה קודם.', 'Take control first.'));
  if (!computerControl.accepting) return false;
  const owner = computerControl.owner,
    { botId, mode } = owner;
  return computerInputs.enqueue(async () => {
    const current = () =>
      computerManual && computerControl.owner === owner && computerContextCurrent(owner);
    if (!current()) return;
    while (screenBusy) {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (!current()) return;
    }
    computerOperation = true;
    try {
      const coordinates = ['click', 'doubleClick', 'move', 'drag'].includes(args.action);
      if (mode === 'desktop' && coordinates && !computerShot?.frameId) {
        const shot = await api(`/api/desktop/${botId}`);
        if (!current()) return;
        computerShot = shot;
      }
      if (!current()) return;
      await api(`/api/${mode}/${botId}/action`, {
        ...args,
        ...(mode === 'desktop' && coordinates ? { frameId: computerShot.frameId } : {}),
      });
      computerDemonstration.capture(args, computerShot || { width: 1280, height: 800 }, {
        botId,
        mode,
      });
      if (
        args.action === 'type' ||
        (args.action === 'key' && /Control\+V|Meta\+V/.test(args.key || ''))
      ) {
        computerDemonstration.pause();
        computerVisual.sensitiveInput();
      }
      renderDemonstrationControls();
      if (current() && computerShot) computerShot.frameId = null;
    } finally {
      computerOperation = false;
    }
    if (current()) await updateScreen(true);
  });
}
function bindComputerImage(bot, mode, shot) {
  const img = $('#computer-image');
  if (!img) return;
  const point = e =>
    screenPoint(e, img.getBoundingClientRect(), shot.width || 1280, shot.height || 800);
  img.onpointerdown = e => {
    if (!computerManual || !computerControl.accepting) return;
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    clearTimeout(computerMoveTimer);
    flushComputerText();
    focusComputer();
    dragStart = { ...p, clientX: e.clientX, clientY: e.clientY, button: e.button, id: e.pointerId };
    img.setPointerCapture?.(e.pointerId);
  };
  img.onpointerup = e => {
    if (
      !computerManual ||
      !computerControl.accepting ||
      mode !== computerMode ||
      bot.id !== detailBot()?.id
    )
      return;
    e.preventDefault();
    const p = point(e),
      start = dragStart;
    dragStart = null;
    if (img.hasPointerCapture?.(e.pointerId)) img.releasePointerCapture(e.pointerId);
    if (!p || !start) return;
    const choice = $('#computer-mouse-mode').value,
      moved = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > 5;
    if (mode === 'desktop' && (choice === 'drag' || (moved && start.button === 0))) {
      flushComputerClick();
      operateComputer({ action: 'drag', x: start.x, y: start.y, toX: p.x, toY: p.y }).catch(
        reportComputerError,
      );
      return;
    }
    const button =
      choice === 'rightClick' || start.button === 2
        ? 'right'
        : start.button === 1
          ? 'middle'
          : 'left';
    if (button !== 'left' || choice === 'doubleClick') {
      flushComputerClick();
      operateComputer({
        action: choice === 'doubleClick' && mode === 'desktop' ? 'doubleClick' : 'click',
        ...p,
        ...(mode === 'desktop' ? { button } : {}),
      }).catch(reportComputerError);
      return;
    }
    const previous = computerPendingClick;
    if (
      previous &&
      performance.now() - previous.time < 280 &&
      Math.hypot(previous.args.x - p.x, previous.args.y - p.y) < 12 &&
      mode === 'desktop'
    ) {
      clearTimeout(computerClickTimer);
      computerPendingClick = null;
      operateComputer({ action: 'doubleClick', ...p }).catch(reportComputerError);
    } else {
      flushComputerClick();
      computerPendingClick = {
        session: computerSession,
        time: performance.now(),
        args: { action: 'click', ...p },
      };
      computerClickTimer = setTimeout(flushComputerClick, 250);
    }
  };
  img.onpointermove = e => {
    if (!computerManual || !computerControl.accepting || dragStart || mode !== 'desktop') return;
    const p = point(e);
    clearTimeout(computerMoveTimer);
    if (p)
      computerMoveTimer = setTimeout(() => {
        if (computerManual && !computerInputs.pending && !dragStart)
          operateComputer({ action: 'move', ...p }).catch(reportComputerError);
      }, 120);
  };
  img.onpointerleave = () => clearTimeout(computerMoveTimer);
  img.onpointercancel = () => {
    dragStart = null;
  };
  img.oncontextmenu = e => {
    if (computerManual) e.preventDefault();
  };
  img.ondragstart = e => e.preventDefault();
  img.onwheel = e => {
    if (!computerManual || !computerControl.accepting) return;
    e.preventDefault();
    flushComputerClick();
    flushComputerText();
    computerWheel += e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 600 : 1);
    clearTimeout(computerWheelTimer);
    computerWheelTimer = setTimeout(() => {
      const amount = computerWheel;
      computerWheel = 0;
      if (amount) operateComputer({ action: 'scroll', amount }).catch(reportComputerError);
    }, 70);
  };
}
function renderDemonstrationControls() {
  const el = $('#computer-demonstration');
  if (!el) return;
  const d = computerDemonstration.current,
    bot = detailBot(),
    current = d && d.botId === bot?.id && d.mode === computerMode,
    canControl = computerManual && computerControl.accepting;
  const renderKey = JSON.stringify([
    d?.id,
    d?.state,
    bot?.id,
    computerMode,
    !!current,
    !!canControl,
    state.settings.language,
    !!state.guestExecutionEnabled,
  ]);
  if (el.dataset.renderKey === renderKey) {
    const status = el.querySelector('[role=status]');
    if (status && d)
      status.textContent = `${tr('הדגמה', 'Demonstration')}: ${d.state} · ${d.steps.length} ${tr('צעדים', 'steps')}`;
    return;
  }
  el.dataset.renderKey = renderKey;
  el.innerHTML = `<div class="actions">${!d ? `<button id="teach-computer" class="secondary" ${canControl ? '' : 'disabled'}>${tr('לימוד פעולה', 'Teach a task')}</button>` : `<span role="status">${tr('הדגמה', 'Demonstration')}: ${esc(d.state)} · ${d.steps.length} ${tr('צעדים', 'steps')}</span>${d.state === 'recording' && state.guestExecutionEnabled && computerMode === 'desktop' ? `<button id="capture-visual-step" class="secondary">${tr('הוספת צעד חזותי', 'Add visual step')}</button>` : ''}${d.state === 'recording' ? `<button id="pause-demonstration" class="secondary">${tr('השהיה לקלט רגיש', 'Pause for sensitive input')}</button>` : d.state === 'paused' ? `<button id="resume-demonstration" class="secondary" ${current && canControl ? '' : 'disabled'}>${tr('המשך הדגמה', 'Resume demonstration')}</button>` : ''}<button id="review-demonstration" class="secondary">${tr('עצירה ובדיקת טיוטה', 'Stop and review draft')}</button><button id="discard-demonstration" class="secondary">${tr('מחיקת ההדגמה', 'Discard demonstration')}</button>`}</div><p class="small muted">${tr('לימוד מתחיל רק ביוזמתך ובשליטה ידנית. טקסט מוקלד, וידאו ומיקרופון אינם מוקלטים. הוסף רק צעדים חזותיים מושחרים שבדקת; השהה לפני קלט רגיש.', 'Teaching starts only on your explicit action during manual control. Typed text, video and microphone are never recorded. Add only reviewed, redacted visual steps; pause before sensitive input.')}</p>`;
  $('#teach-computer')?.addEventListener('click', () => {
    modal(
      tr('לימוד פעולה', 'Teach a task'),
      `<form id="teach-start-form"><label>${tr('מה התוצאה הרצויה? ללא פרטים רגישים', 'What is the intended result? No sensitive details')}<textarea name="objective" required maxlength="2000" dir="auto"></textarea></label><p>${tr('בצע את הפעולה במחשב של הסוכן. ערכי טקסט לא יישמרו ויוחלפו בהנחיה להזנה ידנית. לא מופעלת משימת מודל.', 'Demonstrate on the agent computer. Text values are never saved and become manual-entry placeholders. No model task is started.')}</p><div class="actions"><button type="button" data-cancel-teach>${tr('ביטול', 'Cancel')}</button><button>${tr('תחילת הדגמה', 'Start demonstration')}</button></div></form>`,
    );
    const form = $('#teach-start-form');
    form.querySelector('[data-cancel-teach]').onclick = () => $('#modal').close();
    form.onsubmit = computerAction(async e => {
      e.preventDefault();
      computerDemonstration.start({
        botId: bot.id,
        mode: computerMode,
        objective: form.elements.objective.value,
        authorized: canControl && computerContextCurrent(computerControl.owner),
      });
      computerVisual.start({
        botId: bot.id,
        objective: form.elements.objective.value,
        manualControl: canControl,
      });
      $('#modal').close();
      renderDemonstrationControls();
      focusComputer();
    });
  });
  $('#pause-demonstration')?.addEventListener('click', () => {
    computerDemonstration.pause();
    computerVisual.pause();
    renderDemonstrationControls();
  });
  $('#resume-demonstration')?.addEventListener(
    'click',
    computerAction(async () => {
      if (
        !confirm(
          tr(
            'בדקת שהמסך שוב בטוח לצילום ושאין מידע רגיש?',
            'Have you checked that the screen is safe again with no sensitive information?',
          ),
        )
      )
        return;
      computerDemonstration.resume({
        botId: bot.id,
        mode: computerMode,
        authorized: canControl && computerContextCurrent(computerControl.owner),
      });
      computerVisual.resume({
        botId: bot.id,
        manualControl: canControl,
        safeScreenConfirmed: true,
      });
      renderDemonstrationControls();
      focusComputer();
    }),
  );
  $('#capture-visual-step')?.addEventListener(
    'click',
    computerAction(async () => {
      if (document.querySelector('.visual-step-dialog')) return;
      const owner = computerControl.owner;
      clearTimeout(computerMoveTimer);
      flushComputerClick();
      flushComputerText();
      await computerInputs.idle();
      if (
        !computerManual ||
        computerControl.owner !== owner ||
        !computerContextCurrent(owner) ||
        computerVisual.session?.state !== 'recording'
      )
        return;
      const shot = computerShot;
      if (!shot?.image || !shot.frameId)
        return toast(
          tr('רענן את המסך לפני בחירת אזור', 'Refresh the screen before selecting an area'),
        );
      openVisualStep({
        demo: computerVisual,
        botId: bot.id,
        frameId: shot.frameId,
        source: `data:${shot.mimeType || 'image/jpeg'};base64,${shot.image}`,
        width: shot.width,
        height: shot.height,
        tr,
        onAccepted: renderDemonstrationControls,
      });
    }),
  );
  $('#review-demonstration')?.addEventListener('click', () => reviewComputerDemonstration());
  $('#discard-demonstration')?.addEventListener('click', () => {
    if (confirm(tr('למחוק את ההדגמה שלא נשמרה?', 'Discard the unsaved demonstration?'))) {
      computerDemonstration.discard();
      computerVisual.discard();
      renderDemonstrationControls();
    }
  });
}
function reviewComputerDemonstration() {
  const draft = computerDemonstration.stop(),
    language = state.settings.language;
  const visual = computerVisual.session ? computerVisual.stop() : null;
  modal(
    tr('בדיקת הוראות לפני שמירה', 'Review instructions before saving'),
    `<form id="teach-review-form"><p>${tr('זו טיוטת הוראות מובנית, לא אימון מודל. ערוך את הצעדים והסבר את יעדיהם. נכללות רק התמונות שאישרת במפורש; ערכי טקסט לא הוקלטו. שמירה אינה מבצעת את הפעולה.', 'This is an editable structured draft, not model training. Explain the steps and their targets. Only the visual examples you explicitly approved are included; typed values were not recorded. Saving does not execute the procedure.')}</p><label>${tr('שם ההוראות', 'Instruction name')}<input name="name" required maxlength="100"></label><label>${tr('טיוטה לעריכה — ללא סודות', 'Editable draft — no secrets')}<textarea name="instructions" required maxlength="12000" rows="12" dir="auto">${esc(draft.editedInstructions || (visual?.steps.length ? visual.instructions + '\n\n' + demonstrationText(draft, language) : demonstrationText(draft, language)))}</textarea></label><label><input type="checkbox" name="reviewed" required>${tr('בדקתי את ההוראות והסרתי מידע רגיש', 'I reviewed the instructions and removed sensitive information')}</label><div class="actions"><button type="button" data-return-demo>${tr('חזרה ללא שמירה', 'Back without saving')}</button><button type="button" data-discard-demo>${tr('מחיקה', 'Discard')}</button><button ${draft.steps.length || visual?.steps.length ? '' : 'disabled'}>${tr('שמירה לסוכן הזה', 'Save for this agent')}</button></div></form>`,
  );
  renderDemonstrationControls();
  const f = $('#teach-review-form');
  f.elements.name.value = draft.name || '';
  f.elements.instructions.oninput = () =>
    (draft.editedInstructions = f.elements.instructions.value);
  f.elements.name.oninput = () => (draft.name = f.elements.name.value);
  f.querySelector('[data-return-demo]').onclick = () => $('#modal').close();
  f.querySelector('[data-discard-demo]').onclick = () => {
    computerDemonstration.discard();
    computerVisual.discard();
    $('#modal').close();
    renderDemonstrationControls();
  };
  let saving = false;
  f.onsubmit = computerAction(async e => {
    e.preventDefault();
    if (saving) return;
    saving = true;
    try {
      const frameIds = [];
      for (const step of visual?.steps || []) {
        const frameId = draft.id + '-' + step.index,
          stored = await api('/api/computer-demonstrations/frame-artifact', {
            botId: draft.botId,
            demoId: draft.id,
            frameId,
            image: step.frame.image,
            mimeType: step.frame.mimeType,
            reviewed: f.elements.reviewed.checked,
          });
        frameIds.push(stored.id);
      }
      await api('/api/computer-demonstrations', {
        botId: draft.botId,
        demoId: draft.id,
        mode: draft.mode,
        objective: draft.objective,
        name: f.elements.name.value,
        instructions: f.elements.instructions.value,
        steps: draft.steps,
        frameIds,
        reviewed: f.elements.reviewed.checked,
      });
      computerDemonstration.discard();
      computerVisual.discard();
      $('#modal').close();
      await refresh();
      renderDemonstrationControls();
      toast(
        tr(
          'ההוראות נשמרו לסוכן. לא הופעלה משימה.',
          'Instructions saved for this agent. No task was started.',
        ),
      );
    } finally {
      saving = false;
    }
  });
}

async function updateScreen(force = false) {
  if (
    screenBusy ||
    computerOperation ||
    computerControl.transition ||
    dragStart ||
    !details ||
    view !== 'chat' ||
    detailTab !== 'computer' ||
    !$('#computer-screen')
  )
    return;
  const bot = detailBot(),
    mode = computerMode,
    session = computerSession;
  if (!bot) return;
  screenBusy = true;
  const current = () =>
    bot.id === detailBot()?.id &&
    mode === computerMode &&
    session === computerSession &&
    !!$('#computer-screen') &&
    details &&
    view === 'chat' &&
    detailTab === 'computer' &&
    !computerControl.transition;
  try {
    let shot, status;
    if (mode === 'desktop') {
      status = await api(`/api/desktop/status?botId=${encodeURIComponent(bot.id)}`);
      if (!current()) return;
      desktopStatus = status;
      $('#takeover').disabled = !status.enabled || !status.available;
      $('#computer-status').textContent = !status.enabled
        ? tr(
            'לבוט הזה אין מחשב. אפשר להגדיר לו אחד בהגדרות > מחשב.',
            'This bot has no computer. You can set one in Settings > Computer.',
          )
        : !status.available
          ? status.reason || tr('המחשב אינו זמין', 'Computer unavailable')
          : status.takeover
            ? tr('בשליטתך', 'You’re in control')
            : tr('צפייה', 'Watching');
      const manual =
        status.takeover &&
        (!status.takeoverBotId || status.takeoverBotId === bot.id) &&
        computerContextCurrent(computerControl.owner);
      // A server-side handback cancels queued input without applying an older screenshot.
      if (!manual) computerControl.revoked();
      setManualControls(manual);
      if (session !== computerSession) return;
      $('#computer-boundary').textContent = tr(
        'המסך של המחשב המארח.',
        'The host computer’s screen.',
      );
      if (!status.enabled || !status.available) {
        computerPlaceholder($('#computer-status').textContent);
        return;
      }
      shot = await api(`/api/desktop/${bot.id}`);
    } else {
      $('#takeover').disabled = false;
      $('#computer-boundary').textContent = tr(
        'הדפדפן של הבוט. לחיצה על התצוגה פותחת אותו.',
        'The bot’s browser. Click the preview to open it.',
      );
      shot = await api(`/api/browser/${bot.id}`);
      if (!current()) return;
      $('#computer-status').textContent = shot?.takeover
        ? tr('בשליטתך', 'You’re in control')
        : tr('צפייה', 'Watching');
      if (!shot?.takeover) computerControl.revoked();
      setManualControls(!!shot?.takeover && computerContextCurrent(computerControl.owner));
      if (session !== computerSession) return;
    }
    if (!current()) return;
    if (!shot?.image) {
      if (mode === 'browser')
        computerPlaceholder(
          tr(
            'אין דף פתוח. קח שליטה ופתח כתובת דרך כלים נוספים.',
            'No page is open. Take control and open a URL under More controls.',
          ),
        );
      return;
    }
    computerShot = shot;
    let img = $('#computer-image');
    if (!img) {
      $('#computer-screen').innerHTML =
        `<img id="computer-image" class="computer-image" draggable="false" alt="${mode === 'desktop' ? 'Live desktop screen' : 'Live browser screen'}">`;
      img = $('#computer-image');
    }
    img.src = `data:${shot.mimeType || 'image/jpeg'};base64,${shot.image}`;
    $('#computer-location').textContent = shot.url || `${shot.width} × ${shot.height}`;
    bindComputerImage(bot, mode, shot);
  } catch (e) {
    if (current()) {
      $('#computer-status').textContent = e.message;
      computerPlaceholder(e.message);
    }
  } finally {
    screenBusy = false;
  }
}
function computerPlaceholder(text) {
  const placeholder = $('#computer-screen .computer-placeholder p');
  if (placeholder) placeholder.textContent = text;
}
screenTimer = setInterval(() => updateScreen(), 1200);

async function openBotChat(botId) {
  const chat = state.chats.find(c => c.type === 'direct' && c.botIds[0] === botId);
  if (chat) await openChat(chat.id);
}
function taskDetails(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  const parent = state.jobs.find(j => j.id === job.parentJobId),
    children = state.jobs.filter(j => j.parentJobId === job.id),
    callback = state.jobs.find(j => j.resultForJobId === job.id);
  modal(
    tr('פרטי משימה', 'Task details'),
    `<div class="task-heading">${avatar(botById(job.botId))}<strong>${esc(botById(job.botId)?.name)}</strong><span class="status ${job.status}">${statusLabel(job.status)}</span></div>${parent ? `<p class="small muted">${tr('נמסרה על ידי', 'Delegated by')} ${esc(botById(parent.botId)?.name)}</p>` : ''}<h3>${tr('המשימה', 'Task')}</h3><div class="task-text" dir="auto">${esc(job.text)}</div>${job.result ? `<h3>${tr('תוצאה', 'Result')}</h3><div class="task-text" dir="auto">${markdown(job.result)}</div>` : ''}${job.error ? `<p class="error">${esc(withoutProgramOutput(job.error, tr))}</p>` : ''}${job.reportedAt ? `<p class="result-delivered">${tr('התוצאה הועברה בחזרה לבוט ששלח את המשימה.', 'The result was delivered back to the delegating bot.')}</p>` : ''}${callback ? `<p class="small muted">${tr('איסוף התוצאה', 'Result follow-up')}: ${statusLabel(callback.status)}</p>` : ''}${children.length ? `<h3>${tr('משימות משנה', 'Subtasks')}</h3>${children.map(j => `<button class="detail-card" data-subtask="${j.id}">${esc(botById(j.botId)?.name)} · ${statusLabel(j.status)}<small dir="auto">${esc(j.text.slice(0, 180))}</small></button>`).join('')}` : ''}<div class="actions"><button class="primary" id="task-open-chat">${tr('פתיחת השיחה', 'Open conversation')}</button>${['queued', 'running', 'waiting'].includes(job.status) ? `<button class="danger" id="task-stop">${tr('עצירת המשימה וכל מה שהיא הפעילה', 'Stop this task and everything it started')}</button>` : ''}</div>`,
  );
  $('#task-open-chat').onclick = act(async () => {
    $('#modal').close();
    await openChat(job.chatId);
  });
  $('#task-stop')?.addEventListener(
    'click',
    act(async () => {
      await api(`/api/jobs/${job.id}/cancel`, { tree: true });
      await refresh();
      taskDetails(job.id);
    }),
  );
  $('#modal-body')
    .querySelectorAll('[data-subtask]')
    .forEach(b => (b.onclick = () => taskDetails(b.dataset.subtask)));
}
function scheduleLabel(r) {
  return r.kind === 'webhook'
    ? 'Webhook'
    : r.kind === 'daily'
      ? `${r.time} · ${r.timezone}`
      : tr(`כל ${r.minutes} דקות`, `Every ${r.minutes} min`);
}
function intro(title, description, button = '') {
  return `<div class="page-intro" dir="${direction()}"><div><h1>${title}</h1><p>${description}</p></div>${button}</div>`;
}
function teamConversationMarkup(compact = false) {
  const delegated = state.jobs.filter(j => j.parentJobId && !j.resultForJobId),
    rootIds = [...new Set(delegated.map(j => j.rootJobId || j.parentJobId))];
  const roots = rootIds.map(id => state.jobs.find(j => j.id === id)).filter(Boolean);
  if (teamRootFilter && !rootIds.includes(teamRootFilter)) teamRootFilter = '';
  const jobs = delegated.filter(
    j => !teamRootFilter || (j.rootJobId || j.parentJobId) === teamRootFilter,
  );
  const events = [];
  for (const job of jobs) {
    const parent = state.jobs.find(j => j.id === job.parentJobId);
    if (!parent) continue;
    const transfer = state.messages.find(
      m => m.kind === 'handoff' && (m.childJobId || m.jobId) === job.id,
    );
    const prefix = `${botById(parent.botId)?.name} → ${botById(job.botId)?.name}: `;
    const request =
      job.requestText ||
      transfer?.requestText ||
      (transfer?.text?.startsWith(prefix) ? transfer.text.slice(prefix.length) : transfer?.text) ||
      tr('ההודעה המקורית אינה זמינה.', 'The original request is unavailable.');
    events.push({
      id: 'sent-' + job.id,
      at: job.createdAt,
      from: parent.botId,
      to: job.botId,
      type: 'sent',
      text: request,
      job,
    });
    for (const m of state.messages.filter(
      m => m.role === 'assistant' && m.jobId === job.id && m.text,
    ))
      events.push({
        id: m.id,
        at: m.createdAt,
        from: job.botId,
        to: parent.botId,
        type: 'reply',
        text: m.text,
        job,
      });
    if (job.error)
      events.push({
        id: 'error-' + job.id,
        at: job.completedAt || job.createdAt,
        from: job.botId,
        to: parent.botId,
        type: 'error',
        text: withoutProgramOutput(job.error, tr),
        job,
      });
    if (job.reportedAt)
      events.push({
        id: 'delivered-' + job.id,
        at: job.reportedAt,
        from: job.botId,
        to: parent.botId,
        type: 'delivered',
        text: tr(
          'התוצאה נמסרה לבוט ששלח את המשימה.',
          'The result was delivered to the delegating bot.',
        ),
        job,
      });
  }
  const callbacks = state.jobs.filter(
    j => j.resultForJobId && jobs.some(child => child.id === j.resultForJobId),
  );
  for (const job of callbacks) {
    const recipient = job.parentJobId
      ? state.jobs.find(p => p.id === job.parentJobId)?.botId
      : null;
    for (const m of state.messages.filter(
      m => m.role === 'assistant' && m.jobId === job.id && m.text,
    ))
      events.push({
        id: m.id,
        at: m.createdAt,
        from: job.botId,
        to: recipient,
        type: 'followup',
        text: m.text,
        job,
      });
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const title = tr('שיחות בין הבוטים', 'Conversations between bots');
  return (
    (compact
      ? ''
      : intro(
          title,
          tr(
            'הבקשות שנמסרו, התשובות שנכתבות והמשך העבודה של הבוט המנהל — בזמן אמת.',
            'See delegated requests, replies as they are written, and the manager’s follow-up in real time.',
          ),
        )) +
    `<div class="team-conversation-filter" ${compact ? 'hidden' : ''}><label for="team-root-filter">${tr('שיחה', 'Conversation')}</label><select id="team-root-filter"><option value="">${tr('כל השיחות', 'All conversations')}</option>${roots.map(j => `<option value="${j.id}" ${teamRootFilter === j.id ? 'selected' : ''}>${esc(botById(j.botId)?.name)} · ${esc(j.text.slice(0, 100))}</option>`).join('')}</select></div><div class="team-transcript">${events.map(e => `<article class="bot-exchange ${e.type}" id="team-event-${e.id}">${avatar(botById(e.from))}<div class="exchange-body"><div class="exchange-header"><strong>${esc(botById(e.from)?.name || 'Bot')}</strong><span>→</span><strong>${e.to ? esc(botById(e.to)?.name || 'Bot') : tr('אליך', 'You')}</strong><time>${relativeTime(e.at)}</time><span class="badge">${e.type === 'sent' ? tr('בקשה', 'Request') : e.type === 'reply' ? tr('תשובה', 'Reply') : e.type === 'followup' ? tr('המשך המנהל', 'Manager follow-up') : e.type === 'error' ? tr('תקלה', 'Error') : tr('נמסר', 'Delivered')}</span></div><div class="exchange-text" dir="auto">${markdown(e.text)}</div><div class="exchange-actions"><button class="secondary" data-task="${e.job.id}">${tr('פרטי משימה', 'Task details')}</button><button class="secondary" data-exchange-chat="${e.job.chatId}">${tr('פתיחת השיחה', 'Open chat')}</button>${state.jobs.find(j => j.id === e.job.rootJobId)?.chatId && state.jobs.find(j => j.id === e.job.rootJobId).chatId !== e.job.chatId ? `<button class="secondary" data-exchange-chat="${state.jobs.find(j => j.id === e.job.rootJobId).chatId}">${tr('השיחה המקורית', 'Original chat')}</button>` : ''}${e.type === 'sent' ? `<span class="status ${e.job.status}">${statusLabel(e.job.status)}</span>` : ''}</div></div></article>`).join('') || `<div class="blank" dir="${direction()}">${tr('כשבוט יעביר משימה לבוט אחר, תראה כאן את השיחה המלאה. בקש מ־Stellar ליצור בוט ולהעביר לו עבודה.', 'When a bot delegates to another bot, the full exchange appears here. Ask Stellar to create a teammate and delegate work.')}</div>`}</div>`
  );
}
function renderPage() {
  const el = $('#content');
  if (['tasks', 'projects'].includes(view)) {
    el.dataset.view = view;
    kanbanPage.mount(el, view, state.bots);
    return;
  }
  if (view === 'apps') {
    el.dataset.view = 'apps';
    appsHub.mount(el);
    return;
  }
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140,
    previousScroll = el.scrollTop,
    changed = el.dataset.view !== view;
  el.dataset.view = view;
  let html = '';
  if (view === 'teamtalk') html = teamConversationMarkup();
  if (view === 'team') {
    const bots = state.bots.filter(b => !b.deletedAt);
    html =
      intro(
        tr('הצוות שלך', 'Your team'),
        tr(
          'בוטים שאתה או הבוטים שלך יצרתם לפי בקשתך. אפשר לנהל, להפעיל ולמחוק כל אחד מהם.',
          'Teammates created by you or at your request. Manage, message, or remove each one.',
        ),
        `<div class="actions"><button class="primary" id="team-add">+ ${tr('בוט חדש', 'New bot')}</button><button class="secondary" id="team-trash">${tr('סל מחזור', 'Trash')}</button></div>`,
      ) +
      `<div class="card-grid">${bots
        .map(b => {
          const manager = botById(b.managerBotId),
            reports = bots.filter(x => x.managerBotId === b.id),
            running = jobsFor(b.id);
          return `<div class="card team-card">${avatar(b, 'large')}<h3>${esc(b.name)}</h3><p>${esc(b.title)}</p>${manager ? `<p class="manager-label">${tr('מנהל', 'Reports to')}: ${esc(manager.name)}</p>` : ''}${reports.length ? `<div class="team-reports">${reports.map(r => `<span class="badge">${esc(r.name)}</span>`).join('')}</div>` : ''}<p class="small muted">${running.length ? tr(`${running.length} משימות פעילות`, `${running.length} active tasks`) : tr('זמין למשימה', 'Ready for a task')}${b.hidden ? ' · ' + tr('מוסתר בסרגל', 'Hidden in sidebar') : ''}</p><div class="actions"><button class="secondary" data-team-chat="${b.id}">${tr('פתיחת שיחה', 'Open chat')}</button><button class="secondary" data-team-edit="${b.id}">${tr('ניהול', 'Manage')}</button></div></div>`;
        })
        .join('')}</div>`;
    if (!bots.length)
      html += `<div class="blank">${tr('אין בוטים פעילים. צור בוט חדש או שחזר בוט מסל המחזור.', 'No active bots. Create a bot or restore one from Trash.')}</div>`;
  }

  if (view === 'library') {
    html =
      intro(
        tr('העבודה, במקום אחד.', 'Good work, all in one place.'),
        tr('קבצים ודפים שהבוטים שלך יצרו ופרסמו.', 'Files and pages published by your teammates.'),
      ) +
      `<div class="card-grid">${[...state.artifacts]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned))
        .map(
          a =>
            `<div class="card"><span class="badge">${esc(a.path.split('.').at(-1).toUpperCase())}</span><h3>${esc(a.title)}</h3><p>${esc(botById(a.botId)?.name)} · ${new Date(a.createdAt).toLocaleDateString()}</p><div class="actions"><button class="secondary" data-artifact="${a.id}">${tr('פתיחה', 'Open')}</button><a class="secondary" href="/files/${a.id}?download" download>${icon('download')}</a><button class="icon" data-pin-artifact="${a.id}" title="Pin" aria-label="Pin">${a.pinned ? '●' : icon('pin')}</button></div></div>`,
        )
        .join('')}</div>`;
    if (!state.artifacts.length)
      html += `<div class="blank" dir="${direction()}">${tr('בקש מבוט ליצור קובץ או דף ולפרסם אותו בספרייה.', 'Ask a bot to create a file or page and publish it to the Library.')}</div>`;
  }
  if (view === 'routines') {
    html =
      intro(
        tr('עבודה שחוזרת מעצמה.', 'A little less to remember.'),
        tr(
          'השרת מפעיל את השגרות כל עוד הוא פועל.',
          'Routines keep working while your host is running.',
        ),
        `<button class="primary" id="new-routine">+ ${tr('שגרה חדשה', 'New routine')}</button>`,
      ) +
      state.routines
        .map(
          r =>
            `<div class="list-row">${avatar(botById(r.botId))}<div><h3>${esc(r.name)}</h3><p>${esc(scheduleLabel(r))} · ${esc(botById(r.botId)?.name)}</p></div><span class="badge">${r.enabled ? tr('פעיל', 'Active') : tr('מושהה', 'Paused')}</span><button class="icon" data-routine="${r.id}" aria-label="Edit routine">${icon('edit')}</button></div>`,
        )
        .join('');
    if (!state.routines.length)
      html += `<div class="blank" dir="${direction()}">${tr('סיכום בוקר, בדיקה שבועית, מחקר קבוע — תן לבוט שגרה.', 'Morning briefings, weekly checks, regular research. Give a bot a routine.')}</div>`;
  }
  if (view === 'skills') {
    html =
      intro(
        tr('ללמד פעם אחת. להשתמש שוב.', 'Teach once. Use again.'),
        tr('הוראות עבודה משותפות לכל הבוטים.', 'A shared library of repeatable workflows.'),
        `<button class="primary" id="new-skill">+ ${tr('מיומנות חדשה', 'New skill')}</button>`,
      ) +
      `<div class="card-grid">${state.skills.map(s => `<div class="card">${icon('spark')}<h3>${esc(s.name)}</h3>${s.botId ? `<small>${esc(botById(s.botId)?.name || '')}</small>` : ''}<p>${esc(s.instructions.slice(0, 180))}</p><div class="actions"><button class="secondary" data-use-skill="${s.id}">${tr('שימוש', 'Use')}</button><button class="icon" data-delete-skill="${s.id}" aria-label="Remove skill">×</button></div></div>`).join('')}</div>`;
    if (!state.skills.length)
      html += `<div class="blank" dir="${direction()}">${tr('אפשר לבקש מהבוט לשמור תהליך שהצליח כמיומנות.', 'Ask a bot to save a successful workflow as a skill.')}</div>`;
  }

  if (view === 'activity') {
    const ordered = [...state.jobs].reverse();
    html =
      intro(
        tr('מה קורה בצוות.', 'What your team is up to.'),
        tr(
          'עקוב אחרי העברת עבודה, משימות משנה ותוצאות שחזרו לבוט המנהל.',
          'Follow delegation, subtasks, and results returned to the manager.',
        ),
      ) +
      ordered
        .map(j => {
          const parent = state.jobs.find(p => p.id === j.parentJobId),
            returned = state.jobs.find(p => p.id === j.resultForJobId),
            childCount = state.jobs.filter(c => c.parentJobId === j.id).length;
          return `<div class="list-row task-row ${parent ? 'delegated-task' : ''}">${avatar(botById(j.botId))}<div><h3>${esc(botById(j.botId)?.name)} <span class="muted small">${j.resultForJobId ? tr('איסוף תוצאה', 'Result follow-up') : parent ? tr('משימת צוות', 'Delegated task') : j.source === 'user' ? tr('בקשת משתמש', 'Your request') : esc(j.source)}</span></h3>${parent ? `<p class="task-parent">${esc(botById(parent.botId)?.name)} → ${esc(botById(j.botId)?.name)}</p>` : ''}<p dir="auto">${esc(j.text.slice(0, 150))}</p>${j.error ? `<p class="error">${esc(withoutProgramOutput(j.error, tr))}</p>` : ''}${j.reportedAt ? `<p class="result-delivered">${tr('התוצאה נמסרה חזרה', 'Result delivered back')}</p>` : ''}${childCount ? `<p class="small muted">${tr(`${childCount} משימות משנה`, `${childCount} subtasks`)}</p>` : ''}</div><span class="status ${j.status}">${statusLabel(j.status)}</span><button class="secondary" data-task="${j.id}">${tr('פרטים', 'Details')}</button><button class="icon" data-job-chat="${j.chatId}" aria-label="Open conversation">↗</button></div>`;
        })
        .join('');
    if (!state.jobs.length)
      html += `<div class="blank" dir="${direction()}">${tr('המשימה הראשונה שלך תופיע כאן.', 'Your first task will appear here.')}</div>`;
  }
  el.innerHTML = `<div class="page">${html}</div>`;
  bindArtifacts(el);
  el.querySelectorAll('[data-task]').forEach(b => (b.onclick = () => taskDetails(b.dataset.task)));
  el.querySelectorAll('[data-team-chat]').forEach(
    b => (b.onclick = act(() => openBotChat(b.dataset.teamChat))),
  );
  el.querySelectorAll('[data-team-edit]').forEach(
    b => (b.onclick = () => botForm(botById(b.dataset.teamEdit))),
  );
  if ($('#team-add')) $('#team-add').onclick = () => botForm();
  if ($('#team-trash')) $('#team-trash').onclick = trashView;
  if ($('#team-root-filter'))
    $('#team-root-filter').onchange = e => {
      teamRootFilter = e.target.value;
      renderPage();
    };
  el.querySelectorAll('[data-exchange-chat]').forEach(
    b => (b.onclick = act(() => openChat(b.dataset.exchangeChat))),
  );
  if (view === 'teamtalk') el.scrollTop = changed || nearBottom ? el.scrollHeight : previousScroll;
  el.querySelectorAll('[data-pin-artifact]').forEach(
    b =>
      (b.onclick = act(async () => {
        const a = state.artifacts.find(a => a.id === b.dataset.pinArtifact);
        await api(`/api/artifacts/${a.id}`, { pinned: !a.pinned }, 'PATCH');
        await refresh();
      })),
  );
  if ($('#new-routine')) $('#new-routine').onclick = () => routineForm();
  el.querySelectorAll('[data-routine]').forEach(
    b => (b.onclick = () => routineDetails(state.routines.find(r => r.id === b.dataset.routine))),
  );
  if ($('#new-skill')) $('#new-skill').onclick = skillForm;
  el.querySelectorAll('[data-use-skill]').forEach(
    b => (b.onclick = () => useSkill(state.skills.find(s => s.id === b.dataset.useSkill))),
  );
  el.querySelectorAll('[data-delete-skill]').forEach(
    b =>
      (b.onclick = act(async () => {
        await api(`/api/skills/${b.dataset.deleteSkill}`, {}, 'DELETE');
        await refresh();
      })),
  );
  el.querySelectorAll('[data-job-chat]').forEach(
    b => (b.onclick = act(() => openChat(b.dataset.jobChat))),
  );
}
function bindArtifacts(el) {
  el.querySelectorAll('[data-artifact]').forEach(
    b =>
      (b.onclick = () => {
        const a = state.artifacts.find(a => a.id === b.dataset.artifact);
        if (!a) return;
        modal(
          a.title,
          `<iframe class="preview-frame" sandbox="allow-scripts" src="/files/${a.id}" title="${esc(a.title)}"></iframe><div class="actions"><a class="secondary" href="/files/${a.id}?download">${tr('הורדה', 'Download')}</a></div>`,
          true,
        );
      }),
  );
}
let composerModelBotId = null,
  botModelPopover = null;
function composerSettingsBot() {
  const members =
    activeChat()
      ?.botIds.map(botById)
      .filter(bot => bot && !bot.deletedAt) || [];
  return members.find(bot => bot.id === composerModelBotId) || members[0];
}
function renderComposerModelControls() {
  const bar = $('#composer-model-controls');
  if (!bar) return;
  const bot = composerSettingsBot(),
    chat = activeChat();
  if (view !== 'chat' || !bot) {
    bar.innerHTML = '';
    closeBotModelPopover();
    return;
  }
  if (
    botModelPopover &&
    (botModelPopover.botId !== bot.id ||
      botModelPopover.chatId !== chat.id ||
      (!botModelPopover.saving && botModelPopover.provider !== botProvider(bot)))
  )
    closeBotModelPopover();
  const provider = botProvider(bot),
    catalog = providerAccount(provider),
    values = botModelValues(bot),
    context = botModelContext(
      values,
      catalog?.models,
      providerModelDefaults(provider, state.settings, catalog),
    );
  if (!catalog && !providerRequests.has(provider)) loadProviderAccount(provider).catch(() => {});
  const modelName =
      context.model?.displayName ||
      context.id ||
      (context.unresolvedDefault
        ? tr('ברירת המחדל אינה זמינה', 'Default unavailable')
        : providerDefaultLabel(provider)),
    effort = values.reasoningEffort || context.model?.defaultReasoningEffort;
  const tier = values.serviceTier || context.model?.defaultServiceTier,
    fast = tier && tier !== 'default';
  bar.dir = direction();
  bar.innerHTML =
    (chat.type === 'group'
      ? '<label class="composer-model-bot-label" for="composer-model-bot">' +
        tr('הגדרות עבור', 'Settings for') +
        '</label><select id="composer-model-bot" aria-label="' +
        tr('הבוט שאת הגדרותיו משנים', 'Bot whose settings you are changing') +
        '">' +
        chat.botIds
          .map(botById)
          .filter(item => item && !item.deletedAt)
          .map(
            item =>
              '<option value="' +
              item.id +
              '" ' +
              (item.id === bot.id ? 'selected' : '') +
              '>' +
              esc(item.name) +
              '</option>',
          )
          .join('') +
        '</select>'
      : '') +
    '<button type="button" class="composer-model-button" id="composer-model-picker" aria-haspopup="dialog" aria-expanded="' +
    !!botModelPopover +
    '" title="' +
    tr('ספק, מודל, רמת חשיבה ומהירות', 'Provider, model, reasoning effort and speed') +
    '"><span class="provider-badge ' +
    provider +
    '" dir="ltr">' +
    esc(providerName(provider)) +
    '</span><span class="composer-model-name" dir="ltr" title="' +
    esc(context.id) +
    '">' +
    esc(modelName) +
    '</span><span class="composer-effort">' +
    esc(effort ? botEffortLabel(effort) : tr('אוטומטי', 'Auto')) +
    '</span>' +
    (context.tiers.length
      ? '<span class="composer-speed ' +
        (fast ? 'fast' : '') +
        '" aria-label="' +
        tr('רמת מהירות', 'Speed level') +
        '">' +
        modelLightning() +
        '</span>'
      : '') +
    '<span class="composer-model-chevron">⌄</span></button>';
  $('#composer-model-picker').onclick = () =>
    botModelPopover ? closeBotModelPopover(true) : openBotModelPopover(bot);
  $('#composer-model-bot')?.addEventListener('change', event => {
    composerModelBotId = event.target.value;
    reconcileVoiceContext();
    closeBotModelPopover();
    renderComposerModelControls();
    renderVoicePanel();
  });
  if (botModelPopover) positionBotModelPopover(botModelPopover);
}
function modelLightning() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 3-8 11h6l-1 7 9-12h-6l1-6Z"/></svg>';
}
function modelResetIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a8 8 0 1 1 2 7M4 5v6h6"/></svg>';
}
function providerOptions(selected) {
  return availableProviderIds(
    connectionSettings?.connections || [],
    state?.providers || [],
    state?.bots || [],
    selected,
  )
    .map(
      provider =>
        '<option value="' +
        provider +
        '" ' +
        (selected === provider ? 'selected' : '') +
        '>' +
        esc(providerOptionName(provider)) +
        '</option>',
    )
    .join('');
}
function modelGroupLabel(kind) {
  return (
    {
      default: tr('ברירת המחדל של החשבון', 'Account default'),
      version: tr('גרסאות מדויקות', 'Exact versions'),
      alias: tr('משפחות — מתעדכנות אוטומטית', 'Families — updated automatically'),
      models: tr('מודלים', 'Models'),
    }[kind] || kind
  );
}
function modelSelectionNote(model) {
  return model?.selectionKind === 'version'
    ? tr('בחירה לפי מזהה הגרסה', 'Selected by version ID')
    : model?.selectionKind === 'alias'
      ? tr(
          'משפחה מתעדכנת; הגרסה נקבעת ב־Claude Code',
          'Rolling family; Claude Code selects the version',
        )
      : '';
}
function modelOptionsMarkup(models, selected) {
  return modelChoiceGroups(models)
    .map(group => {
      const options = group.models
        .map(
          model =>
            '<option value="' +
            esc(modelId(model)) +
            '" title="' +
            esc(modelId(model)) +
            '" ' +
            (selected === modelId(model) ? 'selected' : '') +
            '>' +
            esc(model.displayName || modelId(model)) +
            '</option>',
        )
        .join('');
      return group.kind === 'models'
        ? options
        : '<optgroup label="' + esc(modelGroupLabel(group.kind)) + '">' + options + '</optgroup>';
    })
    .join('');
}
function closeBotModelPopover(focus = false) {
  if (!botModelPopover) return;
  botModelPopover.cleanup?.();
  botModelPopover.node.remove();
  botModelPopover = null;
  $('#composer-model-picker')?.setAttribute('aria-expanded', 'false');
  if (focus) $('#composer-model-picker')?.focus();
}
function positionBotModelPopover(session) {
  if (botModelPopover !== session) return;
  const rect = $('#composer-model-picker')?.getBoundingClientRect();
  if (!rect) return;
  session.node.style.left =
    Math.max(8, Math.min(rect.left, innerWidth - session.node.offsetWidth - 8)) + 'px';
  const above = rect.top - session.node.offsetHeight - 10;
  session.node.style.top =
    Math.max(
      8,
      above >= 8 ? above : Math.min(rect.bottom + 8, innerHeight - session.node.offsetHeight - 8),
    ) + 'px';
}
function botPopoverCurrent(session) {
  return (
    botModelPopover === session &&
    session.node.isConnected &&
    view === 'chat' &&
    activeChat()?.id === session.chatId
  );
}
async function openBotModelPopover(bot) {
  closeBotModelPopover();
  const node = document.createElement('div');
  node.className = 'model-popover';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', tr('מודל וביצועים של ', 'Model and performance for ') + bot.name);
  node.dir = direction();
  document.body.append(node);
  const provider = botProvider(bot),
    catalog = providerAccount(provider);
  const session = {
    node,
    botId: bot.id,
    chatId: activeChat().id,
    provider,
    values: botModelValues(bot),
    original: botModelValues(bot),
    models: Array.isArray(catalog?.models) ? catalog.models : [],
    defaultModel: catalog?.defaultModel || '',
    defaultModelKnown: catalog?.defaultModelKnown,
    defaultModelError: catalog?.defaultModelError || '',
    loading: true,
    saving: false,
    error: '',
    notice: '',
    pane: 'main',
    focusTarget: 'model-effort-slider',
    request: 0,
  };
  botModelPopover = session;
  const outside = event => {
    if (!node.contains(event.target) && !event.target.closest('#composer-model-picker'))
      closeBotModelPopover();
  };
  const resize = () => closeBotModelPopover();
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', resize);
  session.cleanup = () => {
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', resize);
  };
  node.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (session.pane !== 'main') {
        session.focusTarget =
          session.pane === 'model' ? 'model-popover-model' : 'model-popover-speed';
        session.pane = 'main';
        renderBotModelPopover(session);
      } else closeBotModelPopover(true);
    }
  };
  renderBotModelPopover(session);
  $('#composer-model-picker')?.setAttribute('aria-expanded', 'true');
  await loadBotModelPopover(session);
}
async function loadBotModelPopover(session) {
  if (!botPopoverCurrent(session)) return;
  session.focusTarget = session.pane === 'main' ? 'model-effort-slider' : 'choice';
  const request = ++session.request,
    provider = session.provider;
  session.loading = true;
  session.error = '';
  renderBotModelPopover(session);
  try {
    const result = await loadProviderAccount(provider);
    if (!botPopoverCurrent(session) || request !== session.request || provider !== session.provider)
      return;
    session.models = Array.isArray(result.models) ? result.models : [];
    session.defaultModel = result.defaultModel || '';
    session.defaultModelKnown = result.defaultModelKnown;
    session.defaultModelError = result.defaultModelError || '';
    session.error =
      modelCatalogLoadError(result) ||
      (result.modelsStale
        ? tr('הקטלוג אינו עדכני. נסה שוב.', 'The catalog is stale. Retry.')
        : '') ||
      (!session.models.length
        ? tr('לא התקבלו מודלים מהחשבון.', 'No account models were returned.')
        : '');
  } catch (error) {
    if (botPopoverCurrent(session) && request === session.request) session.error = error.message;
  } finally {
    if (botPopoverCurrent(session) && request === session.request) {
      session.loading = false;
      renderBotModelPopover(session);
    }
  }
}
function renderBotModelPopover(session) {
  if (!botPopoverCurrent(session)) return;
  const context = botModelContext(session.values, session.models, botModelDefaults(session)),
    value = session.values,
    bot = botById(session.botId);
  const ready = !session.loading && !session.saving && !session.error,
    { effort, index, options: effortOptions } = botEffortControl(value, context);
  const modelName =
    context.model?.displayName || context.id || providerDefaultLabel(session.provider);
  const tier = value.serviceTier || context.model?.defaultServiceTier,
    fast = tier && tier !== 'default';
  const tierName = id =>
    id === 'default' || (!id && context.available)
      ? tr('רגילה', 'Standard')
      : !id
        ? tr('לפי המודל', 'Model default')
        : context.tiers.find(item => item.id === id)?.name || id;
  const unavailable =
    context.unresolvedDefault ||
    (!context.available && !!context.id) ||
    (value.reasoningEffort && index < 0) ||
    (value.serviceTier &&
      value.serviceTier !== 'default' &&
      !context.tiers.some(item => item.id === value.serviceTier));
  let content = '';
  if (session.pane === 'main') {
    content =
      '<div class="model-popover-top" dir="ltr"><button type="button" class="model-small-icon" id="model-popover-reset" aria-label="' +
      tr('איפוס לברירות מחדל', 'Reset to defaults') +
      '" title="' +
      tr('איפוס לברירות מחדל', 'Reset to defaults') +
      '" ' +
      (!ready ? 'disabled' : '') +
      '>' +
      modelResetIcon() +
      '</button><strong id="model-popover-effort">' +
      esc(effort ? botEffortLabel(effort) : tr('אוטומטי', 'Auto')) +
      '</strong>' +
      (context.tiers.length
        ? '<button type="button" class="model-small-icon ' +
          (fast ? 'active' : '') +
          '" id="model-popover-speed" aria-label="' +
          tr('רמת מהירות: ', 'Speed level: ') +
          esc(tierName(tier)) +
          '" title="' +
          tr('רמת מהירות: ', 'Speed level: ') +
          esc(tierName(tier)) +
          '" ' +
          (!ready ? 'disabled' : '') +
          '>' +
          modelLightning() +
          '</button>'
        : '<span class="model-small-icon" aria-hidden="true"></span>') +
      '</div>' +
      '<button type="button" class="model-popover-model" id="model-popover-model" dir="ltr" title="' +
      esc(context.id) +
      '" ' +
      (!ready ? 'disabled' : '') +
      '><span>‹</span> ' +
      esc(modelName) +
      '</button>' +
      (context.efforts.length
        ? '<div class="model-effort-track ' +
          (!ready || index < 0 ? 'disabled' : '') +
          '" dir="ltr"><div class="model-effort-stops" aria-hidden="true">' +
          effortOptions
            .map(
              (item, i) =>
                '<i style="left:' +
                (effortOptions.length === 1 ? 50 : (i / (effortOptions.length - 1)) * 100) +
                '%"></i>',
            )
            .join('') +
          '</div><input id="model-effort-slider" type="range" min="0" max="' +
          Math.max(0, effortOptions.length - 1) +
          '" step="1" value="' +
          Math.max(0, index) +
          '" aria-label="' +
          tr('רמת חשיבה', 'Reasoning effort') +
          '" aria-valuetext="' +
          esc(effort ? botEffortLabel(effort) : tr('אוטומטי', 'Auto')) +
          '" ' +
          (!ready || index < 0 ? 'disabled' : '') +
          '></div>'
        : '') +
      '<p class="model-popover-inherit">' +
      (value.model
        ? modelSelectionNote(context.model) || tr('מודל אישי לבוט', 'This bot’s model')
        : providerInheritLabel(session.provider)) +
      (context.efforts.length
        ? ' · ' +
          (!value.reasoningEffort
            ? tr('חשיבה לפי ברירת המחדל', 'Default reasoning')
            : tr('חשיבה מותאמת', 'Custom reasoning'))
        : '') +
      (context.tiers.length ? ' · ' + esc(tierName(tier)) : '') +
      '</p>';
  } else {
    const modelPane = session.pane === 'model';
    content =
      '<div class="model-choice-heading"><button type="button" id="model-choice-back" class="model-small-icon" aria-label="' +
      tr('חזרה', 'Back') +
      '">‹</button><strong>' +
      tr(modelPane ? 'בחירת מודל' : 'רמת מהירות', modelPane ? 'Choose model' : 'Speed level') +
      '</strong></div><div class="model-choice-list">';
    const inherited = session.models.find(item => modelId(item) === context.inheritedId);
    const options = modelPane
      ? [
          {
            id: '',
            name: providerInheritLabel(session.provider),
            description:
              inherited?.displayName ||
              context.inheritedId ||
              (session.defaultModelKnown === false
                ? tr('לא זמין כרגע', 'Currently unavailable')
                : providerDefaultLabel(session.provider)),
          },
          ...modelChoiceGroups(context.visible).flatMap(group =>
            group.models.map((item, index) => ({
              id: modelId(item),
              name: item.displayName || modelId(item),
              description: providerText(item.description, tr),
              selectionNote: modelSelectionNote(item),
              modelId: item.selectionKind ? modelId(item) : '',
              groupLabel: index === 0 && group.kind !== 'models' ? modelGroupLabel(group.kind) : '',
            })),
          ),
        ]
      : [
          {
            id: '',
            name: tr('ברירת המחדל של המודל', 'Model default'),
            description: tierName(context.model?.defaultServiceTier),
          },
          { id: 'default', name: tr('רגילה', 'Standard'), description: '' },
          ...context.tiers,
        ];
    content +=
      options
        .map(
          (item, i) =>
            (item.groupLabel
              ? '<div class="model-choice-group">' + esc(item.groupLabel) + '</div>'
              : '') +
            '<button type="button" class="model-choice ' +
            ((modelPane ? value.model : value.serviceTier) === item.id ? 'selected' : '') +
            '" data-model-choice="' +
            i +
            '" title="' +
            esc(item.modelId || item.id) +
            '" ' +
            (!ready ? 'disabled' : '') +
            '><span><strong>' +
            esc(item.name) +
            '</strong>' +
            (item.selectionNote ? '<small>' + esc(item.selectionNote) + '</small>' : '') +
            (item.modelId
              ? '<code class="model-choice-id" dir="ltr">' + esc(item.modelId) + '</code>'
              : '') +
            (item.description ? '<small dir="auto">' + esc(item.description) + '</small>' : '') +
            '</span>' +
            ((modelPane ? value.model : value.serviceTier) === item.id ? icon('check') : '') +
            '</button>',
        )
        .join('') + '</div>';
    session.options = options;
  }
  session.node.innerHTML =
    content +
    '<div class="model-provider-row"><label for="model-popover-provider">' +
    tr('מנוע', 'Provider') +
    '</label><select id="model-popover-provider" ' +
    (session.saving ? 'disabled' : '') +
    '>' +
    providerOptions(session.provider) +
    '</select><button type="button" class="model-small-icon" id="model-add-provider" title="' +
    tr('הוספת ספק API', 'Add API provider') +
    '" aria-label="' +
    tr('הוספת ספק API', 'Add API provider') +
    '">+</button></div><div class="model-popover-status" role="status">' +
    (session.loading
      ? esc(tr('טוען מהחשבון…', 'Loading account options…'))
      : session.saving
        ? esc(tr('שומר…', 'Saving…'))
        : session.error
          ? '<span class="error">' +
            esc(session.error) +
            '</span><button type="button" id="model-popover-retry">' +
            tr('ניסיון נוסף', 'Retry') +
            '</button><button type="button" id="model-provider-connect">' +
            tr('הגדרת החיבור', 'Set up connection') +
            '</button>'
          : unavailable
            ? esc(
                tr(
                  'הגדרה שמורה אינה זמינה; בחר מודל זמין או אפס.',
                  'A saved setting is unavailable; choose an available model or reset.',
                ),
              )
            : esc(
                session.notice ||
                  tr(
                    'נשמר לבוט ' + (bot?.name || '') + ' · מהמשימה הבאה',
                    'Saved for ' + (bot?.name || 'this bot') + ' · next task',
                  ),
              )) +
    '</div>' +
    '<p class="model-popover-allowance">' +
    tr(
      'מאמץ ומהירות גבוהים עשויים לצרוך יותר מהמכסה.',
      'Higher effort and speed may use more allowance.',
    ) +
    '</p>';
  $('#model-popover-reset')?.addEventListener('click', () =>
    saveBotModelPopover(
      session,
      botModelValues(),
      tr('ברירות המחדל הוחזרו.', 'Defaults restored.'),
    ),
  );
  $('#model-popover-model')?.addEventListener('click', () => {
    session.pane = 'model';
    session.focusTarget = 'choice';
    renderBotModelPopover(session);
  });
  $('#model-popover-speed')?.addEventListener('click', () => {
    session.pane = 'speed';
    session.focusTarget = 'choice';
    renderBotModelPopover(session);
  });
  $('#model-choice-back')?.addEventListener('click', () => {
    session.focusTarget = session.pane === 'model' ? 'model-popover-model' : 'model-popover-speed';
    session.pane = 'main';
    renderBotModelPopover(session);
  });
  $('#model-popover-retry')?.addEventListener('click', () => loadBotModelPopover(session));
  $('#model-popover-provider').onchange = event =>
    saveBotProviderPopover(session, event.target.value);
  $('#model-add-provider').onclick = act(async () => {
    closeBotModelPopover();
    await settings('connections');
    if (settingsIsOpen(settingsSession, 'connections')) {
      settingsSession.newConnectionOpen = true;
      renderConnectionsSettings();
      $('#new-api-key')?.focus();
    }
  });
  $('#model-provider-connect')?.addEventListener('click', () => {
    closeBotModelPopover();
    settings(isConnectionProvider(session.provider) ? 'connections' : 'general');
  });
  const slider = $('#model-effort-slider');
  if (slider) {
    slider.oninput = () => {
      const choice = effortOptions[Number(slider.value)]?.reasoningEffort,
        label = choice ? botEffortLabel(choice) : tr('אוטומטי', 'Auto');
      $('#model-popover-effort').textContent = label;
      slider.setAttribute('aria-valuetext', label);
    };
    slider.onchange = () =>
      saveBotModelPopover(session, {
        ...value,
        reasoningEffort: effortOptions[Number(slider.value)].reasoningEffort,
      });
  }
  session.node.querySelectorAll('[data-model-choice]').forEach(
    button =>
      (button.onclick = () => {
        const option = session.options[Number(button.dataset.modelChoice)];
        if (session.pane === 'model') {
          const changed = changeBotModel(
            value,
            option.id,
            session.models,
            botModelDefaults(session),
          );
          saveBotModelPopover(
            session,
            changed.values,
            changed.reset.length
              ? tr(
                  'האפשרויות שאינן נתמכות הוחזרו לברירת המחדל.',
                  'Unsupported options returned to model defaults.',
                )
              : '',
          );
        } else saveBotModelPopover(session, { ...value, serviceTier: option.id });
      }),
  );
  positionBotModelPopover(session);
  if (!session.loading && !session.saving && session.focusTarget) {
    const target =
      session.focusTarget === 'choice'
        ? session.node.querySelector('.model-choice.selected:not([disabled])') ||
          session.node.querySelector('.model-choice:not([disabled])')
        : session.node.querySelector('#' + session.focusTarget);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else session.node.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
    session.focusTarget = null;
  }
}
async function saveBotModelPopover(session, values, notice = '') {
  if (!botPopoverCurrent(session) || session.saving || session.loading) return;
  const errors = validateBotModelValues(
    values,
    session.original,
    session.models,
    botModelDefaults(session),
    { catalogReady: !session.error },
  );
  if (errors.length) {
    session.error = errors.map(botModelErrorLabel).join(' ');
    renderBotModelPopover(session);
    return;
  }
  session.focusTarget =
    session.pane === 'model'
      ? 'model-popover-model'
      : session.pane === 'speed'
        ? 'model-popover-speed'
        : document.activeElement?.id || 'model-effort-slider';
  session.saving = true;
  session.error = '';
  renderBotModelPopover(session);
  try {
    const saved = await api(
        '/api/bots/' + session.botId,
        { ...values, provider: session.provider },
        'PATCH',
      ),
      bot = botById(session.botId);
    if (bot) Object.assign(bot, saved);
    if (botPopoverCurrent(session)) {
      session.values = botModelValues(saved);
      session.original = { ...session.values };
      session.notice = notice;
      session.pane = 'main';
    }
    renderComposerModelControls();
  } catch (error) {
    if (botPopoverCurrent(session)) session.error = error.message;
  } finally {
    if (botPopoverCurrent(session)) {
      session.saving = false;
      renderBotModelPopover(session);
    }
  }
}
async function saveBotProviderPopover(session, provider) {
  if (!botPopoverCurrent(session) || session.saving || provider === session.provider) return;
  const values = changeBotProvider({ provider: session.provider, ...session.values }, provider);
  session.request++;
  session.saving = true;
  session.loading = false;
  session.error = '';
  renderBotModelPopover(session);
  try {
    const saved = await api('/api/bots/' + session.botId, values, 'PATCH'),
      bot = botById(session.botId);
    if (bot) Object.assign(bot, saved);
    if (!botPopoverCurrent(session)) return;
    session.provider = botProvider(saved);
    session.values = botModelValues(saved);
    session.original = { ...session.values };
    session.models = [];
    session.defaultModel = '';
    session.defaultModelKnown = undefined;
    session.defaultModelError = '';
    session.pane = 'main';
    session.notice = tr(
      'המנוע עודכן; בחירת המודל והביצועים אופסה.',
      'Provider changed; model and performance choices were reset.',
    );
    renderComposerModelControls();
  } catch (error) {
    if (botPopoverCurrent(session)) {
      session.error = error.message;
      renderBotModelPopover(session);
    }
  } finally {
    if (botPopoverCurrent(session)) {
      session.saving = false;
      renderBotModelPopover(session);
    }
  }
  if (botPopoverCurrent(session) && session.provider === provider)
    await loadBotModelPopover(session);
}
function botEffortLabel(value) {
  return (
    {
      none: tr('ללא', 'None'),
      minimal: tr('מינימלית', 'Minimal'),
      low: tr('נמוכה', 'Low'),
      medium: tr('בינונית', 'Medium'),
      high: tr('גבוהה', 'High'),
      xhigh: tr('גבוהה מאוד', 'Extra high'),
      max: tr('מרבית', 'Max'),
      ultra: tr('אולטרה', 'Ultra'),
    }[value] || value
  );
}
function botModelFormActive(session) {
  return $('#modal').open && $('#modal').dataset.kind === 'bot' && $('#bot-form') === session.form;
}
function modelCatalogLoadError(result) {
  return (
    (result.modelsError && result.modelsError !== result.defaultModelError
      ? result.modelsError
      : '') ||
    withoutProgramOutput(result.error, tr) ||
    ''
  );
}
function botModelDefaults(session) {
  return providerModelDefaults(session.provider || 'codex', state?.settings, session);
}
function botFormModelOriginal(session) {
  return session.provider === session.originalProvider ? session.original : botModelValues();
}
function botModelErrorLabel(key) {
  return (
    {
      defaultModel: tr(
        'ברירת המחדל של המנוע אינה זמינה כרגע. בחר מודל מפורש או נסה שוב.',
        'The provider default is unavailable. Choose an explicit model or retry.',
      ),
      catalog: tr(
        'יש לטעון את קטלוג המודלים לפני שינוי ההגדרות.',
        'Load the model catalog before changing these settings.',
      ),
      model: tr(
        'המודל שנבחר אינו זמין. בחר מודל זמין או השתמש בברירת המחדל.',
        'This model is unavailable. Select an available model or inherit the default.',
      ),
      reasoningEffort: tr(
        'רמת החשיבה אינה נתמכת במודל שנבחר.',
        'This reasoning effort is not supported by the selected model.',
      ),
      serviceTier: tr(
        'המהירות אינה נתמכת במודל שנבחר.',
        'This speed is not supported by the selected model.',
      ),
    }[key] || key
  );
}
function renderBotModelControls(session) {
  if (!botModelFormActive(session)) return;
  const defaults = botModelDefaults(session),
    context = botModelContext(session.values, session.models, defaults),
    value = session.values;
  const inheritedModel = session.models.find(model => modelId(model) === context.inheritedId);
  const inheritedName =
    inheritedModel?.displayName ||
    context.inheritedId ||
    (session.defaultModelKnown === false
      ? tr('לא זמין כרגע', 'Currently unavailable')
      : providerDefaultLabel(session.provider));
  const ready = session.catalogReady && !session.loading,
    unavailable = tr('לא זמין כרגע', 'Currently unavailable');
  const option = (id, label, selected, extra = '') =>
    '<option value="' +
    esc(id) +
    '" ' +
    (selected ? 'selected ' : '') +
    extra +
    '>' +
    esc(label) +
    '</option>';
  const missingModel =
    value.model && !context.visible.some(model => modelId(model) === value.model);
  const missingEffort =
    value.reasoningEffort &&
    !context.efforts.some(item => item.reasoningEffort === value.reasoningEffort);
  const missingTier =
    value.serviceTier &&
    value.serviceTier !== 'default' &&
    !context.tiers.some(item => item.id === value.serviceTier);
  const effortDefault = context.model?.defaultReasoningEffort,
    defaultTier = context.model?.defaultServiceTier;
  const tierName = id =>
    id === 'default' || (!id && context.available)
      ? tr('רגילה', 'Standard')
      : !id
        ? tr('לפי המודל', 'Model default')
        : context.tiers.find(item => item.id === id)?.name || id;
  const errors = validateBotModelValues(
    value,
    botFormModelOriginal(session),
    session.models,
    defaults,
    { catalogReady: ready },
  );
  session.errors = errors;
  const unchanged =
    session.provider === session.originalProvider &&
    Object.keys(session.original).every(key => value[key] === session.original[key]);
  const preserved = unchanged && (missingModel || missingEffort || missingTier);
  const controls = $('#bot-model-controls');
  controls.innerHTML =
    '<div class="bot-model-heading"><div>' +
    icon('spark') +
    '<h3>' +
    tr('מודל וביצועים', 'Model & performance') +
    '</h3></div><button type="button" class="bot-model-reset" id="bot-model-reset">' +
    tr('שימוש בברירות מחדל', 'Use defaults') +
    '</button></div>' +
    '<p class="bot-model-intro">' +
    tr('הגדרות נפרדות לבוט הזה.', 'Independent settings for this bot.') +
    '</p>' +
    '<label for="bot-provider">' +
    tr('מנוע', 'Provider') +
    '</label><select name="provider" id="bot-provider">' +
    providerOptions(session.provider) +
    '</select>' +
    '<label for="bot-model">' +
    tr('מודל', 'Model') +
    '</label><select name="model" id="bot-model" ' +
    (!ready ? 'disabled' : '') +
    '>' +
    (session.loading
      ? option(value.model, tr('טוען מודלים מהחשבון…', 'Loading account models…'), true)
      : option('', providerInheritLabel(session.provider) + ' · ' + inheritedName, !value.model) +
        modelOptionsMarkup(context.visible, value.model) +
        (missingModel ? option(value.model, value.model + ' · ' + unavailable, true) : '')) +
    '</select>' +
    (context.model?.selectionKind
      ? '<p class="bot-model-version-note">' +
        esc(modelSelectionNote(context.model)) +
        ' <code dir="ltr">' +
        esc(context.id) +
        '</code></p>'
      : '') +
    '<p class="bot-model-description" dir="auto">' +
    esc(
      context.available
        ? providerText(context.model.description, tr)
        : !value.model
          ? providerDefaultLabel(session.provider)
          : '',
    ) +
    '</p>' +
    '<div class="bot-model-grid">' +
    (context.efforts.length || missingEffort
      ? '<div><label for="bot-reasoning">' +
        tr('רמת חשיבה', 'Reasoning effort') +
        '</label><select name="reasoningEffort" id="bot-reasoning" ' +
        (!ready || !context.available ? 'disabled' : '') +
        '>' +
        option(
          '',
          tr('ברירת המחדל של המודל', 'Model default') +
            (effortDefault ? ' · ' + botEffortLabel(effortDefault) : ''),
          !value.reasoningEffort,
        ) +
        context.efforts
          .map(item =>
            option(
              item.reasoningEffort,
              botEffortLabel(item.reasoningEffort),
              value.reasoningEffort === item.reasoningEffort,
            ),
          )
          .join('') +
        (missingEffort
          ? option(
              value.reasoningEffort,
              botEffortLabel(value.reasoningEffort) + ' · ' + unavailable,
              true,
            )
          : '') +
        '</select></div>' +
        ''
      : '') +
    (context.tiers.length || missingTier
      ? '<div><label for="bot-speed">' +
        tr('מהירות', 'Speed') +
        '</label><select name="serviceTier" id="bot-speed" ' +
        (!ready || !context.available ? 'disabled' : '') +
        '>' +
        option(
          '',
          tr('ברירת המחדל של המודל', 'Model default') + ' · ' + tierName(defaultTier),
          !value.serviceTier,
        ) +
        option('default', tr('רגילה', 'Standard'), value.serviceTier === 'default') +
        context.tiers
          .map(item => option(item.id, item.name || item.id, value.serviceTier === item.id))
          .join('') +
        (missingTier
          ? option(value.serviceTier, value.serviceTier + ' · ' + unavailable, true)
          : '') +
        '</select></div>'
      : '') +
    '</div>' +
    '<p class="bot-model-description" dir="auto">' +
    esc(
      [
        providerText(
          context.efforts.find(item => item.reasoningEffort === value.reasoningEffort)?.description,
          tr,
        ),
        providerText(context.tiers.find(item => item.id === value.serviceTier)?.description, tr),
      ]
        .filter(Boolean)
        .join(' · '),
    ) +
    '</p>' +
    '<div id="bot-model-feedback" class="bot-model-feedback" role="status">' +
    (session.loading
      ? '<span>' + tr('בודק את אפשרויות החשבון…', 'Checking account options…') + '</span>'
      : '') +
    (session.error
      ? '<p class="error">' +
        esc(session.error) +
        '</p><button type="button" class="secondary" id="bot-model-retry">' +
        tr('טעינה מחדש', 'Retry loading') +
        '</button>' +
        (session.provider === 'claude'
          ? '<p>' +
            tr(
              'אפשר לשמור את הבוט עם ברירות מחדל ולהגדיר את החיבור בהגדרות לפני שליחת משימה.',
              'You can save this bot with defaults, then connect Claude in Settings before sending a task.',
            ) +
            '</p>'
          : '')
      : '') +
    (session.defaultModelError && !defaults.workspaceModel
      ? '<p>' + esc(withoutProgramOutput(session.defaultModelError, tr)) + '</p>'
      : '') +
    (session.notice ? '<p>' + esc(session.notice) + '</p>' : '') +
    (preserved && !session.loading
      ? '<p>' +
        tr(
          'ההגדרה השמורה אינה זמינה כרגע. שמירת פרטי הבוט תשמור אותה ללא שינוי.',
          'The saved configuration is currently unavailable. Saving profile details will preserve it.',
        ) +
        '</p>'
      : '') +
    (!session.loading && errors.length
      ? '<p class="error">' + errors.map(key => esc(botModelErrorLabel(key))).join(' ') + '</p>'
      : '') +
    '</div>' +
    '<p class="bot-model-footnote">' +
    tr(
      'חל מהמשימה הבאה; משימה פעילה לא משתנה. חשיבה מעמיקה יותר ומהירות מוגברת עשויות לצרוך יותר מהמכסה.',
      'Applies from the next task; running work is unchanged. Higher effort and faster service may use more allowance.',
    ) +
    '</p>';
  session.form.querySelector('[type=submit]').disabled = errors.length > 0;
  $('#bot-provider').onchange = event => {
    const next = changeBotProvider(
      { provider: session.provider, ...session.values },
      event.target.value,
    );
    session.provider = next.provider;
    session.values = botModelValues(next);
    session.models = [];
    session.defaultModel = '';
    session.defaultModelKnown = undefined;
    session.defaultModelError = '';
    session.catalogReady = false;
    session.notice = tr(
      'בחירת המודל והביצועים אופסה עבור המנוע החדש.',
      'Model and performance choices were reset for the new provider.',
    );
    loadBotModelCatalog(session);
  };
  $('#bot-model').onchange = event => {
    const changed = changeBotModel(
      session.values,
      event.target.value,
      session.models,
      botModelDefaults(session),
    );
    session.values = changed.values;
    session.notice = changed.reset.length
      ? tr(
          'אפשרויות שאינן נתמכות במודל החדש הוחזרו לברירת המחדל שלו.',
          'Options unsupported by the new model were reset to its defaults.',
        )
      : '';
    renderBotModelControls(session);
    $('#bot-model').focus();
  };
  $('#bot-reasoning')?.addEventListener('change', event => {
    session.values.reasoningEffort = event.target.value;
    session.notice = '';
    renderBotModelControls(session);
    $('#bot-reasoning')?.focus();
  });
  $('#bot-speed')?.addEventListener('change', event => {
    session.values.serviceTier = event.target.value;
    session.notice = '';
    renderBotModelControls(session);
    $('#bot-speed')?.focus();
  });
  $('#bot-model-reset').onclick = () => {
    session.values = botModelValues();
    session.notice = tr(
      'הבוט ישתמש בברירות המחדל של סביבת העבודה והמודל.',
      'This bot will use the workspace and model defaults.',
    );
    renderBotModelControls(session);
  };
  $('#bot-model-retry')?.addEventListener('click', () => loadBotModelCatalog(session));
}
async function loadBotModelCatalog(session) {
  if (!botModelFormActive(session)) return;
  const request = ++session.request;
  session.loading = true;
  session.error = '';
  renderBotModelControls(session);
  try {
    const result = await loadProviderAccount(session.provider);
    if (!botModelFormActive(session) || request !== session.request) return;
    session.models = Array.isArray(result.models) ? result.models : [];
    session.defaultModel = result.defaultModel || '';
    session.defaultModelKnown = result.defaultModelKnown;
    session.defaultModelError = result.defaultModelError || '';
    session.error =
      modelCatalogLoadError(result) ||
      (result.modelsStale
        ? tr(
            'קטלוג המודלים אינו עדכני. נסה לטעון אותו שוב.',
            'The model catalog is stale. Retry loading it.',
          )
        : null) ||
      (!session.models.length
        ? tr(
            'לא התקבל קטלוג מודלים מהחשבון. אפשר לנסות שוב ולשמור את פרטי הבוט בלי לשנות מודל.',
            'No model catalog was returned. Retry, or save profile details without changing model settings.',
          )
        : '');
    session.catalogReady = !session.error;
  } catch (error) {
    if (!botModelFormActive(session) || request !== session.request) return;
    session.error = error.message;
    session.catalogReady = false;
  } finally {
    if (botModelFormActive(session) && request === session.request) {
      session.loading = false;
      renderBotModelControls(session);
      if (session.focusModel) {
        session.focusModel = false;
        $('#bot-model-controls').scrollIntoView({ block: 'nearest' });
        $('#bot-model').focus();
      }
    }
  }
}
function botForm(bot = null, focusModel = false) {
  const editing = !!bot?.id;
  let color = bot?.color || 'violet';
  modal(
    editing ? tr('עריכת הבוט', 'Edit teammate') : tr('הבוט הבא בצוות שלך', 'Your next teammate'),
    '<form id="bot-form"><div style="text-align:center">' +
      avatar(bot || { color }, 'large') +
      '</div><label>' +
      tr('שם', 'Name') +
      '</label><input name="name" maxlength="60" required value="' +
      esc(bot?.name || '') +
      '" placeholder="Alex"><label>' +
      tr('תפקיד קצר', 'Role') +
      '</label><input name="title" maxlength="140" value="' +
      esc(bot?.title || '') +
      '" placeholder="' +
      tr('מחקר, תפעול, פיתוח…', 'Research, operations, engineering…') +
      '"><label>' +
      tr('איך הבוט יעבוד', 'How this bot should work') +
      '</label><textarea name="instructions" rows="4" dir="auto">' +
      esc(bot?.instructions || '') +
      '</textarea><section id="bot-model-controls" class="bot-model-controls"></section><label>' +
      tr('צבע', 'Color') +
      '</label><div class="colors">' +
      Object.entries(colors)
        .map(
          ([key, value]) =>
            '<button type="button" class="color-choice ' +
            (key === color ? 'selected' : '') +
            '" data-color="' +
            key +
            '" style="background:' +
            value +
            '" aria-label="' +
            key +
            '"></button>',
        )
        .join('') +
      '</div>' +
      (editing
        ? '<label>' +
          tr('קבוצה בסרגל הצד', 'Sidebar section') +
          '</label><input name="section" value="' +
          esc(bot.section) +
          '"><label class="toggle-line">' +
          tr('הצמדה לראש הרשימה', 'Pin to top') +
          '<input name="pinned" type="checkbox" ' +
          (bot.pinned ? 'checked' : '') +
          '></label><label class="toggle-line">' +
          tr('הסתרה מסרגל הצד', 'Hide from sidebar') +
          '<input name="hidden" type="checkbox" ' +
          (bot.hidden ? 'checked' : '') +
          '></label>'
        : '') +
      '<div class="actions"><button class="primary" type="submit">' +
      (editing ? tr('שמירת שינויים', 'Save changes') : tr('יצירת בוט', 'Create teammate')) +
      '</button>' +
      (editing
        ? '<button class="secondary" id="export-template" type="button">' +
          tr('ייצוא תבנית', 'Export template') +
          '</button><button class="danger" id="delete-bot" type="button">' +
          tr('מחיקת בוט', 'Delete bot') +
          '</button>'
        : '') +
      '</div></form>',
  );
  $('#modal').dataset.kind = 'bot';
  const provider = botProvider(bot),
    catalog = providerAccount(provider);
  const form = $('#bot-form'),
    session = {
      form,
      provider,
      originalProvider: provider,
      original: botModelValues(editing ? bot : null),
      values: botModelValues(bot),
      models: Array.isArray(catalog?.models) ? catalog.models : [],
      defaultModel: catalog?.defaultModel || '',
      defaultModelKnown: catalog?.defaultModelKnown,
      defaultModelError: catalog?.defaultModelError || '',
      catalogReady: false,
      loading: true,
      error: '',
      notice: '',
      request: 0,
      focusModel,
    };
  form.querySelectorAll('[data-color]').forEach(
    button =>
      (button.onclick = () => {
        color = button.dataset.color;
        form
          .querySelectorAll('[data-color]')
          .forEach(item => item.classList.toggle('selected', item === button));
      }),
  );
  form.onsubmit = act(async event => {
    event.preventDefault();
    const errors = validateBotModelValues(
      session.values,
      botFormModelOriginal(session),
      session.models,
      botModelDefaults(session),
      { catalogReady: session.catalogReady && !session.loading },
    );
    if (errors.length) {
      renderBotModelControls(session);
      $('#bot-model-controls').scrollIntoView({ block: 'nearest' });
      throw new Error(errors.map(botModelErrorLabel).join(' '));
    }
    const data = {
      ...Object.fromEntries(new FormData(form)),
      ...session.values,
      provider: session.provider,
      color,
    };
    if (bot?.shape) data.shape = bot.shape;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      if (editing) {
        data.pinned = form.elements.pinned.checked;
        data.hidden = form.elements.hidden.checked;
        await api('/api/bots/' + bot.id, data, 'PATCH');
        await refresh();
      } else {
        const result = await api('/api/bots', data);
        await refresh();
        await openChat(result.chat.id);
      }
      if (botModelFormActive(session)) $('#modal').close();
    } finally {
      if (botModelFormActive(session)) button.disabled = false;
    }
  });
  if (editing) $('#delete-bot').onclick = () => deleteBotConfirm(bot);
  if (editing)
    $('#export-template').onclick = act(async () => {
      const template = await api('/api/bots/' + bot.id + '/template');
      download(bot.name + '-template.json', JSON.stringify(template, null, 2));
    });
  renderBotModelControls(session);
  loadBotModelCatalog(session);
  if (focusModel) $('#bot-model-controls').scrollIntoView({ block: 'nearest' });
}
function deleteBotConfirm(bot) {
  modal(
    tr(`מחיקת ${bot.name}`, `Delete ${bot.name}`),
    `<p dir="${direction()}">${tr('הבוט יוסר מהצוות הפעיל, משימותיו ייעצרו והשגרות שלו יושהו. ההיסטוריה והקבצים יישמרו, וניתן לשחזר אותו מסל המחזור.', 'This bot will leave the active team. Its tasks will stop and routines will pause. History and files remain, and you can restore it from Trash.')}</p><div class="actions"><button class="danger" id="confirm-delete-bot">${tr('מחיקת הבוט', 'Delete bot')}</button><button class="secondary" id="cancel-delete-bot">${tr('ביטול', 'Cancel')}</button></div>`,
  );
  $('#cancel-delete-bot').onclick = () => botForm(bot);
  $('#confirm-delete-bot').onclick = act(async () => {
    await api(`/api/bots/${bot.id}`, {}, 'DELETE');
    details = false;
    computerExpanded = false;
    await refresh();
    $('#modal').close();
    toast(tr('הבוט הועבר לסל המחזור.', 'Bot moved to Trash.'));
  });
}
function trashView() {
  const deleted = state.bots.filter(b => b.deletedAt);
  modal(
    tr('סל המחזור', 'Trash'),
    `<p class="small muted" dir="${direction()}">${tr('שחזור מחזיר את הבוט וההיסטוריה שלו לצוות. שגרות שנעצרו יישארו מושהות עד שתפעיל אותן.', 'Restore a bot and its history to the team. Paused routines stay paused until you enable them.')}</p>${deleted.map(b => `<div class="list-row">${avatar(b)}<div><h3>${esc(b.name)}</h3><p>${esc(b.title)}</p></div><button class="secondary" data-restore-bot="${b.id}">${tr('שחזור', 'Restore')}</button></div>`).join('') || `<div class="blank">${tr('סל המחזור ריק.', 'Trash is empty.')}</div>`}`,
  );
  $('#modal-body')
    .querySelectorAll('[data-restore-bot]')
    .forEach(
      b =>
        (b.onclick = act(async () => {
          await api(`/api/bots/${b.dataset.restoreBot}/restore`, {});
          await refresh();
          trashView();
          toast(tr('הבוט שוחזר.', 'Bot restored.'));
        })),
    );
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function newChat() {
  const bots = state.bots.filter(b => !b.deletedAt);
  modal(
    tr('שיחה חדשה', 'New chat'),
    `<form id="new-chat-form"><input id="new-chat-query" placeholder="${tr('חיפוש בוט או שם לבוט חדש…', 'Find a bot or name a new one…')}" aria-label="${tr('חיפוש בוט', 'Find a bot')}" autocomplete="off"><button type="button" class="new-bot-option" id="create-bot">${icon('plus')}<span>${tr('יצירת בוט חדש', 'Create new bot')}</span></button><p class="small muted">${tr('בחר בוט לפתיחת שיחה, או 2–6 בוטים לקבוצה.', 'Choose one bot to open its chat, or 2–6 for a group.')}</p><div class="new-chat-bots">${bots.map(b => `<label class="new-chat-choice" data-bot-name="${esc(b.name.toLowerCase())}"><input type="checkbox" name="bots" value="${b.id}">${avatar(b)}<span><strong>${esc(b.name)}</strong><small>${esc(b.title)}</small></span></label>`).join('') || `<p class="muted">${tr('עדיין אין בוטים פעילים.', 'No active bots yet.')}</p>`}</div><div class="actions new-chat-actions"><button class="primary" id="open-new-chat" disabled>${tr('פתיחת שיחה', 'Open chat')}</button><button type="button" class="secondary" id="import-template">${tr('ייבוא תבנית', 'Import template')}</button></div></form>`,
  );
  const form = $('#new-chat-form'),
    query = $('#new-chat-query');
  query.focus();
  query.oninput = () => {
    const name = query.value.trim();
    form.querySelectorAll('[data-bot-name]').forEach(row => {
      row.hidden = !row.dataset.botName.includes(name.toLowerCase());
    });
    $('#create-bot span').textContent = name
      ? tr(`צור בוט בשם ״${name}״`, `Create “${name}” bot`)
      : tr('יצירת בוט חדש', 'Create new bot');
  };
  $('#create-bot').onclick = () => {
    const name = query.value.trim();
    botForm();
    if (name) $('#bot-form input[name="name"]').value = name.slice(0, 60);
  };
  form.querySelectorAll('input[type="checkbox"]').forEach(
    box =>
      (box.onchange = () => {
        const count = new FormData(form).getAll('bots').length;
        $('#open-new-chat').disabled = count < 1 || count > 6;
        $('#open-new-chat').textContent =
          count > 1
            ? tr(`יצירת קבוצה · ${count}`, `Create group · ${count}`)
            : tr('פתיחת שיחה', 'Open chat');
      }),
  );
  form.onsubmit = act(async e => {
    e.preventDefault();
    const botIds = new FormData(form).getAll('bots');
    if (!botIds.length || botIds.length > 6)
      throw new Error(tr('בחר 1–6 בוטים.', 'Choose 1–6 bots.'));
    if (botIds.length === 1) {
      const chat = state.chats.find(c => c.type === 'direct' && c.botIds[0] === botIds[0]);
      await openChat(chat.id);
    } else {
      const name = botIds
        .map(id => botById(id).name)
        .join(', ')
        .slice(0, 80);
      const chat = await api('/api/groups', { name, botIds });
      await refresh();
      await openChat(chat.id);
    }
    $('#modal').close();
  });
  $('#import-template').onclick = importBotTemplate;
}
function importBotTemplate() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = act(async () => {
    if (!input.files[0]) return;
    const template = JSON.parse(await input.files[0].text());
    if (template.format !== 'stellarcortex-bot-template' || template.version !== 1)
      throw new Error('Unsupported template');
    botForm({ ...template.bot, id: null, name: template.bot.name || 'Imported bot' });
  });
  input.click();
}
function groupForm(group = null) {
  const bots = state.bots.filter(b => !b.deletedAt);
  modal(
    group ? tr('עריכת הקבוצה', 'Edit group') : tr('שיחה קבוצתית חדשה', 'New group conversation'),
    `<form id="group-form"><label>${tr('שם הקבוצה', 'Group name')}</label><input name="name" required maxlength="80" value="${esc(group?.name || '')}"><label>${tr('חברי הקבוצה · 2–6 בוטים', 'Group members · 2–6 bots')}</label><div class="check-list new-chat-bots">${bots.map(b => `<label class="new-chat-choice"><input type="checkbox" name="bots" value="${b.id}" ${group?.botIds.includes(b.id) ? 'checked' : ''}>${avatar(b)}<span><strong>${esc(b.name)}</strong><small>${esc(b.title)}</small></span></label>`).join('')}</div><div class="actions"><button class="primary">${group ? tr('שמירת השינויים', 'Save changes') : tr('יצירת קבוצה', 'Create group')}</button></div></form>`,
  );
  $('#group-form').onsubmit = act(async e => {
    e.preventDefault();
    const fields = new FormData(e.target),
      botIds = fields.getAll('bots');
    if (botIds.length < 2 || botIds.length > 6)
      throw new Error(tr('בחר 2–6 בוטים לקבוצה.', 'Choose 2–6 bots for the group.'));
    const data = { name: fields.get('name'), botIds };
    if (group?.managerBotId && !botIds.includes(group.managerBotId)) data.managerBotId = null;
    const chat = await api(
      group ? `/api/groups/${group.id}` : '/api/groups',
      data,
      group ? 'PATCH' : 'POST',
    );
    await refresh();
    await openChat(chat.id);
    $('#modal').close();
  });
}
function routineForm(botId) {
  modal(
    tr('שגרה חדשה', 'New routine'),
    `<form id="routine-form"><label>${tr('שם השגרה', 'Name')}</label><input name="name" required><label>${tr('הבוט האחראי', 'Owner')}</label><select name="botId">${state.bots
      .filter(b => !b.deletedAt)
      .map(
        b => `<option value="${b.id}" ${b.id === botId ? 'selected' : ''}>${esc(b.name)}</option>`,
      )
      .join(
        '',
      )}</select><label>${tr('מה לבצע', 'Instructions')}</label><textarea name="prompt" required rows="4" dir="auto"></textarea><div class="split"><div><label>${tr('סוג תזמון', 'Schedule')}</label><select name="kind"><option value="daily">${tr('כל יום בשעה', 'Daily')}</option><option value="interval">${tr('מרווח דקות', 'Interval')}</option><option value="webhook">Webhook</option></select></div><div><label>${tr('שעה מקומית', 'Local time')}</label><input name="time" type="time" value="09:00"></div></div><div class="split"><div><label>${tr('מרווח בדקות (לסוג מרווח)', 'Minutes (interval mode)')}</label><input name="minutes" type="number" min="5" value="60"></div><div><label>${tr('אזור זמן', 'Time zone')}</label><input name="timezone" value="${esc(state.settings.timezone)}"></div></div><p class="notice">${tr('שגרה מבצעת עבודה אמיתית וצורכת את מכסת המנוי. היא פועלת רק כשהשרת פועל.', 'Routines perform real work and use your subscription allowance. Your host must remain running.')}</p><button class="primary">${tr('שמירה והפעלה', 'Save and activate')}</button></form>`,
  );
  $('#routine-form').onsubmit = act(async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    b.minutes = Number(b.minutes);
    const r = await api('/api/routines', b);
    await refresh();
    routineDetails(r);
  });
}
function routineDetails(r) {
  const history = state.jobs
    .filter(j => j.routineId === r.id)
    .slice(-20)
    .reverse();
  modal(
    r.name,
    `<p class="muted">${esc(scheduleLabel(r))}</p><label>${tr('הוראות', 'Instructions')}</label><textarea id="routine-prompt" dir="auto">${esc(r.prompt)}</textarea><div class="actions"><button class="primary" id="routine-save">${tr('שמירה', 'Save')}</button><button class="secondary" id="routine-run">${tr('הפעלה עכשיו', 'Run now')}</button><button class="secondary" id="routine-toggle">${r.enabled ? tr('השהיה', 'Pause') : tr('הפעלה', 'Resume')}</button></div>${r.kind === 'webhook' ? `<button class="secondary" id="reveal-hook" style="margin-top:12px">${tr('הצגת פרטי Webhook', 'Show webhook credentials')}</button><pre id="hook-details" hidden></pre>` : ''}<h3 style="margin-top:28px">${tr('היסטוריית הרצות', 'Run history')}</h3>${history.map(j => `<div class="list-row"><time>${new Date(j.createdAt).toLocaleString()}</time><span class="status ${j.status}">${j.status}</span></div>`).join('') || `<p class="muted small">${tr('עדיין לא הורצה', 'No runs yet')}</p>`}`,
  );
  $('#routine-save').onclick = act(async () => {
    await api(`/api/routines/${r.id}`, { prompt: $('#routine-prompt').value }, 'PATCH');
    await refresh();
    toast(tr('נשמר', 'Saved'));
  });
  $('#routine-run').onclick = act(async () => {
    await api(`/api/routines/${r.id}/run`, {});
    $('#modal').close();
    await openChat(r.chatId);
  });
  $('#routine-toggle').onclick = act(async () => {
    await api(`/api/routines/${r.id}`, { enabled: !r.enabled }, 'PATCH');
    await refresh();
    routineDetails(state.routines.find(x => x.id === r.id));
  });
  if ($('#reveal-hook'))
    $('#reveal-hook').onclick = act(async () => {
      const hook = await api(`/api/routines/${r.id}/key`);
      $('#hook-details').hidden = false;
      $('#hook-details').textContent = `POST ${hook.url}\nAuthorization: Bearer ${hook.key}`;
    });
}
function skillForm() {
  modal(
    tr('מיומנות חדשה', 'New skill'),
    `<form id="skill-form"><label>${tr('שם', 'Name')}</label><input name="name" required><label>${tr('תהליך העבודה, תנאים ותוצאה רצויה', 'Steps, conditions, and expected result')}</label><textarea name="instructions" rows="7" required dir="auto"></textarea><div class="actions"><button class="primary">${tr('שמירה', 'Save skill')}</button></div></form>`,
  );
  $('#skill-form').onsubmit = act(async e => {
    e.preventDefault();
    await api('/api/skills', Object.fromEntries(new FormData(e.target)));
    await refresh();
    $('#modal').close();
  });
}
function useSkill(s) {
  if (s.botId) {
    const c = state.chats.find(
      c => c.type === 'direct' && c.botIds[0] === s.botId && !c.kanbanCardId,
    );
    if (c) chatId = c.id;
  }
  view = 'chat';
  render();
  $('#modal').close();
  $('#prompt').value =
    `${tr('בצע את המיומנות', 'Run the skill')} "${s.name}":\n${s.instructions}\n\n`;
  $('#prompt').focus();
}
function search() {
  modal(
    tr('חיפוש בכל העבודה', 'Search your workspace'),
    `<input id="search-input" placeholder="${tr('בוטים, הודעות, שגרות ותוצרים…', 'Bots, messages, routines, files…')}" aria-label="Search workspace"><div id="search-results" class="search-results"></div>`,
  );
  $('#search-input').focus();
  $('#search-input').oninput = () => {
    const q = $('#search-input').value.toLowerCase().trim();
    const matches = q
      ? state.messages
          .filter(m => m.role !== 'tool' && m.text.toLowerCase().includes(q))
          .slice(-40)
          .reverse()
      : [];
    const chats = q
      ? state.chats.filter(c => chatAvailable(c) && c.name.toLowerCase().includes(q))
      : state.chats.filter(chatAvailable);
    $('#search-results').innerHTML =
      chats
        .map(
          c =>
            `<button class="search-result" data-result-chat="${c.id}"><strong>${esc(c.name)}</strong><span>${c.kanbanCardId ? tr('שיחת משימה', 'Task session') : tr('שיחה', 'Conversation')}</span></button>`,
        )
        .join('') +
      matches
        .map(
          m =>
            `<button class="search-result" data-result-chat="${m.chatId}" data-message="${m.id}"><strong>${esc(state.chats.find(c => c.id === m.chatId)?.name)}</strong><span>${esc(m.text.slice(0, 180))}</span></button>`,
        )
        .join('') +
      state.routines
        .filter(r => q && r.name.toLowerCase().includes(q))
        .map(
          r =>
            `<button class="search-result" data-search-routine="${r.id}"><strong>${esc(r.name)}</strong><span>Routine</span></button>`,
        )
        .join('') +
      state.artifacts
        .filter(a => q && a.title.toLowerCase().includes(q))
        .map(
          a =>
            `<button class="search-result" data-artifact="${a.id}"><strong>${esc(a.title)}</strong><span>Library</span></button>`,
        )
        .join('');
    $('#search-results')
      .querySelectorAll('[data-result-chat]')
      .forEach(
        b =>
          (b.onclick = act(async () => {
            await openChat(b.dataset.resultChat);
            $('#modal').close();
            if (b.dataset.message)
              document
                .getElementById(`msg-${b.dataset.message}`)
                ?.scrollIntoView({ block: 'center' });
          })),
      );
    $('#search-results')
      .querySelectorAll('[data-search-routine]')
      .forEach(
        b =>
          (b.onclick = () =>
            routineDetails(state.routines.find(r => r.id === b.dataset.searchRoutine))),
      );
    bindArtifacts($('#search-results'));
  };
  $('#search-input').oninput();
}
let settingsSession = null,
  settingsSequence = 0;
function accountName() {
  return account?.account?.email || tr('סביבת העבודה שלי', 'My workspace');
}
function accountPlan() {
  return account?.account?.type === 'chatgpt'
    ? `ChatGPT ${account.account.planType || ''}`.trim()
    : tr('חשבון לא מחובר', 'Account not connected');
}
function closeAccountMenu(focus = false) {
  $('#account-menu')?.remove();
  $('#account')?.setAttribute('aria-expanded', 'false');
  if (focus) $('#account')?.focus();
}
function openAccountMenu() {
  if ($('#account-menu')) return closeAccountMenu(true);
  const menu = document.createElement('div');
  menu.id = 'account-menu';
  menu.className = 'account-menu';
  menu.dir = direction();
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', tr('תפריט חשבון', 'Account menu'));
  menu.innerHTML = `<div class="account-menu-identity"><span class="account-circle">${esc(accountName().charAt(0).toUpperCase())}</span><div><strong dir="auto">${esc(accountName())}</strong><small>${esc(accountPlan())}</small></div></div><button role="menuitem" class="account-menu-usage" data-account-action="usage"><span>${tr('שימוש במנויים', 'Subscription usage')}</span><div id="account-usage-preview">${usagePreviewMarkup()}</div></button><div class="account-menu-divider"></div><button role="menuitem" data-account-action="settings">${icon('settings')}<span>${tr('הגדרות', 'Settings')}</span><kbd>Ctrl ,</kbd></button><button role="menuitem" data-account-action="shortcuts">${icon('grid')}<span>${tr('קיצורי מקלדת', 'Keyboard shortcuts')}</span></button><button role="menuitem" data-account-action="about">${icon('info')}<span>${tr('אודות StellarCortex', 'About StellarCortex')}</span></button><div class="account-menu-divider"></div><button role="menuitem" data-account-action="lock">${icon('stop')}<span>${tr('נעילת סביבת העבודה', 'Lock workspace')}</span></button>`;
  document.body.append(menu);
  const rect = $('#account').getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.bottom = `${Math.max(8, innerHeight - rect.top + 8)}px`;
  $('#account').setAttribute('aria-haspopup', 'menu');
  $('#account').setAttribute('aria-expanded', 'true');
  menu.querySelectorAll('[data-account-action]').forEach(
    button =>
      (button.onclick = act(async () => {
        const action = button.dataset.accountAction;
        closeAccountMenu();
        if (action === 'settings') await settings();
        if (action === 'usage') await settings('usage');
        if (action === 'shortcuts') showKeyboardShortcuts();
        if (action === 'about') await showAbout();
        if (action === 'lock') await lockWorkspace();
      })),
  );
  menu.onkeydown = event => {
    const rows = [...menu.querySelectorAll('[role=menuitem]')],
      index = rows.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAccountMenu(true);
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      rows[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      ]?.focus();
    }
  };
  menu.querySelector('[role=menuitem]')?.focus();
  loadProviderAccount('claude').catch(() => {});
  loadConnectionSettings()
    .then(() => {
      for (const provider of configuredConnectionProviders())
        if (!providerUsage(provider)) loadProviderAccount(provider).catch(() => {});
    })
    .catch(() => {});
}
document.addEventListener('pointerdown', event => {
  if ($('#account-menu') && !event.target.closest('#account-menu,#account')) closeAccountMenu();
});
window.addEventListener('resize', () => closeAccountMenu());
async function lockWorkspace() {
  await stopVoiceCall({ close: true });
  dictation?.abort();
  dictation = null;
  closeAccountMenu();
  if (typeof closeComputerViewer === 'function') await closeComputerViewer();
  await api('/api/logout', {});
  showLogin();
  $('#login-error').textContent = '';
  $('#access-key').focus();
}
function showKeyboardShortcuts() {
  closeAccountMenu();
  const rows = [
    ['Ctrl / ⌘ + K', tr('חיפוש', 'Search')],
    ['Ctrl / ⌘ + N', tr('בוט או שיחה חדשים', 'New bot or conversation')],
    ['Ctrl / ⌘ + ,', tr('הגדרות', 'Settings')],
    ['Ctrl / ⌘ + B', tr('הצגת סרגל הצד', 'Toggle sidebar')],
    ['Enter', tr('שליחת הודעה', 'Send message')],
    ['Shift + Enter', tr('שורה חדשה בהודעה', 'New line in a message')],
    ['Esc', tr('סגירת תפריט או חלון', 'Close a menu or dialog')],
  ];
  modal(
    tr('קיצורי מקלדת', 'Keyboard shortcuts'),
    `<div class="shortcut-list">${rows.map(([key, label]) => `<div><span>${label}</span><kbd dir="ltr">${key}</kbd></div>`).join('')}</div><p class="small muted">${tr('כאשר שולטים במחשב הבוט, הקלט נשלח למסך שלו. השתמש בכפתור היציאה כדי לחזור לשיחה.', 'While controlling a bot’s computer, input goes to its screen. Use the exit control to return to the conversation.')}</p>`,
  );
  $('#modal').dataset.kind = 'shortcuts';
}
async function showAbout() {
  closeAccountMenu();
  modal(
    tr('אודות StellarCortex', 'About StellarCortex'),
    `<div class="about-app"><img class="product-logo" src="/stellar-cortex-logo.svg" width="260" height="234" alt=""><h3>StellarCortex</h3><p>${tr('צוות בוטים אישי, על המחשב או השרת שלך.', 'Your personal bot team, on your own computer or server.')}</p><p id="about-version" class="muted">${tr('טוען גרסה…', 'Loading version…')}</p></div>`,
  );
  $('#modal').dataset.kind = 'about';
  const health = await api('/health');
  if ($('#modal').open && $('#modal').dataset.kind === 'about')
    $('#about-version').textContent =
      `${tr('גרסה', 'Version')} ${health.version} · ${state?.platform || ''}`;
}
function providerUsage(provider = 'codex') {
  return latestUsageReport(providerAccount(provider)?.usage, state?.providerUsage?.[provider]);
}
function usageWindows(provider = 'codex') {
  return reportUsageWindows(providerUsage(provider));
}
function usageDuration(minutes) {
  if (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0)
    return tr('מכסת שימוש', 'Usage window');
  let remaining = Number(minutes);
  const parts = [];
  for (const [unit, heOne, heMany, enOne, enMany] of [
    [1440, 'יום', 'ימים', 'day', 'days'],
    [60, 'שעה', 'שעות', 'hour', 'hours'],
    [1, 'דקה', 'דקות', 'minute', 'minutes'],
  ]) {
    const amount = unit === 1 ? remaining : Math.floor(remaining / unit);
    if (!amount) continue;
    parts.push(`${amount} ${tr(amount === 1 ? heOne : heMany, amount === 1 ? enOne : enMany)}`);
    remaining -= amount * unit;
  }
  return parts.join(' ');
}
function usageReset(value) {
  if (value == null || value === '') return '';
  const number = Number(value),
    date = new Date(Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(state?.settings.language === 'he' ? 'he-IL' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: state?.settings.timezone || undefined,
  });
}
function usageMarkup(compact = false, provider = 'codex') {
  const windows = usageWindows(provider);
  if (!windows.length) return '';
  const showLabel = !compact || new Set(windows.map(window => window.id)).size > 1;
  return (
    (compact ? windows.slice(0, 2) : windows)
      .map(window => {
        const known = window.usedPercent !== null,
          reset = usageReset(window.resetsAt) || window.resetText || '';
        const label = ['five_hour', 'seven_day'].includes(window.id)
          ? usageDuration(window.windowDurationMins)
          : (showLabel ? window.label + ' · ' : '') + usageDuration(window.windowDurationMins);
        const status =
          window.status === 'rejected'
            ? tr('המכסה מוצתה', 'Limit reached')
            : ['allowed_warning', 'warning'].includes(window.status)
              ? tr('קרוב למגבלת השימוש', 'Approaching usage limit')
              : '';
        return `<div class="usage-window ${provider} ${compact ? 'compact' : ''}"><div class="usage-window-heading"><span>${esc(label)}</span><strong>${known ? `${Math.round(window.usedPercent)}% ${tr('נוצלו', 'used')}` : tr('לא דווח אחוז', 'Percentage unavailable')}</strong></div>${known ? `<div class="usage-track" role="progressbar" aria-label="${esc(window.label)} ${usageDuration(window.windowDurationMins)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${window.usedPercent}"><i style="width:${window.usedPercent}%"></i></div>` : ''}${status ? `<small class="usage-status">${esc(status)}</small>` : ''}${window.stale ? `<small class="usage-status">${tr('דיווח קודם', 'Previous report')}${!compact && usageReset(window.observedAt) ? ' · ' + esc(usageReset(window.observedAt)) : ''}</small>` : ''}${!compact && reset ? `<small class="muted">${tr('איפוס המכסה', 'Resets')} · <span dir="auto">${esc(reset)}</span></small>` : ''}</div>`;
      })
      .join('') +
    (compact && windows.length > 2
      ? `<small class="muted">${tr('כל המכסות בפרטי השימוש', 'All limits in usage details')}</small>`
      : '')
  );
}
function usageReportMeta(provider) {
  const report = providerUsage(provider);
  if (!report) return '';
  const source =
    report.source === 'claude-code'
      ? 'Claude Code'
      : report.source === 'api-runtime'
        ? tr('דיווחי API בהתקנה הזאת', 'API reports in this installation')
        : report.source;
  return (
    '<p class="usage-report-meta">' +
    [
      source ? tr('מקור: ', 'Source: ') + esc(source) : '',
      usageReset(report.observedAt)
        ? tr('דיווח אחרון: ', 'Last report: ') + esc(usageReset(report.observedAt))
        : '',
      report.stale ? tr('נתונים קודמים — אפשר לרענן', 'Previous data — refresh available') : '',
    ]
      .filter(Boolean)
      .join(' · ') +
    '</p>'
  );
}
function configuredConnectionProviders() {
  return (connectionSettings?.connections || [])
    .filter(item => isConnectionProvider(item.provider) && item.configured)
    .map(item => item.provider);
}
function tokenUsageMarkup(provider, compact = false) {
  const usage = tokenUsageSummary(providerUsage(provider));
  if (!usage) return '';
  const values = [
    [tr('טוקנים בסך הכול', 'Total tokens'), usage.totalTokens],
    [tr('קלט', 'Input'), usage.inputTokens],
    [tr('פלט', 'Output'), usage.outputTokens],
    [tr('בקשות', 'Requests'), usage.requests],
  ].filter(([, value]) => value !== null);
  if (!values.length) return '';
  return (
    '<dl class="token-usage-grid ' +
    (compact ? 'compact' : '') +
    '">' +
    (compact
      ? values.filter(([label], index) => index === 0 || label === tr('בקשות', 'Requests'))
      : values
    )
      .map(
        ([label, value]) =>
          '<div><dt>' +
          esc(label) +
          '</dt><dd>' +
          Number(value).toLocaleString(state?.settings.language === 'he' ? 'he-IL' : 'en-US') +
          '</dd></div>',
      )
      .join('') +
    '</dl>' +
    (usage.reportedRequests === 0
      ? '<p class="usage-report-meta">' +
        tr('טרם התקבל דיווח טוקנים מהשרת.', 'The server has not reported token counts yet.') +
        '</p>'
      : usage.partial
        ? '<p class="usage-report-meta">' +
          tr(
            'דיווח חלקי: טוקנים דווחו עבור ' +
              usage.reportedRequests +
              ' מתוך ' +
              usage.requests +
              ' בקשות.',
            'Partial report: token counts were reported for ' +
              usage.reportedRequests +
              ' of ' +
              usage.requests +
              ' requests.',
          ) +
          '</p>'
        : '')
  );
}
function usagePreviewMarkup() {
  return ['codex', 'claude', ...configuredConnectionProviders()]
    .map(provider => {
      const markup = isConnectionProvider(provider)
        ? tokenUsageMarkup(provider, true)
        : usageMarkup(true, provider);
      return (
        '<div class="provider-usage-summary ' +
        provider +
        '"><strong>' +
        esc(provider === 'codex' ? 'GPT / Codex' : providerName(provider)) +
        '</strong>' +
        (markup ||
          '<small class="muted">' +
            tr('נתוני שימוש אינם זמינים', 'Usage data unavailable') +
            '</small>') +
        usageReportMeta(provider) +
        '</div>'
      );
    })
    .join('');
}
function renderUsageSurfaces() {
  const preview = $('#account-usage-preview');
  if (preview) preview.innerHTML = usagePreviewMarkup();
  if (settingsSession?.pane === 'usage' && settingsIsOpen(settingsSession, 'usage'))
    renderUsageSettings();
}
function settingsLabels() {
  return [
    ['general', tr('כללי', 'General'), 'settings'],
    ['connections', tr('מודלים וחיבורים', 'Models & connections'), 'spark'],
    ['computer', tr('מחשב', 'Computer'), 'computer'],
    ['usage', tr('שימוש ומנוי', 'Usage & Billing'), 'activity'],
    ['updates', tr('עדכונים', 'Updates'), 'download'],
  ];
}
function settingsModelOptions(selected) {
  const models = (account?.models || []).filter(model => !model.hidden);
  if (selected && !models.some(model => (model.model || model.id) === selected))
    models.unshift({ model: selected, displayName: selected });
  return models
    .map(
      model =>
        `<option value="${esc(model.model || model.id)}" ${selected === (model.model || model.id) ? 'selected' : ''}>${esc(model.displayName || model.model || model.id)}</option>`,
    )
    .join('');
}
function readSettingsDraft() {
  const form = $('#settings-form');
  if (form && settingsSession)
    settingsSession.draft = { ...settingsSession.draft, ...Object.fromEntries(new FormData(form)) };
  readConnectionDrafts();
}
function settingsIsOpen(session, pane) {
  return (
    settingsSession === session &&
    $('#modal').open &&
    $('#modal').dataset.kind === 'settings' &&
    (!pane || session.pane === pane)
  );
}
async function settings(pane = 'general', { computerBot = null } = {}) {
  closeAccountMenu();
  if (!settingsLabels().some(([id]) => id === pane)) pane = 'general';
  const session = {
    id: ++settingsSequence,
    pane,
    computerBot,
    draft: { ...state.settings },
    health: null,
    loading: !account,
    accountError: null,
    connectionsLoading: true,
    connectionDrafts: {},
    connectionFeedback: {},
    connectionBusy: {},
  };
  settingsSession = session;
  renderSettings();
  const results = await Promise.allSettled([
    loadAccount(),
    api('/health'),
    loadProviderAccount('claude'),
    loadConnectionSettings(),
  ]);
  if (settingsSession !== session || !$('#modal').open || $('#modal').dataset.kind !== 'settings')
    return;
  readSettingsDraft();
  session.loading = false;
  session.accountError = results[0].status === 'rejected' ? results[0].reason.message : null;
  session.health =
    results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason.message };
  session.claudeError = results[2].status === 'rejected' ? results[2].reason.message : null;
  session.connectionsLoading = false;
  session.connectionsError = results[3].status === 'rejected' ? results[3].reason.message : null;
  if (results[3].status === 'fulfilled')
    session.connectionDrafts = Object.fromEntries(
      connectionSettings.connections.map(item => [item.provider, connectionDraft(item)]),
    );
  renderSettings();
  for (const provider of configuredConnectionProviders())
    if (!providerAccount(provider)?.models?.length)
      loadProviderAccount(provider)
        .then(() => {
          if (
            settingsIsOpen(session, 'connections') &&
            !document.activeElement?.closest('[data-provider-connection="' + provider + '"]')
          )
            refreshConnectionCard(session, provider);
        })
        .catch(() => {});
}
function claudeConnectionMarkup(session) {
  const result = providerAccounts.claude,
    connected = result?.connected,
    command = result?.loginInstructions || tr('טוען את הפקודה…', 'Loading the command…');
  const status =
    !result && !session.claudeError
      ? tr('בודק…', 'Checking…')
      : connected
        ? tr('מחובר', 'Connected')
        : result?.installed === false
          ? tr('לא מותקן', 'Not installed')
          : tr('לא מחובר', 'Not connected');
  const identity = result?.account?.email || tr('חשבון Claude שלך', 'Your Claude account');
  return (
    '<section class="settings-section claude-connection"><h4>Claude</h4><div class="settings-account"><span class="account-circle claude-account-icon">C</span><div><strong dir="auto">' +
    esc(identity) +
    '</strong><small>Claude Code' +
    (result?.account?.planType ? ' · ' + esc(result.account.planType) : '') +
    '</small></div><span class="settings-connection ' +
    (connected ? 'connected' : '') +
    '">' +
    status +
    '</span></div>' +
    (session.claudeError || result?.error
      ? '<p class="notice">' +
        esc(withoutProgramOutput(session.claudeError || result.error, tr)) +
        '</p>'
      : '') +
    '<p class="settings-description">' +
    tr(
      'הבוטים שנבחר עבורם Claude משתמשים בחיבור נפרד ובמכסה של חשבון Claude שלך.',
      'Bots assigned to Claude use a separate connection and your Claude account allowance.',
    ) +
    '</p>' +
    providerTermsNote(tr) +
    (result && !connected && result.installed !== false
      ? '<div id="claude-login-flow" class="claude-login-flow"></div>'
      : '') +
    '<details class="claude-login-steps" ' +
    (!connected ? 'open' : '') +
    '><summary>' +
    tr(
      connected ? 'כניסה או החלפת חשבון' : 'או התחברות מטרמינל',
      connected ? 'Sign in or switch account' : 'Or connect from a terminal',
    ) +
    '</summary><ol class="claude-login-list"><li>' +
    tr(
      'פתח טרמינל במחשב או בשרת שבו StellarCortex מותקן.',
      'Open a terminal on the computer or server where StellarCortex is installed.',
    ) +
    '</li><li>' +
    tr(
      'הדבק את הפקודה הזו והשלם את הכניסה ב־Claude Code:',
      'Paste this command and finish signing in with Claude Code:',
    ) +
    '<code class="settings-path" id="claude-login-command" dir="ltr">' +
    esc(command) +
    '</code><button id="claude-copy-login" class="secondary">' +
    tr('העתקת פקודת הכניסה', 'Copy sign-in command') +
    '</button></li><li>' +
    tr('חזור לכאן ולחץ על בדיקת חיבור.', 'Come back here and choose Check connection.') +
    '</li></ol>' +
    (result?.installed === false
      ? '<p class="settings-description">' +
        tr(
          'Claude Code אינו זמין בהתקנה הזאת. הרץ שוב את מתקין StellarCortex או התקן את Claude Code בסביבת השרת.',
          'Claude Code is unavailable in this installation. Run the StellarCortex installer again or install Claude Code in the server environment.',
        ) +
        '</p><a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noopener">' +
        tr('הוראות ההתקנה הרשמיות', 'Official installation instructions') +
        ' ↗</a>'
      : '') +
    '</details><div class="actions"><button id="claude-refresh" class="secondary">' +
    tr('בדיקת חיבור', 'Check connection') +
    '</button></div></section>'
  );
}
function connectionRecord(provider) {
  return (
    connectionSettings?.connections.find(item => item.provider === provider) || {
      provider,
      ...connectionDraft(),
    }
  );
}
function readConnectionDrafts() {
  if (!settingsSession) return;
  $('#settings-content')
    ?.querySelectorAll('[data-provider-connection]')
    .forEach(form => {
      const provider = form.dataset.providerConnection,
        previous =
          settingsSession.connectionDrafts?.[provider] ||
          connectionDraft(connectionRecord(provider));
      settingsSession.connectionDrafts ||= {};
      settingsSession.connectionDrafts[provider] = connectionDraft({
        ...previous,
        defaultModel: form.elements.defaultModel.value,
        ...(provider === 'local' || isCustomProvider(provider)
          ? {
              baseUrl: form.elements.baseUrl.value,
              engine: form.elements.engine?.value || previous.engine,
              toolsEnabled: form.elements.toolsEnabled.checked,
              visionEnabled: form.elements.visionEnabled.checked,
            }
          : {}),
        ...(isCustomProvider(provider)
          ? {
              name: form.elements.connectionName.value,
              modelsUrl: form.elements.modelsUrl.value,
              protocol: form.elements.protocol.value,
            }
          : {}),
      });
    });
}
function rememberConnection(connection) {
  const safe = safeConnectionMetadata({ ...connectionRecord(connection.provider), ...connection });
  connectionSettings ||= {
    connections: [],
    localEngines: LOCAL_ENGINE_PRESETS,
    apiPresets: API_PROVIDER_PRESETS,
  };
  const index = connectionSettings.connections.findIndex(item => item.provider === safe.provider);
  if (index < 0) connectionSettings.connections.push(safe);
  else connectionSettings.connections[index] = safe;
  return safe;
}
function protocolOptions(selected) {
  return API_PROTOCOLS.map(
    protocol =>
      '<option value="' +
      protocol +
      '" ' +
      (selected === protocol ? 'selected' : '') +
      '>' +
      {
        'chat-completions': 'OpenAI Chat Completions',
        responses: 'OpenAI Responses',
        anthropic: 'Anthropic Messages',
      }[protocol] +
      '</option>',
  ).join('');
}
function catalogUrlField(draft, id, disabled = '') {
  return (
    '<label for="' +
    id +
    '">' +
    tr('כתובת קטלוג מודלים — אופציונלי', 'Model catalog URL — optional') +
    '</label><input id="' +
    id +
    '" name="modelsUrl" type="url" dir="ltr" value="' +
    esc(draft.modelsUrl) +
    '" ' +
    disabled +
    '><p class="settings-description">' +
    tr(
      'השאר ריק לקטלוג הרגיל של הספק. כתובת מותאמת חייבת להשתמש באותו מקור (פרוטוקול, מארח ופורט) של כתובת ה־API, בלי פרטי כניסה, שאילתה או עוגן.',
      'Leave blank for the provider’s usual catalog. A custom URL must have the same origin (scheme, host and port) as the API URL, without credentials, query or fragment.',
    ) +
    '</p>'
  );
}
function connectionCapabilityFields(draft, disabled = '') {
  return (
    '<div class="connection-capabilities"><label class="settings-toggle-row"><span><strong>' +
    tr('שימוש בכלים', 'Tool use') +
    '</strong><small>' +
    tr('למודלים שתומכים בבקשות להפעלת כלים.', 'For models that support tool calls.') +
    '</small></span><input name="toolsEnabled" type="checkbox" ' +
    (draft.toolsEnabled ? 'checked' : '') +
    ' ' +
    disabled +
    '></label><label class="settings-toggle-row"><span><strong>' +
    tr('שליחת תמונות למודל', 'Send images to the model') +
    '</strong><small>' +
    tr('הפעל רק אם המודל תומך בקלט תמונה.', 'Enable only when the model supports image input.') +
    '</small></span><input name="visionEnabled" type="checkbox" ' +
    (draft.visionEnabled ? 'checked' : '') +
    ' ' +
    disabled +
    '></label></div>'
  );
}
function connectionProtocolHelp() {
  return tr(
    'פורמט ה־API נקבע לפי התיעוד של הספק והמודל, בלי קשר לשם החברה. OpenCode, למשל, מציע פורמטים שונים לפי המודל.',
    'The API format depends on the provider and model documentation, independently of the company name. OpenCode, for example, offers different formats for different models.',
  );
}
function openCodeProtocolFields(draft, id, disabled = '') {
  return (
    '<label for="' +
    id +
    '">' +
    tr('פורמט API למודלי OpenCode', 'API format for OpenCode models') +
    '</label><select id="' +
    id +
    '" name="protocol" ' +
    disabled +
    '>' +
    protocolOptions(draft.protocol) +
    '</select><p class="settings-description">' +
    tr(
      'למודלי GPT בחר Responses; ל־Claude בחר Anthropic Messages. למודלים אחרים בחר לפי תיעוד המודל. אפשר להוסיף חיבור נפרד לכל פורמט עם אותו מפתח. רשימת המודלים אינה מבטיחה תאימות לפורמט שנבחר.',
      'Choose Responses for GPT models and Anthropic Messages for Claude. For other models, follow the model documentation. You can add a separate connection per format using the same key. A listed model is not guaranteed to support the selected format.',
    ) +
    '</p>'
  );
}
function connectionCardMarkup(session, provider) {
  const saved = connectionRecord(provider),
    draft = session.connectionDrafts[provider] || connectionDraft(saved),
    local = provider === 'local',
    custom = isCustomProvider(provider),
    busy = session.connectionBusy[provider],
    disabled = busy || session.connectionsLoading || session.connectionsError ? 'disabled' : '',
    feedback = session.connectionFeedback[provider];
  session.connectionDrafts[provider] = draft;
  const models = (providerAccount(provider)?.models || []).filter(model => !model.hidden),
    engines = connectionSettings?.localEngines || LOCAL_ENGINE_PRESETS;
  const title = local ? tr('שרת מודלים מקומי', 'Local model server') : providerName(provider),
    openCode = custom && isOpenCodeEndpoint(draft.baseUrl);
  return (
    '<form class="settings-section provider-connection-card ' +
    provider +
    '" data-provider-connection="' +
    provider +
    '" autocomplete="off"><div class="connection-card-heading"><h4>' +
    esc(title) +
    '</h4><span class="settings-connection ' +
    (saved.configured ? 'connected' : '') +
    '">' +
    tr(
      saved.configured ? 'מוגדר' : 'טרם הוגדר',
      saved.configured ? 'Configured' : 'Not configured',
    ) +
    '</span></div><p class="settings-description">' +
    (local
      ? tr(
          'חיבור לשרת מודלים שכבר פועל אצלך. הביצועים והתמיכה בכלים ובתמונות תלויים בחומרה ובמודל.',
          'Connect to a model server you already run. Performance and support for tools and images depend on your hardware and model.',
        )
      : tr(
          'שימוש ב־API מחויב בנפרד מהמנוי, לפי החשבון של המפתח.',
          'API usage is billed separately from the subscription, to the key’s account.',
        )) +
    '</p>' +
    (local
      ? '<label for="connection-local-engine">' +
        tr('מנוע מקומי', 'Local engine') +
        '</label><select id="connection-local-engine" name="engine" ' +
        disabled +
        '>' +
        engines
          .map(
            engine =>
              '<option value="' +
              esc(engine.id) +
              '" ' +
              (draft.engine === engine.id ? 'selected' : '') +
              '>' +
              esc(engine.label) +
              '</option>',
          )
          .join('') +
        '</select><label for="connection-local-url">' +
        tr('כתובת השרת', 'Server URL') +
        '</label><input id="connection-local-url" name="baseUrl" type="url" dir="ltr" value="' +
        esc(draft.baseUrl) +
        '" ' +
        disabled +
        '><p class="settings-description">' +
        tr(
          'הכתובת נפתחת מהשרת שמריץ את StellarCortex. בהתקנת WSL, ‏127.0.0.1 מצביע על סביבת WSL.',
          'The address is reached from the server running StellarCortex. In a WSL installation, 127.0.0.1 refers to the WSL environment.',
        ) +
        '</p>'
      : '') +
    '<label for="connection-' +
    provider +
    '-key">' +
    tr(
      local ? 'מפתח API — אם השרת דורש' : 'מפתח API',
      local ? 'API key — if required by the server' : 'API key',
    ) +
    '</label><input id="connection-' +
    provider +
    '-key" name="apiKey" data-connection-secret type="password" value="" autocomplete="new-password" spellcheck="false" dir="ltr" placeholder="' +
    esc(
      saved.hasApiKey
        ? tr('מפתח שמור — ריק משאיר אותו ללא שינוי', 'Key saved — leave blank to keep it')
        : tr('הדבק מפתח', 'Paste a key'),
    ) +
    '" ' +
    disabled +
    '><p class="settings-description">' +
    tr(
      saved.hasApiKey
        ? 'המפתח השמור אינו מוצג. ניתן להחליף או למחוק אותו.'
        : 'המפתח נשמר בשרת StellarCortex ואינו נשמר בדפדפן.',
      saved.hasApiKey
        ? 'The saved key is not displayed. You can replace or remove it.'
        : 'The key is stored on the StellarCortex server, not in the browser.',
    ) +
    '</p>' +
    (!local && saved.baseUrl
      ? '<p class="settings-description">' +
        tr('יעד הבקשות', 'Request destination') +
        '</p><code class="settings-path" dir="ltr">' +
        esc(saved.baseUrl) +
        '</code>'
      : '') +
    (openCode
      ? openCodeProtocolFields(draft, 'connection-' + provider + '-protocol', disabled)
      : '') +
    '<input type="hidden" name="defaultModel" value="' +
    esc(draft.defaultModel) +
    '"><label for="connection-' +
    provider +
    '-model">' +
    tr(
      'מודל ברירת מחדל — אפשר לבחור גם בבורר שבתחתית השיחה',
      'Default model — also available in the bottom chat picker',
    ) +
    '</label>' +
    (models.length
      ? '<select id="connection-' +
        provider +
        '-model" data-connection-model-list aria-label="' +
        tr('בחירת מודל מהרשימה', 'Choose a discovered model') +
        '" ' +
        disabled +
        '><option value="">' +
        tr('לפי ברירת המחדל של החיבור', 'Use connection default') +
        '</option>' +
        (!models.some(model => modelId(model) === draft.defaultModel) && draft.defaultModel
          ? '<option selected value="' +
            esc(draft.defaultModel) +
            '">' +
            esc(draft.defaultModel) +
            ' · ' +
            tr('בחירה שמורה', 'Saved selection') +
            '</option>'
          : '') +
        modelOptionsMarkup(models, draft.defaultModel) +
        '</select>'
      : '<p class="settings-description">' +
        tr(
          'בדיקת החיבור טוענת את רשימת המודלים לבחירה. אין צורך להקליד מזהה מודל.',
          'Check the connection to load models for selection. There is no need to type a model ID.',
        ) +
        '</p>') +
    '<details class="settings-advanced connection-advanced"><summary>' +
    tr('הגדרות חיבור מתקדמות', 'Advanced connection settings') +
    '</summary>' +
    (custom
      ? '<label for="connection-' +
        provider +
        '-name">' +
        tr('שם הספק אצלך', 'Your provider name') +
        '</label><input id="connection-' +
        provider +
        '-name" name="connectionName" value="' +
        esc(draft.name) +
        '" maxlength="80" ' +
        disabled +
        '><label for="connection-' +
        provider +
        '-url">' +
        tr('כתובת API', 'API base URL') +
        '</label><input id="connection-' +
        provider +
        '-url" name="baseUrl" type="url" dir="ltr" value="' +
        esc(draft.baseUrl) +
        '" ' +
        disabled +
        '><p class="settings-description">' +
        tr(
          'שינוי כתובת היעד דורש הזנה מחדש של המפתח לפני השמירה. הכתובת נפתחת משרת StellarCortex.',
          'Changing the destination requires reentering the key before saving. Requests originate from the StellarCortex server.',
        ) +
        '</p>' +
        catalogUrlField(draft, 'connection-' + provider + '-catalog', disabled) +
        (openCode
          ? ''
          : '<label for="connection-' +
            provider +
            '-protocol">' +
            tr('פורמט API', 'API format') +
            '</label><select id="connection-' +
            provider +
            '-protocol" name="protocol" ' +
            disabled +
            '>' +
            protocolOptions(draft.protocol) +
            '</select><p class="settings-description">' +
            connectionProtocolHelp() +
            '</p>')
      : '') +
    '<label for="connection-' +
    provider +
    '-manual-model">' +
    tr(
      'מזהה מודל ידני — רק אם השרת אינו מפרסם רשימה',
      'Manual model ID — only if the server does not publish a catalog',
    ) +
    '</label><input id="connection-' +
    provider +
    '-manual-model" name="manualModel" dir="ltr" maxlength="200" value="' +
    esc(draft.defaultModel) +
    '" ' +
    disabled +
    '><p class="settings-description">' +
    tr(
      'אין צורך למלא שדה זה כשאפשר לבחור מהרשימה.',
      'Leave this unchanged when models can be selected from the list.',
    ) +
    '</p>' +
    (local || custom ? connectionCapabilityFields(draft, disabled) : '') +
    '</details>' +
    '<div class="actions"><button class="primary" type="submit" ' +
    disabled +
    '>' +
    tr(busy === 'save' ? 'שומר…' : 'שמירת חיבור', busy === 'save' ? 'Saving…' : 'Save connection') +
    '</button><button class="secondary" type="button" data-connection-test ' +
    disabled +
    '>' +
    tr(
      busy === 'test' ? 'בודק…' : 'בדיקת חיבור ומודלים',
      busy === 'test' ? 'Checking…' : 'Check connection & models',
    ) +
    '</button>' +
    (saved.hasApiKey
      ? '<button class="danger" type="button" data-connection-remove ' +
        disabled +
        '>' +
        tr('מחיקת המפתח השמור', 'Remove saved key') +
        '</button>'
      : '') +
    '</div><p class="connection-feedback ' +
    (feedback?.kind === 'error' ? 'error' : '') +
    '" role="status">' +
    esc(
      feedback?.text ||
        tr(
          'הבדיקה משתמשת בהגדרות שנשמרו ואינה שולחת משימת מודל.',
          'The check uses saved settings and does not run a model task.',
        ),
    ) +
    '</p></form>'
  );
}
function apiProviderPresets() {
  const presets = [
    ...new Map(
      (connectionSettings?.apiPresets || API_PROVIDER_PRESETS).map(item => {
        const preset = item.id === 'custom' ? { ...item, id: 'other' } : item;
        return [preset.id, preset];
      }),
    ).values(),
  ];
  return presets.some(item => item.id === 'other')
    ? presets
    : [...presets, API_PROVIDER_PRESETS.find(item => item.id === 'other')];
}
function newProviderMarkup(session) {
  if (!session.newConnectionOpen) return '';
  const presets = apiProviderPresets();
  session.newConnectionPreset ||= presets[0].id;
  session.newConnectionDraft ||= newConnectionDraft(session.newConnectionPreset, presets);
  const draft = session.newConnectionDraft,
    busy = session.newConnectionBusy,
    disabled = busy ? 'disabled' : '',
    openCode = isOpenCodeEndpoint(draft.baseUrl);
  return (
    '<form id="new-api-provider-form" class="settings-section new-api-provider" autocomplete="off"><h4>' +
    tr('חיבור ספק API חדש', 'Connect a new API provider') +
    '</h4><label for="new-api-preset">' +
    tr('ספק', 'Provider') +
    '</label><select id="new-api-preset" name="preset" ' +
    disabled +
    '>' +
    presets
      .map(
        preset =>
          '<option value="' +
          esc(preset.id) +
          '" ' +
          (preset.id === session.newConnectionPreset ? 'selected' : '') +
          '>' +
          esc(preset.id === 'other' ? tr('ספק אחר', 'Other provider') : preset.label) +
          '</option>',
      )
      .join('') +
    '</select><p class="settings-description">' +
    tr('יעד הבקשות', 'Request destination') +
    '</p><code class="settings-path" id="new-api-destination" dir="ltr">' +
    esc(draft.baseUrl || tr('הזן כתובת בהגדרות המתקדמות', 'Enter a URL in advanced settings')) +
    '</code>' +
    (openCode ? openCodeProtocolFields(draft, 'new-api-protocol', disabled) : '') +
    '<label for="new-api-key">' +
    tr('מפתח API', 'API key') +
    '</label><input id="new-api-key" name="apiKey" data-connection-secret type="password" autocomplete="new-password" spellcheck="false" dir="ltr" required placeholder="' +
    tr('הדבק מפתח מהספק שנבחר', 'Paste a key from the selected provider') +
    '" ' +
    disabled +
    '><p class="settings-description">' +
    tr(
      'לאחר החיבור נטען את רשימת המודלים. תוכל לבחור ספק ומודל בבורר שבתחתית השיחה, בלי להקליד מזהה מודל. שימוש ב־API מחויב בנפרד מהמנוי.',
      'After connecting, we load the model catalog. Choose the provider and model in the bottom chat picker without typing a model ID. API usage is billed separately from your subscription.',
    ) +
    '</p><details class="settings-advanced" ' +
    (session.newConnectionPreset === 'other' ? 'open' : '') +
    '><summary>' +
    tr('שם, כתובת ופורמט API', 'Name, URL and API format') +
    '</summary><label for="new-api-name">' +
    tr('שם הספק אצלך', 'Your provider name') +
    '</label><input id="new-api-name" name="connectionName" maxlength="80" required value="' +
    esc(draft.name) +
    '" ' +
    disabled +
    '><label for="new-api-url">' +
    tr('כתובת API', 'API base URL') +
    '</label><input id="new-api-url" name="baseUrl" type="url" required dir="ltr" value="' +
    esc(draft.baseUrl) +
    '" ' +
    disabled +
    '>' +
    (openCode
      ? ''
      : '<label for="new-api-protocol">' +
        tr('פורמט API', 'API format') +
        '</label><select id="new-api-protocol" name="protocol" ' +
        disabled +
        '>' +
        protocolOptions(draft.protocol) +
        '</select><p class="settings-description">' +
        connectionProtocolHelp() +
        '</p>') +
    catalogUrlField(draft, 'new-api-catalog', disabled) +
    connectionCapabilityFields(draft, disabled) +
    '</details><div class="actions"><button type="submit" class="primary" ' +
    disabled +
    '>' +
    tr(
      busy ? 'מחבר וטוען מודלים…' : 'חיבור וטעינת מודלים',
      busy ? 'Connecting & loading models…' : 'Connect & load models',
    ) +
    '</button><button type="button" class="secondary" id="new-api-cancel" ' +
    disabled +
    '>' +
    tr('ביטול', 'Cancel') +
    '</button></div><p class="connection-feedback error" role="status">' +
    esc(session.newConnectionError || '') +
    '</p></form>'
  );
}
function readNewProviderDraft(session, form) {
  session.newConnectionDraft = connectionDraft({
    name: form.elements.connectionName.value,
    baseUrl: form.elements.baseUrl.value,
    modelsUrl: form.elements.modelsUrl.value,
    protocol: form.elements.protocol.value,
    toolsEnabled: form.elements.toolsEnabled.checked,
    visionEnabled: form.elements.visionEnabled.checked,
  });
  return session.newConnectionDraft;
}
function bindNewProviderForm(session) {
  const form = $('#new-api-provider-form');
  if (!form) return;
  form.oninput = event => {
    if (event.target.name === 'apiKey') return;
    readNewProviderDraft(session, form);
    if (event.target.name === 'baseUrl')
      $('#new-api-destination').textContent = form.elements.baseUrl.value;
  };
  form.elements.preset.onchange = () => {
    form.elements.apiKey.value = '';
    session.newConnectionPreset = form.elements.preset.value;
    session.newConnectionDraft = newConnectionDraft(
      session.newConnectionPreset,
      apiProviderPresets(),
    );
    session.newConnectionError = '';
    readConnectionDrafts();
    renderConnectionsSettings();
    $('#new-api-key')?.focus();
  };
  $('#new-api-cancel').onclick = () => {
    form.elements.apiKey.value = '';
    session.newConnectionOpen = false;
    session.newConnectionDraft = null;
    session.newConnectionError = '';
    readConnectionDrafts();
    renderConnectionsSettings();
  };
  form.onsubmit = act(async event => {
    event.preventDefault();
    if (session.newConnectionBusy) return;
    const payload = connectionCreate(
      readNewProviderDraft(session, form),
      form.elements.apiKey.value,
    );
    form.elements.apiKey.value = '';
    readConnectionDrafts();
    session.newConnectionBusy = true;
    session.newConnectionError = '';
    renderConnectionsSettings();
    let provider;
    try {
      const result = await api('/api/provider-connections', payload),
        saved = rememberConnection(result.connection || result);
      provider = saved.provider;
      session.connectionDrafts[provider] = connectionDraft(saved);
      session.newConnectionOpen = false;
      session.newConnectionDraft = null;
      session.connectionBusy[provider] = 'test';
      if (settingsIsOpen(session, 'connections')) renderConnectionsSettings();
      renderComposerModelControls();
      try {
        await testProviderConnection(session, provider);
      } catch (error) {
        session.connectionFeedback[provider] = {
          kind: 'error',
          text:
            tr(
              'הספק נוסף, אך לא ניתן לטעון מודלים: ',
              'Provider added, but model discovery failed: ',
            ) + error.message,
        };
      } finally {
        session.connectionBusy[provider] = null;
      }
    } catch (error) {
      session.newConnectionError = error.message;
    } finally {
      session.newConnectionBusy = false;
      if (settingsIsOpen(session, 'connections')) {
        renderConnectionsSettings();
        if (provider)
          $('[data-provider-connection="' + provider + '"]')?.scrollIntoView({
            block: 'start',
            behavior: 'smooth',
          });
      }
    }
  });
}
async function testProviderConnection(session, provider) {
  const result = await api('/api/provider-connections/' + provider + '/test', {});
  providerAccounts[provider] = result;
  const count = (result.models || []).filter(model => !model.hidden).length;
  session.connectionFeedback[provider] = {
    kind: result.connected ? 'success' : 'error',
    text: result.connected
      ? count
        ? tr(
            'החיבור נבדק. ' + count + ' מודלים זמינים בבורר שבתחתית השיחה.',
            'Connection checked. ' + count + ' models are available in the bottom chat picker.',
          )
        : tr(
            'החיבור נבדק, אך הספק לא פרסם רשימת מודלים. בדוק את פורמט ה־API או את ההגדרות המתקדמות.',
            'Connection checked, but the provider did not publish a model list. Check the API format or advanced settings.',
          )
      : withoutProgramOutput(result.error || result.modelsError, tr) ||
        tr('לא ניתן להתחבר לשרת.', 'Unable to connect to the server.'),
  };
  renderComposerModelControls();
  renderProviderNotice();
  renderUsageSurfaces();
  return result;
}
function renderConnectionsSettings() {
  const session = settingsSession;
  const providers = [
    ...new Set([
      ...CONNECTION_PROVIDER_IDS,
      ...(connectionSettings?.connections || [])
        .map(item => item.provider)
        .filter(isConnectionProvider),
    ]),
  ];
  $('#settings-content').innerHTML =
    '<div class="connection-page-heading"><h3>' +
    tr('מודלים וחיבורים', 'Models & connections') +
    '</h3><button class="secondary" id="add-api-provider" ' +
    (session.connectionsLoading || session.newConnectionBusy ? 'disabled' : '') +
    '>' +
    icon('plus') +
    tr('הוספת ספק API', 'Add API provider') +
    '</button></div><p class="settings-description">' +
    tr(
      'בחר בכל בוט את החיבור שיפעיל אותו. חיבורי המנוי הקיימים נמצאים בלשונית כללי.',
      'Choose the connection for each bot. Existing subscription connections are in General.',
    ) +
    '</p>' +
    providerTermsNote(tr) +
    newProviderMarkup(session) +
    (session.connectionsError
      ? '<p class="notice error">' +
        esc(session.connectionsError) +
        '</p><button class="secondary" id="connections-retry">' +
        tr('ניסיון נוסף', 'Retry') +
        '</button>'
      : '') +
    providers.map(provider => connectionCardMarkup(session, provider)).join('');
  bindConnectionForms(session);
  bindNewProviderForm(session);
  $('#add-api-provider').onclick = () => {
    readConnectionDrafts();
    session.newConnectionOpen = true;
    session.newConnectionError = '';
    renderConnectionsSettings();
    $('#new-api-key')?.focus();
  };
  $('#connections-retry')?.addEventListener(
    'click',
    act(async () => {
      session.connectionsLoading = true;
      session.connectionsError = null;
      readConnectionDrafts();
      renderConnectionsSettings();
      try {
        await loadConnectionSettings();
        session.connectionDrafts = Object.fromEntries(
          connectionSettings.connections.map(item => [item.provider, connectionDraft(item)]),
        );
      } catch (error) {
        session.connectionsError = error.message;
      } finally {
        session.connectionsLoading = false;
        if (settingsIsOpen(session, 'connections')) renderConnectionsSettings();
      }
    }),
  );
}
function refreshConnectionCard(session, provider) {
  if (!settingsIsOpen(session, 'connections')) return;
  const form = $('[data-provider-connection="' + provider + '"]');
  if (!form) return;
  form.outerHTML = connectionCardMarkup(session, provider);
  bindConnectionForms(session, $('[data-provider-connection="' + provider + '"]'));
}
function bindConnectionForms(session, root = $('#settings-content')) {
  const forms = root.matches('[data-provider-connection]')
    ? [root]
    : root.querySelectorAll('[data-provider-connection]');
  forms.forEach(form => {
    const provider = form.dataset.providerConnection;
    form.oninput = event => {
      if (event.target.name === 'manualModel')
        form.elements.defaultModel.value = event.target.value;
      if (event.target.name !== 'apiKey') readConnectionDrafts();
    };
    form.querySelector('[data-connection-model-list]')?.addEventListener('change', event => {
      form.elements.defaultModel.value = event.target.value;
      form.elements.manualModel.value = event.target.value;
      readConnectionDrafts();
    });
    if (provider === 'local')
      form.elements.engine.onchange = () => {
        readConnectionDrafts();
        const next = changeLocalEngine(
          session.connectionDrafts.local,
          form.elements.engine.value,
          connectionSettings?.localEngines || LOCAL_ENGINE_PRESETS,
        );
        session.connectionDrafts.local = next;
        form.elements.baseUrl.value = next.baseUrl;
      };
    form.onsubmit = act(async event => {
      event.preventDefault();
      if (session.connectionBusy[provider]) return;
      readConnectionDrafts();
      if (
        endpointKeyRequired(
          provider,
          session.connectionDrafts[provider],
          connectionRecord(provider),
          form.elements.apiKey.value,
        )
      ) {
        session.connectionFeedback[provider] = {
          kind: 'error',
          text: tr(
            'כתובת היעד השתנתה. הזן מחדש מפתח שמתאים לכתובת החדשה לפני השמירה.',
            'The destination changed. Reenter a key for the new endpoint before saving.',
          ),
        };
        const feedback = form.querySelector('.connection-feedback');
        feedback.textContent = session.connectionFeedback[provider].text;
        feedback.classList.add('error');
        form.elements.apiKey.focus();
        return;
      }
      const payload = connectionUpdate(
        provider,
        session.connectionDrafts[provider],
        form.elements.apiKey.value,
      );
      form.elements.apiKey.value = '';
      session.connectionBusy[provider] = 'save';
      session.connectionFeedback[provider] = null;
      refreshConnectionCard(session, provider);
      try {
        const result = await api('/api/provider-connections/' + provider, payload, 'PATCH'),
          saved = rememberConnection(result.connection || result);
        session.connectionDrafts[provider] = connectionDraft(saved);
        delete providerAccounts[provider];
        session.connectionBusy[provider] = 'test';
        session.connectionFeedback[provider] = {
          kind: 'success',
          text: tr('החיבור נשמר. טוען את רשימת המודלים…', 'Connection saved. Loading models…'),
        };
        refreshConnectionCard(session, provider);
        renderUsageSurfaces();
        await testProviderConnection(session, provider);
      } catch (error) {
        session.connectionFeedback[provider] = { kind: 'error', text: error.message };
      } finally {
        session.connectionBusy[provider] = null;
        refreshConnectionCard(session, provider);
      }
    });
    form.querySelector('[data-connection-test]').onclick = act(async () => {
      if (session.connectionBusy[provider]) return;
      readConnectionDrafts();
      if (
        connectionNeedsSave(
          provider,
          session.connectionDrafts[provider],
          connectionRecord(provider),
          form.elements.apiKey.value,
        )
      ) {
        session.connectionFeedback[provider] = {
          kind: 'error',
          text: tr(
            'שמור את השינויים לפני בדיקת החיבור.',
            'Save your changes before checking the connection.',
          ),
        };
        form.querySelector('.connection-feedback').textContent =
          session.connectionFeedback[provider].text;
        return;
      }
      session.connectionBusy[provider] = 'test';
      session.connectionFeedback[provider] = null;
      refreshConnectionCard(session, provider);
      try {
        await testProviderConnection(session, provider);
      } catch (error) {
        session.connectionFeedback[provider] = { kind: 'error', text: error.message };
      } finally {
        session.connectionBusy[provider] = null;
        refreshConnectionCard(session, provider);
      }
    });
    form.querySelector('[data-connection-remove]')?.addEventListener(
      'click',
      act(async () => {
        if (session.connectionBusy[provider]) return;
        readConnectionDrafts();
        form.elements.apiKey.value = '';
        session.connectionBusy[provider] = 'remove';
        refreshConnectionCard(session, provider);
        try {
          const result = await api(
            '/api/provider-connections/' + provider,
            { removeApiKey: true },
            'PATCH',
          );
          rememberConnection(result.connection || result);
          delete providerAccounts[provider];
          session.connectionFeedback[provider] = {
            kind: 'success',
            text: tr('המפתח השמור נמחק.', 'Saved key removed.'),
          };
          renderUsageSurfaces();
        } catch (error) {
          session.connectionFeedback[provider] = { kind: 'error', text: error.message };
        } finally {
          session.connectionBusy[provider] = null;
          refreshConnectionCard(session, provider);
        }
      }),
    );
  });
}
function renderSettings() {
  const session = settingsSession;
  if (!session) return;
  modal(
    tr('הגדרות', 'Settings'),
    `<div class="settings-shell"><nav class="settings-nav" aria-label="${tr('קטגוריות הגדרות', 'Settings categories')}">${settingsLabels()
      .map(
        ([id, label, image]) =>
          `<button type="button" data-settings-pane="${id}" class="${session.pane === id ? 'active' : ''}" aria-current="${session.pane === id ? 'page' : 'false'}">${icon(image)}<span>${label}</span></button>`,
      )
      .join(
        '',
      )}<div class="settings-nav-brand">StellarCortex<small>${session.health?.version ? `v${esc(session.health.version)}` : ''}</small></div></nav><section class="settings-content" id="settings-content"></section></div>`,
    true,
  );
  $('#modal').dataset.kind = 'settings';
  $('#modal-body')
    .querySelectorAll('[data-settings-pane]')
    .forEach(
      button =>
        (button.onclick = () => {
          readSettingsDraft();
          session.pane = button.dataset.settingsPane;
          renderSettings();
        }),
    );
  if (session.pane === 'general') renderGeneralSettings();
  else if (session.pane === 'connections') renderConnectionsSettings();
  else if (session.pane === 'computer') renderComputerSettings();
  else if (session.pane === 'usage') renderUsageSettings();
  else renderUpdateSettings();
  $('#settings-content')
    .querySelectorAll('label')
    .forEach((label, index) => {
      const field = label.nextElementSibling;
      if (field?.matches('input,textarea,select')) {
        field.id ||= `setting-field-${index}`;
        label.htmlFor = field.id;
      }
    });
}
function renderGeneralSettings() {
  const session = settingsSession,
    draft = session.draft,
    a = account?.account;
  $('#settings-content').innerHTML =
    `<h3>${tr('כללי', 'General')}</h3><section class="settings-section"><h4>${tr('חשבון', 'Account')}</h4><div class="settings-account"><span class="account-circle">${esc(accountName().charAt(0).toUpperCase())}</span><div><strong dir="auto">${esc(accountName())}</strong><small>${esc(accountPlan())}</small></div><span class="settings-connection ${a?.type === 'chatgpt' ? 'connected' : ''}">${a?.type === 'chatgpt' ? tr('מחובר', 'Connected') : tr('לא מחובר', 'Not connected')}</span></div>${session.accountError || account?.error ? `<p class="notice">${esc(withoutProgramOutput(session.accountError || account.error, tr))}</p>` : ''}<div class="actions"><button id="connect-chatgpt" class="secondary">${a?.type === 'chatgpt' ? tr('כניסה לחשבון ChatGPT', 'ChatGPT sign-in') : tr('התחברות עם ChatGPT', 'Sign in with ChatGPT')}</button><button class="secondary" id="restart-connection">${tr('רענון החיבור', 'Reconnect')}</button></div><div id="login-details"></div><p class="settings-description">${tr('ההתחברות מתבצעת אצל OpenAI. העבודה משתמשת במכסת Codex של המנוי שלך.', 'OpenAI handles sign-in. Work uses your subscription’s Codex allowance.')}</p>${providerTermsNote(tr)}</section><form id="settings-form"><section class="settings-section"><h4>${tr('מראה ושפה', 'Appearance')}</h4><div class="settings-form-row"><div><label>${tr('תצוגה', 'Theme')}</label><select name="theme">${[
      ['system', tr('לפי המערכת', 'Follow system')],
      ['light', tr('בהיר', 'Light')],
      ['dark', tr('כהה', 'Dark')],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${draft.theme === value ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select></div><div><label>${tr('שפה', 'Language')}</label><select name="language"><option value="he" ${draft.language === 'he' ? 'selected' : ''}>עברית</option><option value="en" ${draft.language === 'en' ? 'selected' : ''}>English</option></select></div></div></section><section class="settings-section"><h4>${tr('העדפות עבודה', 'Bot preferences')}</h4><label>${tr('אזור זמן לשגרות', 'Routine time zone')}</label><input name="timezone" value="${esc(draft.timezone)}" dir="ltr"><div class="settings-toggle-row"><div><strong>${tr('התראות בדפדפן', 'Browser notifications')}</strong><small>${tr('התראה כשמשימה מסתיימת והחלון אינו פעיל.', 'Notify when a task finishes while this window is inactive.')}</small></div><input id="settings-notifications" type="checkbox" role="switch" aria-label="${tr('התראות בדפדפן', 'Browser notifications')}" ${state.settings.notifications ? 'checked' : ''}></div></section><details class="settings-advanced"><summary>${tr('הגדרות Codex מתקדמות', 'Advanced Codex settings')}</summary><label>${tr('מודל', 'Model')}</label><select name="model"><option value="">${tr('ברירת המחדל של Codex', 'Codex default')}</option>${settingsModelOptions(draft.model)}</select><label>${tr('מספר משימות במקביל', 'Concurrent tasks')}</label><input name="concurrency" type="number" min="1" max="4" value="${esc(draft.concurrency)}"><p class="settings-description">${tr('אפשר להריץ עד ארבע משימות במקביל; לכל בוט משימה פעילה אחת.', 'Up to four tasks can run concurrently, with one active task per bot.')}</p></details><div class="settings-save"><button class="primary">${tr('שמירת שינויים', 'Save changes')}</button></div></form>`;
  $('#settings-form .settings-form-row').insertAdjacentHTML(
    'afterend',
    designPickerMarkup(draft.design, { tr, esc }),
  );
  $('#settings-form').insertAdjacentHTML('beforebegin', claudeConnectionMarkup(session));
  $('#settings-form').insertAdjacentHTML(
    'beforebegin',
    '<section class="settings-section" id="claude-permission-settings"></section>',
  );
  mountClaudePermissions($('#claude-permission-settings'), { api, tr, esc, onSaved: refresh });
  mountClaudeLogin($('#claude-login-flow'), {
    api,
    tr,
    esc,
    onConnected: () => $('#claude-refresh')?.click(),
  });
  $('#claude-refresh').onclick = act(async () => {
    const button = $('#claude-refresh');
    button.disabled = true;
    session.claudeError = null;
    try {
      await loadProviderAccount('claude', { refresh: true });
    } catch (error) {
      session.claudeError = error.message;
    } finally {
      if (settingsIsOpen(session, 'general')) {
        readSettingsDraft();
        renderGeneralSettings();
      }
    }
  });
  $('#claude-copy-login').onclick = act(async () => {
    const command = providerAccounts.claude?.loginInstructions;
    if (!command)
      throw new Error(
        tr(
          'הפקודה עוד לא נטענה. לחץ על בדיקת חיבור.',
          'The command has not loaded yet. Choose Check connection.',
        ),
      );
    await navigator.clipboard.writeText(command);
    toast(tr('פקודת הכניסה הועתקה', 'Sign-in command copied'));
  });
  $('#connect-chatgpt').onclick = act(async () => {
    const button = $('#connect-chatgpt');
    button.disabled = true;
    try {
      const login = await api('/api/login', {});
      const url = login.verificationUrl || login.authUrl;
      if (!url || !url.startsWith('https://'))
        throw new Error('OpenAI did not return a sign-in URL');
      if (!$('#login-details')) return;
      $('#login-details').innerHTML =
        `<div class="notice"><a href="${esc(url)}" target="_blank" rel="noopener">${tr('פתיחת כניסה מאובטחת ב־OpenAI', 'Open secure OpenAI sign-in')} ↗</a>${login.userCode ? `<p class="settings-device-code" dir="ltr">${esc(login.userCode)}</p>` : ''}<p>${tr('בסיום ההתחברות, לחץ על רענון החיבור.', 'After signing in, choose Reconnect to refresh your account.')}</p></div>`;
    } finally {
      button.disabled = false;
    }
  });
  $('#restart-connection').onclick = act(async () => {
    await api('/api/reconnect', {});
    await loadAccount();
    await refresh();
    if (settingsIsOpen(session)) {
      readSettingsDraft();
      renderSettings();
    }
    toast(tr('החיבור רוענן', 'Connection refreshed'));
  });
  $('#settings-notifications').onchange = act(async event => {
    const field = event.target;
    field.disabled = true;
    try {
      let enabled = field.checked;
      if (enabled) {
        if (!('Notification' in window))
          throw new Error(
            tr('הדפדפן אינו תומך בהתראות', 'Notifications are unavailable in this browser'),
          );
        enabled = (await Notification.requestPermission()) === 'granted';
      }
      await api('/api/settings', { notifications: enabled }, 'PATCH');
      state.settings.notifications = enabled;
      field.checked = enabled;
      toast(
        enabled
          ? tr('התראות הופעלו', 'Notifications enabled')
          : tr('התראות כבויות', 'Notifications disabled'),
      );
    } catch (error) {
      field.checked = !!state.settings.notifications;
      throw error;
    } finally {
      field.disabled = false;
    }
  });
  $('#settings-form').onsubmit = act(async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.concurrency = Number(data.concurrency);
    await api('/api/settings', data, 'PATCH');
    await refresh();
    session.draft = { ...state.settings };
    if (settingsIsOpen(session)) renderSettings();
    toast(tr('ההגדרות נשמרו', 'Settings saved'));
  });
}
function renderComputerSettings() {
  $('#settings-content').innerHTML =
    `<h3>${tr('מחשב', 'Computer')}</h3><section class="settings-section" id="computer-build-settings"></section><section class="settings-section" id="computer-mode-settings"></section><section class="settings-section" id="computer-boot-settings" hidden></section><section class="settings-section"><h4>${tr('קבצי סביבת העבודה', 'Workspace files')}</h4><p class="settings-description">${tr('הקבצים משותפים לבוטים בהתקנה הזאת.', 'Files are shared by the bots in this installation.')}</p><code class="settings-path" dir="ltr">${esc(state.workspace)}</code><a class="secondary" href="/api/export" download>${tr('ייצוא נתוני עבודה', 'Export workspace data')}</a><p class="settings-description">${tr('הייצוא כולל נתוני שיחות והגדרות; גיבוי מלא כולל גם את קבצי העבודה ופרופילי הדפדפן.', 'The export contains conversation data and settings. A complete backup also includes workspace files and browser profiles.')}</p></section>`;
  const modes = mountComputerModes($('#computer-mode-settings'), {
    api,
    tr,
    esc,
    onSaved: refresh,
    focusBot: settingsSession?.computerBot,
  });
  mountComputerBuild($('#computer-build-settings'), { api, tr, esc, onState: modes.setBuild });
  mountComputerBoot($('#computer-boot-settings'), { api, tr });
}
function tokenUsageCardMarkup(session, provider) {
  const loading = !!session.usageLoading?.[provider],
    report = providerUsage(provider),
    error =
      session.usageErrors?.[provider] || providerAccount(provider)?.usageError || report?.error;
  return (
    '<section class="settings-section provider-usage-card ' +
    provider +
    '"><h4>' +
    esc(providerName(provider)) +
    '</h4><p class="settings-description">' +
    tr(
      'טוקנים ובקשות שדווחו בהרצות של StellarCortex בהתקנה הזאת. אלה אינם יתרת חשבון או אומדן חשבונית.',
      'Tokens and requests reported by StellarCortex runs in this installation. These are not an account balance or a bill estimate.',
    ) +
    '</p>' +
    (tokenUsageMarkup(provider) ||
      '<p class="notice">' +
        tr('טרם התקבלו נתוני טוקנים מהשרת.', 'The server has not reported token usage yet.') +
        '</p>') +
    usageReportMeta(provider) +
    (error ? '<p class="notice error">' + esc(usageErrorText(error, tr)) + '</p>' : '') +
    '<button type="button" class="secondary" data-usage-refresh="' +
    provider +
    '" ' +
    (loading ? 'disabled' : '') +
    '>' +
    tr(loading ? 'מרענן…' : 'רענון נתוני שימוש', loading ? 'Refreshing…' : 'Refresh usage') +
    '</button></section>'
  );
}
function renderUsageSettings() {
  const session = settingsSession;
  $('#settings-content').innerHTML =
    '<h3>' +
    tr('שימוש ומנויים', 'Usage & plans') +
    '</h3>' +
    ['codex', 'claude']
      .map(provider => {
        const connection = providerAccount(provider),
          report = providerUsage(provider),
          error = session.usageErrors?.[provider] || connection?.usageError || report?.error;
        const plan =
          provider === 'codex'
            ? accountPlan()
            : connection?.account?.planType
              ? `Claude ${connection.account.planType}`
              : connection?.connected
                ? tr('חשבון Claude מחובר', 'Claude account connected')
                : tr('חשבון Claude לא מחובר', 'Claude account not connected');
        const loading = !!session.usageLoading?.[provider];
        return (
          '<section class="settings-section provider-usage-card ' +
          provider +
          '"><h4>' +
          (provider === 'codex' ? 'GPT / Codex' : 'Claude') +
          '</h4><div class="settings-plan"><strong>' +
          esc(plan) +
          '</strong><span dir="auto">' +
          esc(connection?.account?.email || '') +
          '</span></div><p class="settings-description">' +
          (provider === 'codex'
            ? tr(
                'המשימות של בוטי Codex משתמשות במכסת מנוי ChatGPT המחובר.',
                'Codex bot tasks use the connected ChatGPT plan’s allowance.',
              )
            : tr(
                'המשימות של בוטי Claude משתמשות במכסת חשבון Claude המחובר. הנתונים מתקבלים מ־Claude Code.',
                'Claude bot tasks use the connected Claude account’s allowance. Usage is reported by Claude Code.',
              )) +
          '</p>' +
          (usageMarkup(false, provider) ||
            '<p class="notice">' +
              (loading
                ? tr('בודק את נתוני השימוש…', 'Checking usage…')
                : tr(
                    'נתוני השימוש אינם זמינים כרגע. בדוק את החיבור לחשבון או רענן.',
                    'Usage data is unavailable. Check the account connection or refresh.',
                  )) +
              '</p>') +
          usageReportMeta(provider) +
          (error ? '<p class="notice error">' + esc(usageErrorText(error, tr)) + '</p>' : '') +
          '<button class="secondary" id="' +
          (provider === 'codex' ? 'settings-usage-refresh' : 'settings-claude-usage-refresh') +
          '" data-usage-refresh="' +
          provider +
          '" ' +
          (loading ? 'disabled' : '') +
          '>' +
          tr(loading ? 'מרענן…' : 'רענון נתוני שימוש', loading ? 'Refreshing…' : 'Refresh usage') +
          '</button></section>'
        );
      })
      .join('') +
    configuredConnectionProviders()
      .map(provider => tokenUsageCardMarkup(session, provider))
      .join('') +
    '<p class="settings-description">' +
    tr(
      'מכסות המנוי, חיובי API והרצות מקומיות נפרדים. הרענון קורא נתוני שימוש ואינו מפעיל משימת בוט.',
      'Subscription allowances, API billing and local runs are separate. Refresh reads usage without running a bot task.',
    ) +
    '</p>';
  $('#settings-content')
    .querySelectorAll('[data-usage-refresh]')
    .forEach(
      button =>
        (button.onclick = act(async () => {
          const provider = button.dataset.usageRefresh;
          session.usageLoading ||= {};
          session.usageErrors ||= {};
          session.usageLoading[provider] = true;
          delete session.usageErrors[provider];
          renderUsageSettings();
          try {
            await loadProviderAccount(provider, { refresh: true });
          } catch (error) {
            session.usageErrors[provider] = error.message;
          } finally {
            session.usageLoading[provider] = false;
            if (settingsIsOpen(session, 'usage')) renderUsageSettings();
          }
        })),
    );
}
function renderUpdateSettings() {
  $('#settings-content').innerHTML =
    '<h3>' +
    tr('עדכונים', 'Updates') +
    '</h3><section class="settings-section" id="software-update-settings"></section>';
  mountSoftwareUpdates($('#software-update-settings'), { api, tr, esc });
}

$('#new-chat').innerHTML = icon('plus');
$('#new-chat').onclick = newChat;
$('#search').onclick = search;
$('#account').onclick = act(openAccountMenu);
$('#attach').innerHTML = icon('plus');
$('#dictate').innerHTML = icon('mic');
$('#voice-call').innerHTML = icon('phone');
$('#voice-call').onclick = act(openVoicePanel);
$('#send').innerHTML = icon('arrow');
$('#attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = () => {
  const selected = [...$('#file-input').files];
  if (files.length + selected.length > 6)
    return toast(tr('עד 6 קבצים להודעה', 'Up to 6 attachments'));
  if (selected.some(f => f.size > 25 * 1024 * 1024)) return toast('Maximum file size: 25 MB');
  files.push(...selected);
  renderAttachments();
  $('#file-input').value = '';
};
function renderAttachments() {
  $('#attachments').innerHTML = files
    .map(
      (f, i) =>
        `<span class="attachment">${esc(f.name)}<button type="button" data-remove-file="${i}" aria-label="Remove attachment">×</button></span>`,
    )
    .join('');
  $('#attachments')
    .querySelectorAll('button')
    .forEach(
      b =>
        (b.onclick = () => {
          files.splice(Number(b.dataset.removeFile), 1);
          renderAttachments();
        }),
    );
}
$('#mention').onclick = () => {
  modal(
    tr('אזכור בוט', 'Mention a teammate'),
    activeChat()
      .botIds.map(
        id => `<button class="detail-card" data-mention="${id}">${esc(botById(id).name)}</button>`,
      )
      .join(''),
  );
  $('#modal-body')
    .querySelectorAll('[data-mention]')
    .forEach(
      b =>
        (b.onclick = () => {
          $('#prompt').value += `@${botById(b.dataset.mention).name} `;
          $('#modal').close();
          $('#prompt').focus();
        }),
    );
};
$('#skill-picker').onclick = () => {
  modal(
    tr('בחירת מיומנות', 'Choose a skill'),
    state.skills
      .filter(s => !s.botId || s.botId === composerSettingsBot()?.id)
      .map(s => `<button class="detail-card" data-choose-skill="${s.id}">/${esc(s.name)}</button>`)
      .join('') ||
      `<p class="muted">${tr('עדיין אין מיומנויות שמורות.', 'No saved skills yet.')}</p>`,
  );
  $('#modal-body')
    .querySelectorAll('[data-choose-skill]')
    .forEach(
      b => (b.onclick = () => useSkill(state.skills.find(s => s.id === b.dataset.chooseSkill))),
    );
};
$('#prompt').oninput = () => {
  drafts[chatId] = $('#prompt').value;
  localStorage.setItem('stellarcortex-drafts', JSON.stringify(drafts));
  $('#prompt').style.height = 'auto';
  $('#prompt').style.height = Math.min(180, $('#prompt').scrollHeight) + 'px';
};
$('#prompt').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
};
$('#composer').onsubmit = act(async e => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text && !files.length) return;
  const submitChat = chatId;
  if (composerSubmissions.has(submitChat)) return;
  composerSubmissions.add(submitChat);
  $('#send').disabled = true;
  try {
    const attachments = await Promise.all(
      files.map(
        file =>
          new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve({ name: file.name, base64: String(r.result).split(',')[1] });
            r.onerror = reject;
            r.readAsDataURL(file);
          }),
      ),
    );
    const available = activeChat().botIds.filter(id => !botById(id)?.deletedAt),
      reply = state.messages.find(m => m.id === replyToId);
    const mentioned = /@everyone(?:\s|$)/i.test(text)
      ? available
      : available.filter(id => text.includes('@' + botById(id).name));
    const targets = mentioned.length
      ? mentioned
      : reply?.botId && available.includes(reply.botId)
        ? [reply.botId]
        : undefined;
    const sent = await api(`/api/chats/${submitChat}/messages`, {
      text: text || tr('נתח את הקבצים המצורפים.', 'Analyze the attached files.'),
      attachments,
      botIds: targets,
      replyTo: replyToId,
    });
    if (sent.message && !state.messages.some(m => m.id === sent.message.id)) {
      state.messages.push(sent.message);
      if (view === 'chat' && chatId === submitChat) renderConversation();
    }
    if (chatId === submitChat) {
      replyToId = null;
      renderReplyContext();
      $('#prompt').value = '';
      $('#prompt').style.height = 'auto';
      files = [];
      renderAttachments();
    }
    drafts[submitChat] = '';
    localStorage.setItem('stellarcortex-drafts', JSON.stringify(drafts));
    await refresh().catch(() => {});
  } finally {
    composerSubmissions.delete(submitChat);
    $('#send').disabled = false;
  }
});
$('#dictate').onclick = () => {
  if (voiceIsLive()) return;
  dictation?.abort();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition)
    return toast(
      tr(
        'הכתבה זמינה בדפדפנים שתומכים בזיהוי דיבור. אפשר להשתמש בהכתבה של מערכת ההפעלה.',
        'Dictation needs browser speech recognition. You can use your operating system’s dictation.',
      ),
    );
  const r = new Recognition();
  dictation = r;
  r.lang = state.settings.language === 'he' ? 'he-IL' : 'en-US';
  r.interimResults = false;
  r.onresult = e => {
    $('#prompt').value += e.results[0][0].transcript;
    $('#prompt').oninput();
  };
  r.onerror = e => toast(e.error);
  r.onend = () => {
    if (dictation === r) dictation = null;
    $('#dictate').style.color = '';
  };
  $('#dictate').style.color = 'var(--accent)';
  r.start();
};
document.addEventListener('keydown', e => {
  if (computerExpanded) {
    if (e.key === 'Escape' && (!computerManual || ((e.ctrlKey || e.metaKey) && e.shiftKey))) {
      e.preventDefault();
      act(closeComputerViewer)();
      return;
    }
    if (e.key === 'Tab' && e.target.id !== 'computer-keyboard-input') {
      const fields = [
        ...$('#details').querySelectorAll(
          'button:not([disabled]),summary,input,select,[tabindex="0"]',
        ),
      ].filter(
        el =>
          !el.hidden &&
          el.getClientRects().length &&
          (!el.closest('details') || el.closest('details').open || el.tagName === 'SUMMARY'),
      );
      const first = fields[0],
        last = fields.at(-1);
      if (e.shiftKey && e.target === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && e.target === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || !state) return;
  if (e.key === 'k') {
    e.preventDefault();
    search();
  }
  if (e.key === 'n') {
    e.preventDefault();
    newChat();
  }
  if (e.key === ',') {
    e.preventDefault();
    settings();
  }
  if (e.key === 'b') {
    e.preventDefault();
    $('#sidebar').classList.toggle('open');
  }
  if (e.key === '/' && typeof showKeyboardShortcuts === 'function') {
    e.preventDefault();
    showKeyboardShortcuts();
  }
});
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/session', { key: $('#access-key').value.trim() });
    $('#access-key').value = '';
    await boot();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
};
async function boot() {
  const returned = new URL(location.href),
    connectionReturn = returned.searchParams.get('connections');
  if (connectionReturn === 'mcp') {
    view = 'apps';
    appsHub.returnResult = returned.searchParams.get('result') === 'error' ? 'error' : '';
    returned.searchParams.delete('connections');
    returned.searchParams.delete('result');
    history.replaceState(null, '', returned.pathname + returned.search + returned.hash);
    appsHub.loaded = false;
  }
  const fragment = new URLSearchParams(location.hash.slice(1));
  const key = fragment.get('key');
  if (key) {
    history.replaceState(null, '', location.pathname);
    await api('/api/session', { key });
  }
  await refresh();
  connectEvents();
  loadAccount().catch(e => toast(e.message));
  loadConnectionSettings().catch(() => {});
}
// The server hands a notice to one page load only, so it shows once.
function showNotices() {
  if (state.notices?.includes('google-removed'))
    toast(
      tr(
        'חיבור Google המובנה הוסר. בדקו ב־myaccount.google.com/permissions שהגישה של StellarCortex הוסרה. אפשר לחבר את Google דרך שירות MCP כמו Composio.',
        'The built-in Google connection was removed. Check at myaccount.google.com/permissions that StellarCortex no longer has access. You can connect Google through an MCP service such as Composio.',
      ),
      20000,
      true,
    );
}
boot().catch(e => {
  $('#login').hidden = false;
  $('#app').hidden = true;
  if (e.message !== 'Sign in with this installation’s access key')
    $('#login-error').textContent = e.message;
});
