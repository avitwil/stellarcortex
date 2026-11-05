// Visual designs layered over the base UI. Each design owns a stylesheet scoped
// by html[data-design]; this module adds only what CSS cannot do alone.
export const DESIGNS = [
  {
    id: 'observatory',
    he: 'מצפה כוכבים',
    en: 'Observatory',
    heNote: 'כהה ומעודן, הצוות כקבוצת כוכבים',
    enNote: 'Refined and calm, your team as a constellation',
    swatches: ['#0b1022', '#bda5ff', '#e694e8', '#67dcec'],
    teamTree: true,
    dark: '#0b1022',
    light: '#f6f5fd',
  },
  {
    id: 'daylight',
    he: 'אור יום',
    en: 'Daylight',
    heNote: 'נקי ומקצועי, עם פס ניווט והגדרות בעמוד מלא',
    enNote: 'Clean and professional, with a navigation rail and full-page settings',
    swatches: ['#f4f5fa', '#1e1b4b', '#6d28d9', '#087079'],
    rail: true,
    pageSettings: true,
    dark: '#15162b',
    light: '#f4f5fa',
  },
  {
    id: 'mission',
    he: 'חדר בקרה',
    en: 'Mission control',
    heNote: 'צפוף ומהיר, עם שורת פקודה ופעילות חיה',
    enNote: 'Dense and fast, with a command bar and live activity',
    swatches: ['#14171d', '#5fd4e4', '#b9a2ff', '#e48be6'],
    teamTree: true,
    pageSettings: true,
    mission: true,
    dark: '#14171d',
    light: '#f2f3f6',
  },
];
export const DEFAULT_DESIGN = DESIGNS[0].id;
export const normalizeDesign = value =>
  DESIGNS.some(design => design.id === value) ? value : DEFAULT_DESIGN;
const STORAGE_KEY = 'stellarcortex.design';
const LIVE = ['running', 'waiting', 'queued'];

// waiting outranks running, so a chat that needs the user always says so.
export const chatStatus = (jobs, chatId) => {
  const live = jobs.filter(job => job.chatId === chatId && LIVE.includes(job.status));
  return live.some(job => job.status === 'waiting') ? 'waiting' : live.length ? 'running' : '';
};

// Orders entries depth-first under their managers. An entry whose manager is
// missing, itself, or part of a cycle stays at the top level.
export function orderTeam(entries) {
  const byBot = new Map(entries.filter(entry => entry.botId).map(entry => [entry.botId, entry]));
  const reachesSelf = entry => {
    const seen = new Set([entry]);
    let next = byBot.get(entry.managerId);
    while (next) {
      if (seen.has(next)) return true;
      seen.add(next);
      next = byBot.get(next.managerId);
    }
    return false;
  };
  const parent = entry =>
    byBot.has(entry.managerId) && !reachesSelf(entry) ? byBot.get(entry.managerId) : null;
  const children = new Map();
  for (const entry of entries) {
    const lead = parent(entry);
    if (lead) children.set(lead, [...(children.get(lead) || []), entry]);
  }
  const ordered = [];
  const visit = (entry, depth, last) => {
    const members = children.get(entry) || [];
    ordered.push({ entry, depth, last, lead: members.length > 0 });
    members.forEach((member, index) => visit(member, depth + 1, index === members.length - 1));
  };
  entries.filter(entry => !parent(entry)).forEach(entry => visit(entry, 0, false));
  return ordered;
}

export function designPickerMarkup(selected, { tr, esc }) {
  const current = normalizeDesign(selected);
  return `<fieldset class="design-picker"><legend>${tr('עיצוב', 'Design')}</legend><div class="design-options">${DESIGNS.map(design => `<label class="design-option"><input type="radio" name="design" value="${design.id}" ${design.id === current ? 'checked' : ''}><span class="design-swatches" aria-hidden="true">${design.swatches.map(color => `<i style="background:${color}"></i>`).join('')}</span><strong>${esc(tr(design.he, design.en))}</strong><small>${esc(tr(design.heNote, design.enNote))}</small></label>`).join('')}</div></fieldset>`;
}

export function createDesignHost(ctx) {
  const root = document.documentElement,
    dialog = document.querySelector('#modal');
  const design = () => DESIGNS.find(item => item.id === root.dataset.design) || DESIGNS[0];
  const remembered = () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const remember = id => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
  };
  root.dataset.design = normalizeDesign(remembered());
  let mission = null;
  setTimeout(() => {
    root.dataset.settled = '';
  }, 2500);

  function markRows() {
    const state = ctx.state();
    document.querySelectorAll('#bot-list .bot-row-wrap').forEach(row => {
      const id = row.querySelector('[data-chat]')?.dataset.chat;
      row.dataset.status = chatStatus(state.jobs, id);
      if (!design().rail) return;
      const last = state.messages
        .filter(message => message.chatId === id && message.role !== 'tool')
        .at(-1);
      if (last)
        row
          .querySelector('.bot-name')
          ?.insertAdjacentHTML(
            'beforeend',
            `<time class="design-row-time">${ctx.esc(ctx.relativeTime(last.createdAt))}</time>`,
          );
    });
  }

  function buildRail() {
    const nav = document.querySelector('#navigation'),
      view = ctx.view(),
      page = root.hasAttribute('data-settings-page');
    const button = (id, label, path, active) =>
      `<button class="nav-item ${active ? 'active' : ''}" id="${id}" data-design-rail><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>${ctx.esc(label)}</button>`;
    nav.insertAdjacentHTML(
      'afterbegin',
      button(
        'design-chats',
        ctx.tr('שיחות', 'Chats'),
        'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9.5A1.5 1.5 0 0 1 19 17h-8.5L6 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5Z',
        view === 'chat' && !page,
      ),
    );
    nav.insertAdjacentHTML(
      'beforeend',
      button(
        'design-settings',
        ctx.tr('הגדרות', 'Settings'),
        'M4 6h9M18 6h2M4 12h3M12 12h8M4 18h11M20 18h0M15.5 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM9.5 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM17.5 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z',
        page,
      ),
    );
    if (page)
      nav
        .querySelectorAll('.nav-item.active:not(#design-settings)')
        .forEach(item => item.classList.remove('active'));
    document.querySelector('#design-chats').onclick = () => {
      if (ctx.chatId()) ctx.openChat(ctx.chatId());
    };
    document.querySelector('#design-settings').onclick = () => {
      if (!root.hasAttribute('data-settings-page')) ctx.settings();
    };
    document
      .querySelector('#search')
      .insertAdjacentHTML(
        'beforeend',
        `<span>${ctx.esc(ctx.tr('חיפוש', 'Search'))}</span><kbd>Ctrl K</kbd>`,
      );
  }

  function decorateHeader() {
    const header = document.querySelector('#header'),
      state = ctx.state(),
      chat = state.chats.find(item => item.id === ctx.chatId());
    if (ctx.view() !== 'chat' || !chat) return header.style.removeProperty('--bot');
    const bot = state.bots.find(item => item.id === chat.botIds[0]);
    header.style.setProperty('--bot', ctx.colors[bot?.color] || ctx.colors.violet);
    const status = chatStatus(state.jobs, chat.id);
    if (status)
      header
        .querySelector('.header-title small')
        ?.insertAdjacentHTML(
          'beforeend',
          `<span class="design-status" data-status="${status}">${ctx.esc(status === 'waiting' ? ctx.tr('ממתין לתשובה שלך', 'Needs your attention') : ctx.tr('עובד על המשימה', 'Working on it'))}</span>`,
        );
  }

  function placeTeam() {
    const list = document.querySelector('#bot-list'),
      state = ctx.state();
    const entries = [...list.querySelectorAll(':scope>.bot-row-wrap')].map(row => {
      const chat = state.chats.find(
        item => item.id === row.querySelector('[data-chat]')?.dataset.chat,
      );
      const bot =
        chat?.type === 'direct' ? state.bots.find(item => item.id === chat.botIds[0]) : null;
      return { row, botId: bot?.id, managerId: bot?.managerBotId };
    });
    const ordered = orderTeam(entries);
    if (!ordered.some(item => item.depth)) return;
    ordered.forEach(({ entry, depth, last, lead }, index) => {
      if (depth) ordered[index - 1].entry.row.after(entry.row);
      entry.row.classList.toggle('team-lead', lead);
      entry.row.classList.toggle('team-member', depth > 0);
      entry.row.classList.toggle('team-last', last);
      entry.row.style.setProperty('--team-depth', depth);
    });
    list.querySelectorAll(':scope>.section-label').forEach(label => {
      let count = 0;
      for (
        let next = label.nextElementSibling;
        next?.classList.contains('bot-row-wrap');
        next = next.nextElementSibling
      )
        count++;
      if (!count) label.remove();
      else if (label.querySelector('span')) label.querySelector('span').textContent = count;
    });
  }

  const markRail = () => {
    const page = root.hasAttribute('data-settings-page');
    document.querySelector('#design-settings')?.classList.toggle('active', page);
    document
      .querySelector('#design-chats')
      ?.classList.toggle('active', !page && ctx.view() === 'chat');
    if (!page) return;
    document
      .querySelectorAll('#navigation .nav-item.active:not(#design-settings)')
      .forEach(item => item.classList.remove('active'));
  };

  // Page-style settings must stay non-modal so the navigation remains usable.
  const syncDialog = () => {
    const settings = dialog.open && dialog.dataset.kind === 'settings',
      page = settings && design().pageSettings;
    if (page && dialog.matches(':modal')) {
      dialog.close();
      dialog.show();
    } else if (dialog.open && !page && !dialog.matches(':modal')) {
      dialog.close();
      dialog.showModal();
    }
    const open = dialog.open && !dialog.matches(':modal'),
      changed = open !== root.hasAttribute('data-settings-page');
    root.toggleAttribute('data-settings-page', open);
    if (changed && design().rail && ctx.state()) markRail();
    const main = document.querySelector('.main');
    if (main) main.inert = open;
  };
  new MutationObserver(syncDialog).observe(dialog, {
    attributes: true,
    attributeFilter: ['data-kind', 'open'],
  });
  dialog.addEventListener('close', syncDialog);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && root.hasAttribute('data-settings-page')) dialog.close();
  });
  document.addEventListener(
    'click',
    event => {
      if (
        root.hasAttribute('data-settings-page') &&
        event.target.closest?.('.sidebar,#design-bar') &&
        !event.target.closest('#design-settings')
      )
        dialog.close();
    },
    true,
  );

  return {
    sidebar() {
      if (!ctx.state()) return;
      // The design can change in this same pass, before render() runs.
      root.dataset.design = normalizeDesign(ctx.state().settings.design);
      markRows();
      if (design().teamTree) placeTeam();
      if (design().rail) buildRail();
      if (design().mission) (mission ??= ctx.createMission(ctx)).sidebar();
    },
    render() {
      const state = ctx.state(),
        id = normalizeDesign(state.settings.design);
      root.dataset.design = id;
      root.dataset.view = ctx.view();
      remember(id);
      const current = design(),
        light = document.body.classList.contains('light');
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', light ? current.light : current.dark);
      if (current.rail) decorateHeader();
      else document.querySelector('#header').style.removeProperty('--bot');
      if (current.mission) (mission ??= ctx.createMission(ctx)).render();
      else if (mission) {
        mission.unmount();
        mission = null;
      }
      syncDialog();
    },
  };
}
