// Mission control: a command bar and a live activity pane built from existing state.
import { scopeExecution } from '../kanban.js';
import { chatStatus } from './design.js';

const KANBAN_REFRESH_MS = 15000,
  LOG_ROWS = 6,
  WORKING = ['running', 'queued'];
const TABS = [
  ['chat', 'שיחה', 'Chat'],
  ['media', 'מדיה', 'Media'],
  ['computer', 'מחשב', 'Computer'],
  ['routines', 'שגרות', 'Routines'],
];

// Counts per column, grouped the way the pane shows them. Archived cards never count.
export function boardCounts(cards = []) {
  const counts = { todo: 0, working: 0, review: 0, done: 0 };
  for (const card of cards) {
    if (card.archivedAt) continue;
    if (['todo', 'idea'].includes(card.stage)) counts.todo++;
    else if (['approval', 'testing'].includes(card.stage)) counts.review++;
    else if (card.stage === 'done') counts.done++;
    else counts.working++;
  }
  return counts;
}

export function jobCounts(state) {
  const waiting = state.approvals.filter(item => item.status === 'pending').length;
  return { working: state.jobs.filter(job => WORKING.includes(job.status)).length, waiting };
}

export function recentActivity(messages, limit = LOG_ROWS) {
  return messages
    .filter(message => message.role === 'tool')
    .toSorted((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

export function createMission(ctx) {
  const { tr, esc } = ctx;
  let kanban = null,
    kanbanAt = 0,
    kanbanLoading = false,
    statusTimer = null,
    tabObserver = null,
    barMarkup = '',
    paneMarkup = '';
  const $ = selector => document.querySelector(selector);
  const chatName = id => ctx.state().chats.find(chat => chat.id === id)?.name || '';
  const botName = id => ctx.state().bots.find(bot => bot.id === id)?.name || '';
  const detailsOpen = () => !$('#details').hidden;
  // Bar buttons act only while the workspace is open, not after lock or session expiry.
  const whileOpen = action => () => {
    if (!$('#app').hidden && ctx.state()) action();
  };

  function serverChip() {
    const chip = $('#design-server');
    if (!chip) return;
    const online = ctx.online();
    chip.dataset.online = String(online);
    chip.querySelector('span').textContent = online
      ? tr('השרת פעיל', 'Server running')
      : tr('מתחבר…', 'Connecting…');
  }

  function renderBar() {
    const counts = jobCounts(ctx.state()),
      light = document.body.classList.contains('light');
    const bar =
      $('#design-bar') ||
      document.body.insertBefore(
        Object.assign(document.createElement('header'), { id: 'design-bar' }),
        $('#app'),
      );
    bar.dir = document.documentElement.dir;
    const markup = `<span class="design-logo"><img src="${light ? '/stellar-cortex-icon.svg' : '/stellar-cortex-mark.svg'}" width="30" height="30" alt=""><span>StellarCortex</span></span>
      <button class="design-omni" id="design-search" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"/></svg><span>${esc(tr('חיפוש בוטים, הודעות ומשימות', 'Search bots, messages and tasks'))}</span><kbd>Ctrl K</kbd></button>
      <div class="design-bar-end">
        <span class="design-chip design-opt" id="design-server"><i></i><span></span></span>
        <button class="design-chip design-opt" id="design-working" type="button" ${counts.working ? '' : 'disabled'}><b>${counts.working}</b>${esc(tr('בעבודה', 'working'))}</button>
        <button class="design-chip" id="design-waiting" type="button" data-needs="${counts.waiting > 0}" ${counts.waiting ? '' : 'disabled'}><b>${counts.waiting}</b>${esc(tr('ממתין לך', 'need you'))}</button>
        <button class="icon design-opt" id="design-theme" type="button" aria-label="${esc(tr('החלפת תצוגה', 'Switch theme'))}" title="${esc(tr('בהיר או כהה', 'Light or dark'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${light ? 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5' : 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'}"/></svg></button>
        <button class="icon" id="design-settings" type="button" aria-label="${esc(tr('הגדרות', 'Settings'))}" title="${esc(tr('הגדרות', 'Settings'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M18 6h2M4 12h3M12 12h8M4 18h11M15.5 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM9.5 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM17.5 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z"/></svg></button>
      </div>`;
    // Unchanged markup is left alone so keyboard focus survives live updates.
    if (markup === barMarkup) return;
    barMarkup = markup;
    bar.innerHTML = markup;
    $('#design-search').onclick = whileOpen(() => ctx.search());
    $('#design-working').onclick = whileOpen(() => {
      const job = ctx.state().jobs.find(item => WORKING.includes(item.status));
      if (job) ctx.openChat(job.chatId);
    });
    $('#design-waiting').onclick = whileOpen(() => {
      const item = ctx.state().approvals.find(approval => approval.status === 'pending');
      if (item) ctx.openChat(item.chatId);
    });
    $('#design-settings').onclick = whileOpen(() => {
      if (!document.documentElement.hasAttribute('data-settings-page')) ctx.settings();
    });
    $('#design-theme').onclick = whileOpen(() =>
      ctx.setTheme(document.body.classList.contains('light') ? 'dark' : 'light'),
    );
  }

  function markRows() {
    const labels = {
      waiting: tr('ממתין לך', 'Needs you'),
      running: tr('עובד', 'Working'),
      '': tr('פנוי', 'Free'),
    };
    document.querySelectorAll('#bot-list .bot-row-wrap').forEach(row => {
      const status = row.dataset.status || '';
      row
        .querySelector('.bot-info')
        ?.insertAdjacentHTML(
          'afterend',
          `<span class="design-state" data-status="${status}"><i></i>${esc(labels[status])}</span>`,
        );
    });
  }

  function renderTabs() {
    const header = $('#header');
    if (ctx.view() !== 'chat' || !ctx.chatId()) return;
    header
      .querySelector('.header-title')
      ?.insertAdjacentHTML(
        'afterend',
        `<nav class="design-tabs" aria-label="${esc(tr('תצוגות השיחה', 'Conversation views'))}">${TABS.map(([id, he, en]) => `<button type="button" data-design-tab="${id}">${esc(tr(he, en))}</button>`).join('')}</nav>`,
      );
    header
      .querySelectorAll('[data-design-tab]')
      .forEach(button => (button.onclick = () => ctx.showTab(button.dataset.designTab)));
    syncTabs();
  }

  function syncTabs() {
    const active = detailsOpen() ? ctx.detailTab() : 'chat';
    document.querySelectorAll('[data-design-tab]').forEach(button => {
      if (button.dataset.designTab === active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function loadKanban() {
    if (kanbanLoading || Date.now() - kanbanAt < KANBAN_REFRESH_MS) return;
    kanbanLoading = true;
    ctx
      .api('/api/kanban')
      .then(data => {
        kanban = data;
        kanbanAt = Date.now();
        renderPane();
      })
      .catch(() => {
        kanban = null;
        kanbanAt = Date.now();
        renderPane();
      })
      .finally(() => {
        kanbanLoading = false;
      });
  }

  function bulkAction() {
    if (!kanban) return null;
    const bots = ctx.state().bots,
      scopes = [null, ...kanban.projects.map(project => project.id)].map(id =>
        scopeExecution(kanban, id, bots),
      );
    if (scopes.some(scope => scope.showPause)) return 'pause';
    if (
      !scopes.some(scope => scope.scope.bulk && scope.active) &&
      scopes.some(
        scope =>
          (scope.scope.bulk || scope.scope.shutdown) &&
          !scope.uncertain &&
          (scope.ready || scope.resumable),
      )
    )
      return 'resume';
    return null;
  }

  function renderPane() {
    const pane = $('#design-activity');
    if (!pane || !ctx.state()) return;
    const state = ctx.state(),
      chatId = ctx.chatId(),
      board = kanban && boardCounts(kanban.cards),
      bulk = bulkAction();
    const cell = (label, value, kind = '') =>
      `<div class="design-cell" data-kind="${kind}"><small>${esc(label)}</small><b>${value}</b></div>`;
    const log = recentActivity(state.messages)
      .map(
        message =>
          `<li><button type="button" data-design-chat="${esc(message.chatId)}"><time>${esc(ctx.relativeTime(message.createdAt))}</time><span><b>${esc(botName(message.botId) || chatName(message.chatId))}</b> ${esc(ctx.toolLabel(message))}<small>${esc(ctx.statusLabel(message.status))}</small></span></button></li>`,
      )
      .join('');
    const jobs = state.jobs
      .filter(job => job.chatId === chatId)
      .slice(-6)
      .reverse()
      .map(
        job =>
          `<li><button type="button" data-design-job="${esc(job.id)}"><span dir="auto">${esc(job.title || job.prompt || job.text || job.activity || tr('משימה', 'Task'))}</span><span class="design-state" data-status="${esc(chatStatus([job], job.chatId))}"><i></i>${esc(ctx.statusLabel(job.status))}</span></button></li>`,
      )
      .join('');
    const markup = `${board ? `<section><h2>${esc(tr('קנבן', 'Kanban'))}</h2><div class="design-board">${cell(tr('לביצוע', 'To do'), board.todo)}${cell(tr('בעבודה', 'In progress'), board.working, 'running')}${cell(tr('בסקירה', 'Review'), board.review, 'waiting')}${cell(tr('הושלם', 'Done'), board.done)}</div></section>` : ''}
      <section><h2>${esc(tr('פעילות', 'Activity'))}</h2>${log ? `<ul class="design-log">${log}</ul>` : `<p class="design-empty">${esc(tr('פעולות של בוטים יופיעו כאן.', 'Bot actions appear here.'))}</p>`}</section>
      <section><h2>${esc(tr('משימות בשיחה', 'Tasks in this chat'))}</h2>${jobs ? `<ul class="design-jobs">${jobs}</ul>` : `<p class="design-empty">${esc(tr('עדיין אין משימות בשיחה הזאת.', 'No tasks in this chat yet.'))}</p>`}</section>
      ${bulk ? `<div class="design-pane-actions"><button class="secondary" id="design-bulk" type="button">${esc(bulk === 'pause' ? tr('השהה את כל העבודות', 'Pause all work') : tr('המשך את כל העבודות', 'Resume all work'))}</button></div>` : ''}`;
    if (markup === paneMarkup) return;
    paneMarkup = markup;
    pane.innerHTML = markup;
    pane
      .querySelectorAll('[data-design-chat]')
      .forEach(button => (button.onclick = () => ctx.openChat(button.dataset.designChat)));
    pane
      .querySelectorAll('[data-design-job]')
      .forEach(button => (button.onclick = () => ctx.taskDetails(button.dataset.designJob)));
    const action = $('#design-bulk');
    if (action)
      action.onclick = async () => {
        action.disabled = true;
        try {
          await ctx.api('/api/kanban', { action: 'bulk', control: bulk });
          kanbanAt = 0;
          loadKanban();
        } catch (error) {
          ctx.toast(error.message);
          action.disabled = false;
        }
      };
  }

  return {
    sidebar: markRows,
    render() {
      renderBar();
      serverChip();
      renderTabs();
      if (!$('#design-activity'))
        $('#app').append(
          Object.assign(document.createElement('aside'), {
            id: 'design-activity',
            className: 'design-activity',
          }),
        );
      const pane = $('#design-activity');
      pane.setAttribute('aria-label', tr('פעילות', 'Activity'));
      pane.dir = document.documentElement.dir;
      pane.hidden = ctx.view() !== 'chat' || detailsOpen();
      renderPane();
      loadKanban();
      statusTimer ??= setInterval(serverChip, 1000);
      // The details panel switches its own tabs without a full render.
      if (!tabObserver) {
        tabObserver = new MutationObserver(syncTabs);
        tabObserver.observe($('#details'), { attributes: true, attributeFilter: ['data-tab'] });
      }
    },
    unmount() {
      clearInterval(statusTimer);
      tabObserver?.disconnect();
      $('#design-bar')?.remove();
      $('#design-activity')?.remove();
    },
  };
}
