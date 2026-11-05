import { routingCandidates, roleForCard, ROLE_NAMES } from './kanban-routing.js';
import { withoutProgramOutput } from './chat-errors.js';
// Interaction reference: NousResearch/hermes-agent @ 6bb377a51d5c8e279a7a5e34d717d653d421d064 (MIT).
// Native implementation; existing workflow/approval/security contracts remain authoritative.
const escape = v =>
  String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const labels = {
  idea: 'Idea',
  specification: 'Brainstorming / specification',
  development: 'Development',
  testing: 'Testing',
  approval: 'Awaiting user approval',
  done: 'Done',
  todo: 'To Do',
  'in-progress': 'In Progress',
};
export function canArchiveCard(data, card) {
  return (
    !data.runs.some(
      r =>
        r.cardId === card.id &&
        ['running', 'pausing', 'stopping', 'uncertain', 'feedback', 'checkpointed'].includes(
          r.status,
        ),
    ) &&
    !(data.engineJobs || []).some(
      j =>
        j.workflowUnit?.cardId === card.id &&
        ['queued', 'deferred', 'running', 'waiting'].includes(j.status),
    ) &&
    !(data.taskSessionJobs || []).some(
      j => j.cardId === card.id && ['queued', 'deferred', 'running', 'waiting'].includes(j.status),
    )
  );
}
const activeRun = run => ['running', 'pausing', 'stopping'].includes(run.status);
export function cardExecution(data, card, bots = []) {
  const scope = card.projectId ? data.projects.find(p => p.id === card.projectId) : data.general;
  const run = data.runs.findLast(r => r.cardId === card.id && r.entryId === card.entryId);
  const target =
    card.stage === 'todo' ? 'in-progress' : card.stage === 'idea' ? 'specification' : card.stage;
  const auto = card.routingMode === 'automatic';
  const assigned = auto
    ? routingCandidates(card, data.projects, bots).candidates.map(b => b.id)
    : card.assignmentMode === 'card' && card.botIds?.length
      ? card.botIds
      : card.projectId
        ? scope?.stages[target]?.botIds?.length
          ? scope.stages[target].botIds
          : card.botIds || []
        : card.botIds || [];
  const lifecycleReady = !scope?.lifecycle || scope.lifecycle === 'active';
  const unresolved = data.runs.some(
    r =>
      r.cardId === card.id &&
      (activeRun(r) || ['uncertain', 'feedback', 'checkpointed'].includes(r.status)),
  );
  const ready =
    !card.archivedAt &&
    data.executionEnabled !== false &&
    !['approval', 'done'].includes(card.stage) &&
    lifecycleReady &&
    (auto || assigned.length > 0) &&
    assigned.every(id => !bots.length || bots.some(b => b.id === id && !b.deletedAt)) &&
    !data.approvals.some(
      a => a.cardId === card.id && a.entryId === card.entryId && a.status === 'pending',
    ) &&
    (!run || run.status === 'checkpointed');
  const blocked =
    scope?.individual || scope?.bulk || scope?.shutdown || scope?.stopped || !lifecycleReady;
  return {
    run,
    ready,
    blocked,
    canRun:
      ready &&
      !blocked &&
      (!auto || !card.autoAuthorization || card.routingNeedsResume || card.requiresUserStart),
    unresolved,
    assigned,
  };
}
export function scopeExecution(data, projectId, bots = []) {
  const scope = projectId ? data.projects.find(p => p.id === projectId) : data.general;
  const cards = data.cards.filter(c => !c.archivedAt && c.projectId === (projectId || null)),
    runs = data.runs.filter(r => r.projectId === (projectId || null));
  const queued = cards.some(
    c =>
      c.routingMode === 'automatic' &&
      c.autoAuthorization &&
      !c.routingNeedsResume &&
      c.stage !== 'done' &&
      !scope?.individual &&
      !scope?.bulk &&
      !scope?.shutdown &&
      !scope?.stopped,
  );
  const active = runs.some(activeRun) || queued,
    uncertain = runs.some(r => r.status === 'uncertain'),
    ready = cards.some(c => cardExecution(data, c, bots).ready),
    resumable = cards.some(c => cardExecution(data, c, bots).run?.status === 'checkpointed');
  const hadRun = runs.length > 0;
  const paused = scope?.individual || scope?.bulk || scope?.shutdown || scope?.stopped;
  const lifecycleReady = !scope?.lifecycle || scope.lifecycle === 'active';
  return {
    scope,
    active,
    uncertain,
    ready,
    resumable,
    showPause: active && !paused && !uncertain,
    showStop: active && !scope?.stopped,
    showResume:
      !active && !uncertain && ready && paused && hadRun && !scope?.bulk && lifecycleReady,
    showStart:
      !active && !uncertain && ready && paused && !hadRun && !scope?.bulk && lifecycleReady,
    showSchedule:
      !active && !uncertain && ready && paused && hadRun && !scope?.bulk && lifecycleReady,
  };
}
export class KanbanPage {
  constructor({ api, toast, tr, modal, openChat = () => {}, isVisible = () => true }) {
    Object.assign(this, { api, toast, tr, modal, openChat, isVisible });
    this.projectId = null;
    this.busy = false;
    this.sequence = 0;
    this.creationDrafts = new Map();
    try {
      this.boardId = globalThis.localStorage?.getItem('stellarcortex.kanban.board') || 'all';
    } catch {
      this.boardId = 'all';
    }
  }
  async mount(el, view, bots) {
    this.el = el;
    this.view = view;
    this.bots = bots;
    if (this.busy) return;
    const seq = ++this.sequence;
    try {
      const data = await this.api('/api/kanban');
      if (seq !== this.sequence || !el.isConnected || !this.isVisible()) return;
      if (
        JSON.stringify(this.data) === JSON.stringify(data) &&
        this.lastRenderView === view &&
        this.lastRenderLocale === this.tr('he', 'en') &&
        el.querySelector('.kb-page')
      )
        return;
      this.data = data;
      this.render();
    } catch (e) {
      this.toast(e.message);
    }
  }
  async action(input) {
    if (this.busy) return;
    this.busy = true;
    ++this.sequence;
    this.el.querySelectorAll('button,input,select,textarea').forEach(b => (b.disabled = true));
    try {
      await this.api('/api/kanban', input);
      this.data = await this.api('/api/kanban');
    } catch (e) {
      this.toast(e.message);
    } finally {
      this.busy = false;
      this.render();
    }
  }
  plainError(text) {
    return withoutProgramOutput(text, (he, en) => this.tr(he, en));
  }
  button(text, attrs = '') {
    return `<button type="button" ${attrs}>${escape(text)}</button>`;
  }
  player(action, label, attrs = '') {
    const paths = { play: 'm8 5 11 7-11 7Z', pause: 'M7 5v14M17 5v14', stop: 'M6 6h12v12H6Z' },
      glyph = ['play', 'resume', 'run', 'resume-all'].includes(action)
        ? 'play'
        : action.startsWith('pause')
          ? 'pause'
          : 'stop';
    return `<button type="button" class="kb-player" ${attrs} aria-label="${escape(label)}" data-tooltip="${escape(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[glyph]}"/></svg></button>`;
  }
  controls(id, p) {
    const state = scopeExecution(this.data, id, this.bots),
      status = {
        playing: this.tr('עבודה מותרת', 'Work enabled'),
        pausing: this.tr('ממתין לנקודת שמירה…', 'Pausing at checkpoint…'),
        stopping: this.tr('מסיים את יחידת העבודה…', 'Stopping after current unit…'),
        paused: this.tr('מושהה', 'Paused'),
        stopped: this.tr('נעצר', 'Stopped'),
        'needs-reconciliation': this.tr('נדרשת בדיקת מצב העבודה', 'Work needs reconciliation'),
      };
    let buttons = '';
    if (state.showStart)
      buttons += this.player(
        'play',
        this.tr('אפשר עבודה', 'Enable work'),
        `data-control="play" data-project="${id || ''}"`,
      );
    else if (state.showResume)
      buttons += this.player(
        'resume',
        this.tr('המשך עבודה', 'Resume work'),
        `data-control="resume" data-project="${id || ''}"`,
      );
    if (state.showPause)
      buttons += this.player(
        'pause',
        this.tr('השהה עבודה', 'Pause work'),
        `data-control="pause" data-project="${id || ''}"`,
      );
    if (state.showStop)
      buttons += this.player(
        'stop',
        this.tr('עצור לאחר היחידה הנוכחית', 'Stop after current unit'),
        `data-control="stop" data-project="${id || ''}"`,
      );
    const scheduling = state.showSchedule
      ? `<label>${this.tr('המשך במועד', 'Resume at')}<input type="datetime-local" data-until="${id || 'general'}" value="${p.until ? new Date(Date.parse(p.until) - new Date(p.until).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}"></label>${this.button(this.tr('שמירת מועד', 'Set resume time'), `data-schedule="${id || 'general'}" data-project="${id || ''}"`)}`
      : '';
    if (!buttons && !scheduling && !state.active && !state.uncertain && !state.resumable) return '';
    return `<div class="kb-actions"><span role="status">${escape(p.bulk && p.control === 'paused' ? this.tr('מושהה דרך השהיית הכול', 'Paused by Pause All') : status[p.control] || p.control || '')}${p.until ? ' · ' + escape(p.until) : ''}</span>${buttons}${scheduling}</div>`;
  }
  bulkControls() {
    const scopes = [null, ...this.data.projects.map(p => p.id)].map(id =>
      scopeExecution(this.data, id, this.bots),
    );
    let controls = '';
    if (scopes.some(s => s.showPause))
      controls += this.player(
        'pause-all',
        this.tr('השהה את כל העבודות', 'Pause all work'),
        'data-bulk="pause"',
      );
    if (
      !scopes.some(s => s.scope.bulk && s.active) &&
      scopes.some(
        s => (s.scope.bulk || s.scope.shutdown) && !s.uncertain && (s.ready || s.resumable),
      )
    )
      controls += this.player(
        'resume-all',
        this.tr('המשך את כל העבודות', 'Resume all work'),
        'data-bulk="resume"',
      );
    return controls ? `<div class="kb-actions">${controls}</div>` : '';
  }
  roleLabel(role) {
    return this.tr(
      {
        research: 'מחקר ואפיון',
        development: 'פיתוח',
        testing: 'בדיקה',
        maintenance: 'תחזוקה',
        coordination: 'תיאום',
        email: 'דואר',
        calendar: 'יומן',
        files: 'קבצים',
        general: 'משימות כלליות',
      }[role] || role,
      ROLE_NAMES[role] || role,
    );
  }
  routingText(c) {
    const s = c.routingStatus;
    if (!s) return this.tr('ממתין להפעלה מפורשת', 'Waiting for explicit start');
    const label = this.roleLabel(s.role || roleForCard(c) || '');
    if (s.status === 'selected')
      return (
        this.tr('נבחר ', 'Selected ') +
        (this.bots.find(b => b.id === s.botId)?.name || '') +
        ' · ' +
        label +
        ' · ' +
        (s.basis?.startsWith('General')
          ? this.tr(
              'בוט כללי כשיר; אין מומחה כשיר',
              'Eligible general-purpose fallback; no eligible specialist',
            )
          : this.tr('לפי תפקיד מוצהר או שיוך שלב', 'Declared role or explicit stage assignment'))
      );
    if (s.status === 'stopped') return this.tr('הניתוב הופסק על ידך', 'Routing stopped by you');
    return (
      {
        busy: this.tr(
          'ממתין שהמומחה המתאים יתפנה; לא ייבחר בוט כללי במקומו.',
          'Waiting for a suitable specialist to become free; no generalist substitution.',
        ),
        resources: this.tr(
          'ממתין למשאבי מעבד וזיכרון פנויים.',
          'Waiting for available CPU and memory.',
        ),
        'missing-type': this.tr(
          'יש לבחור סוג משימה או לשייך בוט ידנית.',
          'Choose a task type or select an agent manually.',
        ),
        'missing-role':
          this.tr(
            'חסר מומחה או בוט כללי בעל יכולת והרשאה מתאימות עבור: ',
            'No eligible specialist or capable generalist for: ',
          ) + label,
        restart: this.tr(
          'נדרש אישור המשך לאחר הפעלה מחדש; לא נשלחה עבודה.',
          'Restart review required; no work was dispatched.',
        ),
      }[s.code] || s.reason
    );
  }
  runLabel(status) {
    return this.tr(
      {
        running: 'עובד',
        pausing: 'ממתין לנקודת שמירה',
        stopping: 'מסיים יחידה לפני עצירה',
        completed: 'יחידת עבודה הושלמה',
        feedback: 'ממתין למשוב',
        uncertain: 'תוצאה דורשת בירור',
        checkpointed: 'נשמר להמשך',
        failed: 'נכשל',
      }[status] || status,
      {
        running: 'Working',
        pausing: 'Pausing at checkpoint',
        stopping: 'Stopping after current unit',
        completed: 'Unit completed',
        feedback: 'Awaiting feedback',
        uncertain: 'Outcome needs review',
        checkpointed: 'Checkpoint saved',
        failed: 'Failed',
      }[status] || status,
    );
  }
  stageLabel(stage) {
    return this.tr(
      {
        idea: 'רעיון',
        specification: 'אפיון',
        development: 'פיתוח',
        testing: 'בדיקה',
        approval: 'ממתין לאישור',
        done: 'הושלם',
        todo: 'לביצוע',
        'in-progress': 'בעבודה',
      }[stage] || stage,
      labels[stage] || stage,
    );
  }
  lane(c) {
    const r = this.data.runs.findLast(r => r.cardId === c.id && r.entryId === c.entryId);
    if (
      (r && ['uncertain', 'feedback', 'checkpointed'].includes(r.status)) ||
      c.admissionError ||
      c.lastProgress?.kind === 'work-failed'
    )
      return 'blocked';
    if (r && activeRun(r)) return 'running';
    if (c.stage === 'done') return 'done';
    if (
      c.stage === 'approval' ||
      this.data.approvals.some(
        a => a.cardId === c.id && a.entryId === c.entryId && a.status === 'pending',
      )
    )
      return 'review';
    if (
      c.routingMode === 'automatic' &&
      c.autoAuthorization &&
      c.routingStatus?.status === 'waiting'
    )
      return ['busy', 'resources'].includes(c.routingStatus.code) ? 'ready' : 'blocked';
    if (
      this.data.projects.find(p => p.id === c.projectId)?.until ||
      (!c.projectId && this.data.general.until)
    )
      return 'scheduled';
    if (['idea', 'specification'].includes(c.stage)) return 'triage';
    return cardExecution(this.data, c, this.bots).canRun ? 'ready' : 'todo';
  }
  laneLabel(lane) {
    return {
      triage: this.tr('אפיון', 'Triage'),
      todo: this.tr('לביצוע', 'To do'),
      ready: this.tr('מוכן', 'Ready'),
      scheduled: this.tr('מתוזמן', 'Scheduled'),
      running: this.tr('בעבודה', 'In progress'),
      review: this.tr('בסקירה', 'Review'),
      blocked: this.tr('חסום', 'Blocked'),
      done: this.tr('הושלם', 'Done'),
    }[lane];
  }
  render() {
    const { el, data } = this;
    if (!data || !el?.isConnected || !this.isVisible()) return;
    this.lastRenderView = this.view;
    this.lastRenderLocale = this.tr('he', 'en');
    if (
      this.boardId &&
      !['all', 'general'].includes(this.boardId) &&
      !data.projects.some(p => p.id === this.boardId)
    )
      this.boardId = 'all';
    const selected = this.boardId ?? 'all',
      p = data.projects.find(p => p.id === selected),
      cards = data.cards.filter(
        c =>
          !!c.archivedAt === !!this.showTrash &&
          (selected === 'all' || c.projectId === (selected === 'general' ? null : selected)) &&
          (!this.search ||
            [c.title, c.initialText].some(t =>
              (t || '').toLocaleLowerCase().includes(this.search.toLocaleLowerCase()),
            )) &&
          (!this.assignee || cardExecution(data, c, this.bots).assigned.includes(this.assignee)),
      );
    this.projectId = p?.id || null;
    el.innerHTML = `<div class="page kb-page kb-unified"><header class="kb-page-heading kb-toolbar"><h1>${this.tr('קנבן', 'Kanban')}</h1><span class="kb-count">${cards.length}</span><select data-board aria-label="${this.tr('לוח', 'Board')}"><option value="all">${this.tr('כל הלוחות', 'All boards')}</option><option value="general">${this.tr('כללי', 'General')}</option>${data.projects.map(p => `<option value="${p.id}">${escape(p.name)}</option>`).join('')}</select><input type="search" data-search aria-label="${this.tr('סינון כרטיסים', 'Filter cards')}" placeholder="${this.tr('סינון כרטיסים…', 'Filter cards…')}" value="${escape(this.search || '')}"><select data-assignee aria-label="${this.tr('אחראי', 'Assignee')}"><option value="">${this.tr('כל האחראים', 'All assignees')}</option>${this.bots
      .filter(b => !b.deletedAt)
      .map(b => `<option value="${b.id}">${escape(b.name)}</option>`)
      .join(
        '',
      )}</select><button type="button" data-trash aria-pressed="${!!this.showTrash}">${this.tr('סל משימות', 'Trash')}</button><button type="button" data-settings aria-label="${this.tr('הגדרות לוח', 'Board settings')}" title="${this.tr('הגדרות לוח', 'Board settings')}">⚙</button><details class="kb-secondary-menu"><summary aria-label="${this.tr('פעולות נוספות', 'More actions')}">⋯</summary><div>${this.button(this.tr('לוח חדש', 'New board'), 'data-new="project"')}</div></details><button type="button" class="kb-create-trigger" data-new="card" ${this.showTrash ? 'hidden' : ''} aria-label="${this.tr('הוספת כרטיס', 'Add card')}" title="${this.tr('הוספת כרטיס', 'Add card')}">+</button></header>${this.showTrash ? `<p role="status">${this.tr('סל משימות — אפשר לשחזר; אין הפעלת עבודה מכאן.', 'Trash — cards can be restored; work cannot run here.')}</p>` : ''}${this.lastArchivedId && !this.showTrash ? `<p role="status">${this.tr('הכרטיס הועבר לסל המשימות.', 'Card moved to Trash.')} ${this.button(this.tr('ביטול הסרה', 'Undo removal'), `data-restore-card="${this.lastArchivedId}"`)}</p>` : ''}<p class="kb-preview-note">${data.executionMode === 'engine' ? this.tr('בוטים קיימים · התחלה באישור מפורש · ניתוב שלבים אוטומטי רק למשימות שבחרת', 'Existing agents · explicit initial start · automatic stage routing only for opted-in tasks') : data.executionEnabled ? this.tr('תצוגת ניסוי · ביצוע מדומה בלבד', 'Experimental preview · simulated execution only') : this.tr('ניהול לוחות · מנוע הביצוע אינו מחובר', 'Board management · execution adapter is disabled')}</p>${this.showTrash ? '' : this.bulkControls()}${this.showTrash || selected === 'all' ? '' : this.controls(p?.id || null, p || data.general)}<div class="${this.showTrash ? 'kb-trash-list' : 'kb-board'}">${
      this.showTrash
        ? cards.length
          ? cards.map(c => this.compactCard(c)).join('')
          : `<p class="muted">${this.tr('סל המשימות ריק', 'Trash is empty')}</p>`
        : ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done']
            .map(lane => {
              const list = cards.filter(c => this.lane(c) === lane),
                collapsed = this.collapsed?.[lane] ?? (cards.length > 0 && !list.length);
              return `<section class="kb-column ${collapsed ? 'kb-collapsed' : ''}" data-lane="${lane}"><header><button type="button" class="kb-lane-toggle" data-toggle-lane="${lane}" aria-expanded="${!collapsed}" aria-label="${escape(this.laneLabel(lane))}">‹</button><h2><span class="kb-lane-dot"></span>${this.laneLabel(lane)}</h2><span class="kb-count">${list.length}</span>${!this.showTrash && ['triage', 'todo', 'ready'].includes(lane) ? `<button type="button" data-add-lane="${lane}" aria-label="${escape(this.tr('הוספה אל ', 'Add to ') + this.laneLabel(lane))}">+</button>` : ''}</header>${list.length ? list.map(c => this.compactCard(c)).join('') : `<p class="kb-empty">${this.tr('אין כרטיסים', 'No cards')}</p>`}</section>`;
            })
            .join('')
    }</div></div>`;
    el.querySelector('[data-board]').value = selected;
    el.querySelector('[data-assignee]').value = this.assignee || '';
    this.bind();
    el.querySelector('[data-board]').onchange = e => {
      this.boardId = e.target.value;
      try {
        localStorage.setItem('stellarcortex.kanban.board', this.boardId);
      } catch {}
      this.render();
    };
    el.querySelector('[data-assignee]').onchange = e => {
      this.assignee = e.target.value;
      this.render();
    };
    el.querySelector('[data-search]').oninput = e => {
      const pos = e.target.selectionStart;
      this.search = e.target.value;
      this.render();
      const input = el.querySelector('[data-search]');
      input.focus();
      try {
        input.setSelectionRange(pos, pos);
      } catch {}
    };
    el.querySelector('[data-trash]').onclick = () => {
      this.showTrash = !this.showTrash;
      this.render();
    };
    el.querySelector('[data-settings]').onclick = () => this.openSettings();
    el.querySelectorAll('[data-add-lane]').forEach(
      b =>
        (b.onclick = () => {
          this.createLane = b.dataset.addLane;
          this.openCreate('card');
        }),
    );
    el.querySelectorAll('[data-toggle-lane]').forEach(
      b =>
        (b.onclick = () => {
          this.collapsed ||= {};
          this.collapsed[b.dataset.toggleLane] = b.getAttribute('aria-expanded') === 'true';
          this.render();
        }),
    );
    el.querySelectorAll('[data-card-detail]').forEach(
      b => (b.onclick = () => this.openCard(b.dataset.cardDetail)),
    );
    if (
      this.detailId &&
      document.querySelector('#modal')?.open &&
      document.querySelector('#modal').dataset.kind === 'kanban-detail'
    )
      this.renderDetail();
  }
  compactCard(c) {
    const run = this.data.runs.findLast(r => r.cardId === c.id),
      project = this.data.projects.find(p => p.id === c.projectId),
      execution = cardExecution(this.data, c, this.bots);
    return `<article class="card kb-card kb-compact" data-card="${c.id}"><button class="kb-card-open" type="button" data-card-detail="${c.id}"><small>${escape(c.id.slice(0, 8))} · ${escape(project?.name || this.tr('כללי', 'General'))}</small><h3 dir="auto">${escape(c.title)}</h3><span class="kb-card-meta">${escape(this.stageLabel(c.stage))}${c.simulated || run?.simulated ? ' · ' + this.tr('הדמיה', 'Simulated') : ''}</span></button><div class="kb-card-footer">${this.removalControl(c)}${!c.archivedAt && c.routingStatus?.status === 'waiting' ? `<span class="kb-routing-status" dir="auto">${escape(this.routingText(c))}</span>` : ''}${execution.canRun ? this.player('run', c.requiresUserStart ? this.tr('הפעל מחדש לאחר בדיקת התוצאה', 'Retry after reviewing outcome') : this.tr('הפעל', 'Run'), `data-run="${c.id}" data-entry-id="${c.entryId}"`) : ''}<span>${!c.archivedAt && run ? escape(this.runLabel(run.status)) : ''}</span></div></article>`;
  }
  openCard(id) {
    if (document.querySelector('#modal').open) return;
    this.detailId = id;
    this.modal(this.tr('פרטי כרטיס', 'Card details'), '');
    const dialog = document.querySelector('#modal');
    dialog.dataset.kind = 'kanban-detail';
    dialog.classList.add('kb-detail-dialog');
    dialog.addEventListener(
      'close',
      () => {
        this.detailId = null;
        dialog.dataset.kind = '';
        dialog.classList.remove('kb-detail-dialog');
        this.el.querySelector(`[data-card-detail="${id}"]`)?.focus();
      },
      { once: true },
    );
    this.renderDetail();
  }
  renderDetail() {
    const c = this.data.cards.find(c => c.id === this.detailId);
    if (!c) return;
    if (c.archivedAt) {
      const body = document.querySelector('#modal-body');
      body.innerHTML = `<h3 dir="auto">${escape(c.title)}</h3><p>${this.tr('הכרטיס נמצא בסל המשימות. הבוט והשיחות נשמרו.', 'This card is in Trash. Its agent and conversations are preserved.')}</p><p dir="auto">${escape(c.initialText)}</p>${this.button(this.tr('שחזור כרטיס', 'Restore card'), `data-restore-card="${c.id}"`)}`;
      this.bindRemoval(body);
      return;
    }
    const body = document.querySelector('#modal-body'),
      open = [...body.querySelectorAll('details[open]')].map(x => x.className).filter(Boolean),
      drafts = [...body.querySelectorAll('textarea,input[name]')].map(x => {
        const f = x.closest('form'),
          attr = f?.getAttributeNames().find(n => n.startsWith('data-'));
        return [attr, f?.getAttribute(attr), x.name, x.value];
      });
    body.innerHTML = `<div class="kb-detail-grid"><div>${this.detailCard(c)}${
      this.data.executionMode === 'engine'
        ? `<section class="kb-agent-results"><h3>${this.tr('הבוט המבצע', 'Executing agent')}</h3><form data-assign-card="${c.id}"><select name="botId" aria-label="${this.tr('בוט לביצוע', 'Executing agent')}"><option value="__auto__" ${c.routingMode === 'automatic' ? 'selected' : ''}>${this.tr('בחירה אוטומטית לפי שלב ותפקיד', 'Automatic selection by stage and role')}</option><option value="" ${c.routingMode !== 'automatic' && !c.botIds?.length ? 'selected' : ''}>${this.tr('לפי שלבי הלוח / בחירה בהמשך', 'Use stage assignments / choose later')}</option>${this.bots
            .filter(b => !b.deletedAt)
            .map(
              b =>
                `<option value="${b.id}" ${c.routingMode !== 'automatic' && c.botIds?.includes(b.id) ? 'selected' : ''}>${escape(b.name)}</option>`,
            )
            .join(
              '',
            )}</select><label>${this.tr('סוג למשימה בודדת', 'Single-task type')}<select name="taskRole"><option value="auto">${this.tr('זיהוי מהתיאור', 'Detect from description')}</option>${Object.entries(
            ROLE_NAMES,
          )
            .map(
              ([role, label]) =>
                `<option value="${role}" ${c.taskRole === role ? 'selected' : ''}>${escape(this.roleLabel(role))}</option>`,
            )
            .join(
              '',
            )}</select></label><button>${this.tr('שמירת שיוך', 'Save assignment')}</button></form>${c.routingMode === 'automatic' ? `<p class="muted">${this.tr('ניתוב לפי תפקיד מוצהר, לא לפי שם הבוט. מומחה קודם; כללי מתאים רק אם אין מומחה זמין מבחינת יכולת והרשאות.', 'Routing uses declared roles, not bot names. Specialists are preferred; eligible generalists are fallback only when no capable specialist exists.')}</p><p dir="auto">${escape(this.routingText(c))}</p>` : ''}${(
            this.data.engineJobs || []
          )
            .filter(j => j.workflowUnit.cardId === c.id)
            .map(
              j =>
                `<details ${['running', 'waiting', 'failed'].includes(j.status) ? 'open' : ''}><summary>${escape(this.bots.find(b => b.id === j.botId)?.name || this.tr('בוט שנמחק', 'Deleted bot'))} · ${escape(this.runLabel(j.status))}</summary>${this.button(this.tr('פתיחת שיחת המשימה', 'Open task session'), `data-workflow-chat="${j.chatId}"`)}<p dir="auto">${escape(j.result || this.plainError(j.error) || this.tr('ממתין לתוצאת הבוט', 'Waiting for the agent result'))}</p>${j.kanbanReceipts?.map(r => `<p dir="ltr">${escape(r.command)} ${escape(JSON.stringify(r.args))} · exit ${escape(r.exitCode)}</p>`).join('') || ''}</details>`,
            )
            .join('')}${(this.data.actionApprovals || [])
            .filter(a =>
              (this.data.engineJobs || []).some(
                j => j.id === a.jobId && j.workflowUnit.cardId === c.id,
              ),
            )
            .map(
              a =>
                `<form class="approval" data-operation="${a.id}"><h4>${this.tr('פעולה דורשת אישור', 'Action needs approval')}</h4><pre dir="auto">${escape(JSON.stringify(a.details, null, 2))}</pre>${a.kind === 'item/tool/requestUserInput' ? `<p class="small">${this.tr('הבוט קורא את התשובה הזו. אל תכתבו כאן סיסמה.', 'The bot reads this answer. Do not type a password here.')}</p>` + (a.details.questions || []).map(q => `<label>${escape(q.question)}<input data-question="${escape(q.id)}"></label>`).join('') : ''}<button type="button" data-operation-answer="true">${this.tr('אישור פעם אחת', 'Allow once')}</button><button type="button" data-operation-answer="false">${this.tr('דחייה', 'Deny')}</button></form>`,
            )
            .join('')}</section>`
        : ''
    }<details class="kb-edit-details"><summary>${this.tr('עריכת כרטיס', 'Edit card')}</summary><form data-edit-card="${c.id}" data-entry-id="${c.entryId}"><label>${this.tr('כותרת', 'Title')}<input name="title" required maxlength="180" value="${escape(c.title)}" dir="auto"></label><label>${this.tr('תיאור', 'Description')}<textarea name="text" maxlength="12000" dir="auto">${escape(c.initialText)}</textarea></label><button>${this.tr('שמירה', 'Save')}</button></form></details><section class="kb-activity"><h3>${this.tr('פעילות', 'Activity')}</h3>${this.data.runs
      .filter(r => r.cardId === c.id)
      .map(
        r =>
          `<details><summary>${escape(this.stageLabel(r.stage))} · ${escape(this.runLabel(r.status))} · ${escape(r.startedAt)}</summary><p dir="auto">${escape(r.checkpoint?.result?.workflow?.evidence || this.plainError(r.error) || this.tr('אין תוצאה מאומתת', 'No verified outcome'))}</p></details>`,
      )
      .join(
        '',
      )}<h3>${this.tr('תגובות', 'Comments')}</h3>${(c.comments || []).map(m => `<article><small>${escape(m.at)}</small><p dir="auto">${escape(m.text)}</p></article>`).join('')}<form data-comment="${c.id}"><label>${this.tr('תגובה חדשה', 'New comment')}<textarea name="text" required maxlength="12000" dir="auto"></textarea></label><button>${this.tr('שליחה', 'Send')}</button></form></section></div><aside><h3>${this.tr('מאפיינים', 'Properties')}</h3><p>${this.tr('לוח', 'Board')}: ${escape(this.data.projects.find(p => p.id === c.projectId)?.name || this.tr('כללי', 'General'))}</p><p>${this.tr('שלב', 'Stage')}: ${escape(this.stageLabel(c.stage))}</p><p>${this.tr('מצב', 'Status')}: ${this.laneLabel(this.lane(c))}</p>${this.controls(c.projectId, c.projectId ? this.data.projects.find(p => p.id === c.projectId) : this.data.general)}</aside></div>`;
    body.querySelectorAll('details').forEach(x => {
      if (open.includes(x.className) || x.classList.contains('kb-card-details')) x.open = true;
    });
    for (const [attr, id, name, value] of drafts) {
      if (!attr) continue;
      const x = body.querySelector(`form[${attr}="${id}"] [name="${name}"]`);
      if (x) x.value = value;
    }
    const prior = this.el;
    this.el = body;
    this.bind();
    this.el = prior;
  }
  openSettings() {
    if (document.querySelector('#modal').open) return;
    const p = this.data.projects.find(p => p.id === this.boardId);
    if (!p) {
      this.modal(
        this.tr('הגדרות לוחות', 'Board settings'),
        `<p>${this.tr('בחר לוח כדי להגדיר צוות ושלבי עבודה. סדר הלוחות קובע עדיפות.', 'Select a board to configure its team and stages. Board order determines priority.')}</p>${this.data.projects.map((p, i) => `<div class="kb-actions"><span>${escape(p.name)}</span>${this.button('↑', `data-reorder="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''}`)}${this.button('↓', `data-reorder="${i}" data-direction="1" ${i === this.data.projects.length - 1 ? 'disabled' : ''}`)}</div>`).join('')}`,
      );
    } else {
      this.modal(
        this.tr('הגדרות לוח', 'Board settings'),
        `<form data-configure><label>${this.tr('מחזור חיים', 'Lifecycle')}<select name="lifecycle">${['active', 'parked', 'completed', 'archived'].map(x => `<option ${p.lifecycle === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label><h3>${this.tr('צוות', 'Team')}</h3>${this.bots
          .filter(b => !b.deletedAt)
          .map(
            b =>
              `<label class="kb-check"><input type="checkbox" name="team" value="${b.id}" ${p.team.includes(b.id) ? 'checked' : ''}>${escape(b.name)}</label>`,
          )
          .join('')}${['specification', 'development', 'testing', 'in-progress']
          .map(
            stage =>
              `<fieldset><legend>${this.stageLabel(stage)}</legend><select name="mode-${stage}">${['manual', 'automatic', 'semi'].map(mode => `<option ${p.stages[stage]?.mode === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select>${this.bots
                .filter(b => !b.deletedAt)
                .map(
                  b =>
                    `<label class="kb-check"><input type="checkbox" name="bots-${stage}" value="${b.id}" ${p.stages[stage]?.botIds.includes(b.id) ? 'checked' : ''}>${escape(b.name)}</label>`,
                )
                .join('')}</fieldset>`,
          )
          .join(
            '',
          )}<button>${this.tr('שמירה', 'Save')}</button></form><h3>${this.tr('דיונים', 'Discussions')}</h3>${this.data.sessions
          .filter(s => s.projectId === p.id)
          .map(
            s =>
              `<details><summary>${escape(s.name)}</summary>${s.messages.map(m => `<p dir="auto">${escape(m.text)}</p>`).join('')}<form data-discuss="${s.id}"><textarea name="text" required aria-label="${this.tr('הודעה', 'Message')}"></textarea><button>${this.tr('הוספה', 'Add')}</button></form></details>`,
          )
          .join(
            '',
          )}<form data-create="session"><label>${this.tr('דיון חדש', 'New discussion')}<input name="name" required></label><button>+</button></form>`,
      );
    }
    const prior = this.el;
    this.el = document.querySelector('#modal-body');
    this.bind();
    this.el = prior;
  }
  openCreate(kind) {
    const dialog = document.querySelector('#modal');
    if (dialog.open || this.creationPending) return;
    const projectId =
        this.projectId || (this.createLane === 'triage' ? this.data.projects[0]?.id : null),
      key = kind === 'project' ? 'project' : `card:${projectId || 'general'}`;
    const draft = this.creationDrafts.get(key) || {},
      title =
        kind === 'project' ? this.tr('לוח חדש', 'New board') : this.tr('הוספת כרטיס', 'Add card');
    const field =
      kind === 'project'
        ? `<label for="kb-create-name">${this.tr('שם הלוח', 'Board name')}</label><input id="kb-create-name" name="name" required maxlength="120" autocomplete="off" dir="auto" autofocus placeholder="${escape(this.tr('שם הלוח', 'Board name'))}"><p class="muted kb-create-hint">${this.tr('אפשר להגדיר צוות ושלבי עבודה בהגדרות הלוח.', 'Configure the team and stages in board settings.')}</p>`
        : `<label for="kb-create-title">${this.tr('כותרת', 'Title')}</label><input id="kb-create-title" name="title" required maxlength="180" dir="auto" autofocus><label for="kb-create-details">${this.tr('פרטים (לא חובה)', 'Details (optional)')}</label><textarea id="kb-create-details" name="text" maxlength="12000" dir="auto"></textarea><label for="kb-create-board">${this.tr('לוח', 'Board')}</label><select id="kb-create-board" name="projectId"><option value="">${this.tr('כללי', 'General')}</option>${this.data.projects.map(p => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select><label for="kb-create-kind">${this.tr('מסלול עבודה', 'Workflow')}</label><select id="kb-create-kind" name="kind"><option value="task">${this.tr('ביצוע משימה', 'Task execution')}</option><option value="idea" ${this.createLane === 'triage' ? 'selected' : ''}>${this.tr('אפיון ואז פיתוח באישור', 'Specify, then approve development')}</option></select><label for="kb-create-bot">${this.tr('בוט לביצוע הכרטיס', 'Agent for this card')}</label><select id="kb-create-bot" name="botIds"><option value="__auto__">${this.tr('בחירה אוטומטית לפי שלב ותפקיד', 'Automatic selection by stage and role')}</option><option value="" ${projectId || !this.bots.some(b => !b.deletedAt) ? 'selected' : ''}>${this.tr('לפי הגדרות שלבי הלוח / בחירה בהמשך', 'Use stage assignments / choose later')}</option>${this.bots
            .filter(b => !b.deletedAt)
            .map(
              b =>
                `<option value="${b.id}" ${!projectId && b.id === this.bots.find(b => !b.deletedAt)?.id ? 'selected' : ''}>${escape(b.name)}</option>`,
            )
            .join(
              '',
            )}</select><div data-auto-options hidden><label>${this.tr('סוג משימה בודדת (או זיהוי מהתיאור)', 'Single-task type (or detect from description)')}<select name="taskRole"><option value="auto">${this.tr('זיהוי מהתיאור', 'Detect from description')}</option>${Object.entries(
            ROLE_NAMES,
          )
            .map(
              ([role, label]) => `<option value="${role}">${escape(this.roleLabel(role))}</option>`,
            )
            .join(
              '',
            )}</select></label><p class="muted">${this.tr('מומחה מתאים קודם; אם אין, בוט כללי בעל היכולת הקיימת. מומחה עסוק גורם להמתנה. למחקר ואז פיתוח בחר מסלול אפיון ופיתוח. חסר תפקיד או הרשאה? המשימה תיחסם לתשובתך.', 'A suitable specialist is preferred; otherwise an eligible general-purpose agent. Busy specialists cause waiting. For research then development, choose the specification/development workflow. Missing roles or permissions block for your input.')}</p></div>`;
    this.modal(
      title,
      `<form id="kb-create-form">${field}<p id="kb-create-error" role="alert" hidden></p><div class="kb-create-actions"><button type="button" class="secondary" data-create-cancel>${this.tr('ביטול', 'Cancel')}</button><button type="submit" class="primary">${escape(title)}</button></div></form>`,
    );
    dialog.classList.add('kb-create-dialog');
    dialog.dataset.kind = 'kanban-create';
    dialog.setAttribute('aria-labelledby', 'modal-title');
    const form = dialog.querySelector('#kb-create-form'),
      name = form.elements.namedItem(kind === 'project' ? 'name' : 'title'),
      close = document.querySelector('#modal-close');
    for (const [field, value] of Object.entries(draft)) {
      const input = form.elements.namedItem(field);
      if (input) input.value = value;
    }
    const boardField = form.elements.namedItem('projectId'),
      kindField = form.elements.namedItem('kind');
    if (boardField && kindField) {
      const sync = () => {
        kindField.options[1].disabled = false;
      };
      sync();
      boardField.addEventListener('change', sync);
    }
    let succeeded = false;
    const remember = () => this.creationDrafts.set(key, Object.fromEntries(new FormData(form)));
    form.oninput = () => {
      name.setCustomValidity('');
      remember();
    };
    form.onchange = remember;
    form.querySelector('[data-create-cancel]').onclick = () => dialog.close();
    const preventPending = e => {
      if (this.creationPending) e.preventDefault();
    };
    dialog.addEventListener('cancel', preventPending);
    dialog.addEventListener(
      'close',
      () => {
        if (!succeeded) remember();
        dialog.classList.remove('kb-create-dialog');
        dialog.dataset.kind = '';
        dialog.removeEventListener('cancel', preventPending);
        close.disabled = false;
        this.el?.querySelector(`[data-new="${kind}"]`)?.focus();
      },
      { once: true },
    );
    const botField = form.elements.namedItem('botIds');
    if (botField) {
      const show = () => {
        form.querySelector('[data-auto-options]').hidden = botField.value !== '__auto__';
      };
      show();
      botField.addEventListener('change', show);
    }
    name.focus();
    form.onsubmit = async event => {
      event.preventDefault();
      if (this.creationPending || this.busy) return;
      if (!name.value.trim()) {
        name.setCustomValidity(this.tr('יש להזין שם או כותרת.', 'Enter a name or title.'));
        name.reportValidity();
        name.focus();
        return;
      }
      remember();
      const values = Object.fromEntries(new FormData(form)),
        payload = {
          action: kind,
          projectId,
          ...values,
          projectId: kind === 'project' ? null : values.projectId || null,
          routingMode: values.botIds === '__auto__' ? 'automatic' : 'manual',
          botIds: new FormData(form).getAll('botIds').filter(v => v && v !== '__auto__'),
        };
      this.creationPending = true;
      const error = form.querySelector('#kb-create-error');
      error.hidden = true;
      form.querySelectorAll('button,input,textarea,select').forEach(el => (el.disabled = true));
      close.disabled = true;
      try {
        const reply = await this.api('/api/kanban', payload);
        if (reply.result) {
          const list = kind === 'project' ? this.data.projects : this.data.cards;
          if (!list.some(item => item.id === reply.result.id)) list.push(reply.result);
        }
        succeeded = true;
        this.showTrash = false;
        this.creationDrafts.delete(key);
        if (kind === 'project') {
          this.boardId = reply.result.id;
          this.projectId = reply.result.id;
        }
        this.createLane = null;
        dialog.close();
        try {
          this.data = await this.api('/api/kanban');
        } catch (refreshError) {
          this.toast(refreshError.message);
        }
        this.render();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        this.creationPending = false;
        close.disabled = false;
        if (dialog.open) {
          form
            .querySelectorAll('button,input,textarea,select')
            .forEach(el => (el.disabled = false));
          name.focus();
        }
      }
    };
  }
  detailCard(c) {
    const execution = cardExecution(this.data, c, this.bots),
      run = this.data.runs.findLast(r => r.cardId === c.id),
      a = this.data.approvals.find(
        a => a.cardId === c.id && a.entryId === c.entryId && a.status === 'pending',
      );
    const next =
      c.kind === 'idea'
        ? {
            idea: ['specification'],
            development: ['testing'],
            testing: ['development', 'approval'],
          }
        : { todo: ['in-progress'], 'in-progress': ['approval'] };
    const simulation = c.simulated || run?.simulated || run?.checkpoint?.result?.synthetic;
    const state = {
      running: this.tr('עובד', 'Working'),
      completed: this.tr('יחידת עבודה הושלמה', 'Unit completed'),
      feedback: this.tr('ממתין למשוב', 'Awaiting feedback'),
      uncertain: this.tr('נדרש בירור תוצאה', 'Outcome needs review'),
      checkpointed: this.tr('נשמר להמשך', 'Checkpoint saved'),
    };
    const startLabel =
      c.routingMode === 'automatic'
        ? c.routingNeedsResume
          ? this.tr('המשך ניתוב לאחר בדיקת ההפעלה מחדש', 'Resume routing after restart review')
          : this.tr('התחל משימה עם ניתוב אוטומטי', 'Start task with automatic routing')
        : c.requiresUserStart
          ? this.tr('הפעל מחדש לאחר בדיקת התוצאה', 'Retry after reviewing outcome')
          : c.stage === 'idea' || c.stage === 'specification'
            ? this.tr('התחל אפיון', 'Start brainstorming')
            : c.stage === 'development'
              ? this.tr('התחל פיתוח', 'Start development')
              : c.stage === 'testing'
                ? this.tr('התחל בדיקה', 'Run validation')
                : this.tr('התחל משימה', 'Run task');
    const secondary =
      (execution.unresolved ? [] : next[c.stage] || [])
        .map(stage =>
          this.button(
            this.tr('העבר ידנית: ', 'Move manually: ') + this.stageLabel(stage),
            `data-move="${c.id}" data-stage="${stage}"`,
          ),
        )
        .join('') +
      (c.stage === 'specification' && !execution.unresolved && !a
        ? this.button(
            this.tr('בקשת אישור לפיתוח', 'Request development approval'),
            `data-development="${c.id}"`,
          )
        : '');
    return `<article class="card kb-card"><div class="kb-card-heading"><h4 dir="auto">${escape(c.title)}</h4>${secondary || !c.archivedAt ? `<details class="kb-secondary-menu"><summary aria-label="${this.tr('פעולות נוספות', 'More actions')}" title="${this.tr('פעולות נוספות', 'More actions')}">⋯</summary><div>${secondary}${this.archiveButton(c)}</div></details>` : ''}</div>
      ${simulation ? `<span class="kb-simulation">${this.tr('התקדמות מדומה בלבד', 'Simulated progress only')}</span>` : ''}
      ${run ? `<p role="status">${escape(state[run.status] || run.status)} ${escape(this.plainError(run.error) || '')}</p>` : ''}
      ${c.lastProgress?.kind !== 'started' && c.lastProgress?.evidence ? `<p class="kb-progress-note" dir="auto">${escape(c.lastProgress.evidence)}</p>` : ''}
      ${c.admissionError ? `<p>${escape(this.plainError(c.admissionError))}</p>` : ''}
      <div class="kb-actions">${execution.canRun ? this.player('run', startLabel, `data-run="${c.id}" data-entry-id="${c.entryId}"`) : ''}${a ? this.button(a.kind === 'development' ? this.tr('אישור תחילת פיתוח', 'Approve development') : this.tr('אישור השלמה', 'Approve completion'), `data-decision="${a.id}" data-accept="true"`) + this.button(this.tr('דחייה', 'Reject'), `data-decision="${a.id}" data-accept="false"`) : ''}</div>
      <details class="kb-card-details" data-retain-detail="card-${c.id}"><summary>${this.tr('פרטים', 'Details')}</summary><p dir="auto">${escape(c.initialText)}</p>${c.lastReview?.feedback ? `<p dir="auto">${escape(c.lastReview.feedback)}</p>` : ''}${run?.checkpoint ? `<details><summary>${this.tr('נתוני שחזור', 'Recovery data')}</summary><pre dir="ltr">${escape(JSON.stringify(run.checkpoint, null, 2))}</pre></details>` : ''}</details>
      ${run?.status === 'feedback' ? `<form data-feedback="${c.id}"><label>Feedback <textarea name="text" required></textarea></label><label class="kb-check"><input name="continueWork" type="checkbox">Request another preparation round</label><button>Submit feedback</button></form>` : ''}
      ${['uncertain', 'checkpointed'].includes(run?.status) ? `<form data-reconcile="${run.id}"><label>Review of actual effects <textarea name="checkpoint" required></textarea></label>${run.status === 'uncertain' ? '<label><input type="checkbox" name="retry">Authorize reviewed continuation</label>' : '<p>Reconcile to abandon remaining units; Resume / Run continues them.</p>'}<button>Reconcile</button></form>` : ''}</article>`;
  }
  archiveButton(c) {
    return this.button(
      this.tr('הסרת כרטיס', 'Remove card'),
      `data-archive-card="${c.id}" ${canArchiveCard(this.data, c) ? '' : `disabled title="${this.tr('יש לעצור וליישב את העבודה הנוכחית לפני הסרה', 'Stop and reconcile current work before removing')}"`}`,
    );
  }
  removalControl(c) {
    return c.archivedAt
      ? this.button(this.tr('שחזור', 'Restore'), `data-restore-card="${c.id}"`)
      : `<details class="kb-secondary-menu"><summary aria-label="${this.tr('פעולות כרטיס', 'Card actions')}">⋯</summary><div>${this.archiveButton(c)}</div></details>`;
  }
  bindRemoval(el) {
    el.querySelectorAll('[data-archive-card]').forEach(
      b =>
        (b.onclick = async () => {
          if (this.busy) return;
          const id = b.dataset.archiveCard;
          if (
            !confirm(
              this.tr(
                'להעביר את הכרטיס לסל המשימות? ניתן לשחזר אותו. הבוט והשיחות לא יימחקו.',
                'Move this card to Trash? You can restore it. Its agent and conversations will not be deleted.',
              ),
            )
          )
            return;
          await this.action({ action: 'archive-card', cardId: id });
          if (this.data.cards.find(c => c.id === id)?.archivedAt) {
            this.lastArchivedId = id;
            if (document.querySelector('#modal').open) document.querySelector('#modal').close();
            this.render();
          }
        }),
    );
    el.querySelectorAll('[data-restore-card]').forEach(
      b =>
        (b.onclick = async () => {
          if (this.busy) return;
          await this.action({ action: 'restore-card', cardId: b.dataset.restoreCard });
          if (!this.data.cards.find(c => c.id === b.dataset.restoreCard)?.archivedAt) {
            if (this.lastArchivedId === b.dataset.restoreCard) this.lastArchivedId = null;
            this.showTrash = false;
            if (document.querySelector('#modal').open) document.querySelector('#modal').close();
          }
          this.render();
        }),
    );
    el.querySelectorAll('[data-workflow-chat]').forEach(
      b =>
        (b.onclick = () => {
          document.querySelector('#modal').close();
          this.openChat(b.dataset.workflowChat);
        }),
    );
  }
  bind() {
    const el = this.el;
    this.bindRemoval(el);
    el.querySelectorAll('[data-assign-card]').forEach(
      f =>
        (f.onsubmit = e => {
          e.preventDefault();
          this.action({
            action: 'assign-card',
            cardId: f.dataset.assignCard,
            routingMode: f.elements.botId.value === '__auto__' ? 'automatic' : 'manual',
            taskRole: f.elements.taskRole.value,
            botIds:
              f.elements.botId.value && f.elements.botId.value !== '__auto__'
                ? [f.elements.botId.value]
                : [],
          });
        }),
    );
    el.querySelectorAll('[data-operation-answer]').forEach(
      b =>
        (b.onclick = async () => {
          if (this.busy) return;
          const f = b.closest('[data-operation]'),
            answers = {};
          f.querySelectorAll('[data-question]').forEach(
            i => (answers[i.dataset.question] = { answers: [i.value] }),
          );
          this.busy = true;
          f.querySelectorAll('button').forEach(b => (b.disabled = true));
          try {
            await this.api('/api/approvals/' + f.dataset.operation, {
              approve: b.dataset.operationAnswer === 'true',
              answers,
            });
            this.data = await this.api('/api/kanban');
          } catch (e) {
            this.toast(e.message);
          } finally {
            this.busy = false;
            this.render();
          }
        }),
    );

    el.querySelectorAll('[data-edit-card]').forEach(
      f =>
        (f.onsubmit = e => {
          e.preventDefault();
          this.action({
            action: 'edit-card',
            cardId: f.dataset.editCard,
            entryId: f.dataset.entryId,
            ...Object.fromEntries(new FormData(f)),
          });
        }),
    );
    el.querySelectorAll('[data-comment]').forEach(
      f =>
        (f.onsubmit = async e => {
          e.preventDefault();
          if (this.busy) return;
          f.dataset.requestId ||=
            crypto.randomUUID?.() ||
            Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
          const text = f.elements.text.value;
          await this.action({
            action: 'comment',
            cardId: f.dataset.comment,
            requestId: f.dataset.requestId,
            text,
          });
          const fresh = document.querySelector('[data-comment]');
          if (
            fresh &&
            this.data.cards
              .find(c => c.id === f.dataset.comment)
              ?.comments?.some(m => m.requestId === f.dataset.requestId)
          )
            fresh.elements.text.value = '';
        }),
    );
    el.querySelectorAll('[data-new]').forEach(
      b => (b.onclick = () => this.openCreate(b.dataset.new)),
    );
    el.querySelector('[data-create="session"]')?.addEventListener('submit', e => {
      e.preventDefault();
      this.action({
        action: 'session',
        projectId: this.projectId,
        ...Object.fromEntries(new FormData(e.target)),
      });
    });
    el.querySelectorAll('[data-open]').forEach(
      b =>
        (b.onclick = () => {
          this.projectId = b.dataset.open;
          this.render();
        }),
    );
    el.querySelector('[data-back]')?.addEventListener('click', () => {
      this.projectId = null;
      this.render();
    });
    el.querySelectorAll('[data-control]').forEach(
      b =>
        (b.onclick = () => {
          const date =
            el.querySelector(`[data-until="${b.dataset.project || 'general'}"]`)?.value || '';
          this.action({
            action: 'control',
            projectId: b.dataset.project || null,
            control: b.dataset.control,
            until: b.dataset.control === 'pause' && date ? new Date(date).toISOString() : null,
          });
        }),
    );
    el.querySelectorAll('[data-schedule]').forEach(
      b =>
        (b.onclick = () => {
          const input = el.querySelector(`[data-until="${b.dataset.schedule}"]`);
          if (!input.value) {
            input.focus();
            return;
          }
          this.action({
            action: 'control',
            projectId: b.dataset.project || null,
            control: 'pause',
            until: new Date(input.value).toISOString(),
          });
        }),
    );
    el.querySelectorAll('[data-bulk]').forEach(
      b => (b.onclick = () => this.action({ action: 'bulk', control: b.dataset.bulk })),
    );
    el.querySelectorAll('[data-move]').forEach(
      b =>
        (b.onclick = () =>
          this.action({ action: 'move', cardId: b.dataset.move, stage: b.dataset.stage })),
    );
    el.querySelectorAll('[data-development]').forEach(
      b =>
        (b.onclick = () => this.action({ action: 'development', cardId: b.dataset.development })),
    );
    el.querySelectorAll('[data-run]').forEach(
      b =>
        (b.onclick = () =>
          this.action({ action: 'run', cardId: b.dataset.run, entryId: b.dataset.entryId })),
    );
    el.querySelectorAll('[data-decision]').forEach(
      b =>
        (b.onclick = () =>
          this.action({
            action: 'decide',
            approvalId: b.dataset.decision,
            accept: b.dataset.accept === 'true',
          })),
    );
    el.querySelectorAll('[data-feedback],[data-reconcile],[data-discuss]').forEach(
      f =>
        (f.onsubmit = e => {
          e.preventDefault();
          const input = Object.fromEntries(new FormData(f));
          this.action(
            f.dataset.feedback
              ? {
                  action: 'feedback',
                  cardId: f.dataset.feedback,
                  ...input,
                  continueWork: input.continueWork === 'on',
                }
              : f.dataset.discuss
                ? { action: 'discuss', sessionId: f.dataset.discuss, ...input }
                : {
                    action: 'reconcile',
                    runId: f.dataset.reconcile,
                    ...input,
                    retry: input.retry === 'on',
                  },
          );
        }),
    );
    el.querySelector('[data-configure]')?.addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target),
        stages = {};
      for (const stage of ['specification', 'development', 'testing', 'in-progress'])
        stages[stage] = { mode: f.get('mode-' + stage), botIds: f.getAll('bots-' + stage) };
      this.action({
        action: 'configure',
        projectId: this.projectId,
        team: f.getAll('team'),
        lifecycle: f.get('lifecycle'),
        stages,
      });
      document.querySelector('#modal').close();
    });
    const reorder = (from, to) => {
      if (from < 0 || from === to || to < 0 || to >= this.data.projects.length) return;
      const ids = this.data.projects.map(p => p.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      this.action({ action: 'reorder', ids });
    };
    el.querySelectorAll('[data-reorder]').forEach(
      b =>
        (b.onclick = () =>
          reorder(
            Number(b.dataset.reorder),
            Number(b.dataset.reorder) + Number(b.dataset.direction),
          )),
    );
    el.querySelectorAll('[data-project-row]').forEach(row => {
      row.ondragstart = e => e.dataTransfer.setData('text/plain', row.dataset.projectRow);
      row.ondragover = e => e.preventDefault();
      row.ondrop = e => {
        e.preventDefault();
        reorder(
          this.data.projects.findIndex(p => p.id === e.dataTransfer.getData('text/plain')),
          this.data.projects.findIndex(p => p.id === row.dataset.projectRow),
        );
      };
    });
  }
}
