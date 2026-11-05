import { routingCandidates, ROLE_NAMES } from '../public/kanban-routing.js';
import { createHostResourceSampler } from './kanban-resources.mjs';
import { id, now, required } from './store.mjs';
export const TASK_STAGES = ['todo', 'in-progress', 'approval', 'done'];
export const IDEA_STAGES = ['idea', 'specification', 'development', 'testing', 'approval', 'done'];
const active = r => ['running', 'pausing', 'stopping'].includes(r.status);
const reservesResources = r => active(r) || r.status === 'uncertain';
const modes = ['manual', 'automatic', 'semi'];
export const workingStage = card =>
  card.stage === 'todo' ? 'in-progress' : card.stage === 'idea' ? 'specification' : card.stage;
export class Kanban {
  constructor(store, { executor = null, resources = createHostResourceSampler() } = {}) {
    this.store = store;
    this.executor = executor;
    this.resources = resources;
    this.pending = new Map();
    this.closed = false;
    this.data = store.data.kanban ??= {
      projects: [],
      cards: [],
      sessions: [],
      runs: [],
      approvals: [],
      general: { individual: false, bulk: false, until: null },
    };
    for (const run of this.data.runs)
      if (active(run)) {
        run.status = 'uncertain';
        run.error = 'Restart: reconcile effects before resuming';
      }
    for (const c of this.data.cards)
      if (c.routingMode === 'automatic' && c.autoAuthorization) {
        c.routingNeedsResume = true;
        c.routingStatus = {
          status: 'waiting',
          code: 'restart',
          reason: 'Resume this automatic task after reviewing restart state',
          entryId: c.entryId,
        };
      }
    for (const p of [this.data.general, ...this.data.projects]) this.settle(p);
    this.save();
  }
  save() {
    this.store.save();
  }
  project(value) {
    const p = this.data.projects.find(p => p.id === value);
    if (!p) throw Error('Project not found');
    return p;
  }
  card(value) {
    const c = this.data.cards.find(c => c.id === value);
    if (!c) throw Error('Card not found');
    if (c.archivedAt) throw Error('Restore this card from Trash before changing or running it');
    return c;
  }
  scope(value) {
    return value ? this.project(value) : this.data.general;
  }
  blocked(p) {
    return (
      p.individual || p.bulk || p.shutdown || p.stopped || (p.lifecycle && p.lifecycle !== 'active')
    );
  }
  settle(p) {
    if (this.data.runs.some(r => r.status === 'uncertain' && r.projectId === (p.id || null))) {
      p.control = 'needs-reconciliation';
      return;
    }
    const running = this.data.runs.some(r => active(r) && r.projectId === (p.id || null));
    p.control = running
      ? p.stopped
        ? 'stopping'
        : p.individual || p.bulk || p.shutdown
          ? 'pausing'
          : 'playing'
      : p.stopped
        ? 'stopped'
        : p.individual || p.bulk || p.shutdown
          ? 'paused'
          : 'playing';
  }
  createProject(input) {
    const p = {
      id: id(),
      name: required(input.name, 'Project name', 120),
      lifecycle: 'active',
      team: [],
      teamExplicit: false,
      stages: {},
      individual: true,
      bulk: false,
      stopped: false,
      until: null,
      control: 'paused',
      createdAt: now(),
    };
    this.data.projects.push(p);
    this.save();
    return p;
  }
  configure(projectId, input) {
    const current = this.project(projectId),
      p = structuredClone(current);
    if (input.lifecycle !== undefined) {
      if (!['active', 'parked', 'completed', 'archived'].includes(input.lifecycle))
        throw Error('Invalid project lifecycle');
      p.lifecycle = input.lifecycle;
    }
    if (input.team !== undefined) {
      if (
        !Array.isArray(input.team) ||
        new Set(input.team).size !== input.team.length ||
        input.team.some(b => !this.store.data.bots.some(x => x.id === b && !x.deletedAt))
      )
        throw Error('Choose existing unique bots');
      p.team = [...input.team];
      p.teamExplicit = true;
    }
    if (input.stages !== undefined) {
      const stages = {};
      for (const [stage, config] of Object.entries(input.stages)) {
        if (
          ![...IDEA_STAGES, ...TASK_STAGES].includes(stage) ||
          !modes.includes(config.mode) ||
          !Array.isArray(config.botIds) ||
          config.botIds.some(b => !p.team.includes(b)) ||
          new Set(config.botIds).size !== config.botIds.length
        )
          throw Error('Invalid stage configuration');
        stages[stage] = { mode: config.mode, botIds: [...config.botIds] };
      }
      p.stages = stages;
    }
    if (Object.values(p.stages).some(config => config.botIds.some(b => !p.team.includes(b))))
      throw Error('Stage assignments must belong to the project team');
    Object.assign(current, p);
    this.settle(current);
    this.save();
    return current;
  }
  reorder(ids) {
    if (
      !Array.isArray(ids) ||
      ids.length !== this.data.projects.length ||
      new Set(ids).size !== ids.length ||
      ids.some(x => !this.data.projects.some(p => p.id === x))
    )
      throw Error('Supply each project once');
    this.data.projects = ids.map(x => this.project(x));
    this.save();
  }
  createCard(input) {
    const projectId = input.projectId || null;
    if (projectId) this.project(projectId);
    const kind = input.kind === 'idea' ? 'idea' : 'task';
    const c = {
      id: id(),
      projectId,
      kind,
      title: required(input.title, 'Title', 180),
      botIds: Array.isArray(input.botIds)
        ? input.botIds.filter(b => this.store.data.bots.some(x => x.id === b && !x.deletedAt))
        : [],
      routingMode: input.routingMode === 'automatic' ? 'automatic' : 'manual',
      taskRole: Object.hasOwn(ROLE_NAMES, input.taskRole) ? input.taskRole : 'auto',
      assignmentMode: input.botIds?.length ? 'card' : 'stage',
      initialText: String(input.text || '').slice(0, 12000),
      stage: kind === 'idea' ? 'idea' : 'todo',
      entryId: id(),
      createdAt: now(),
      feedback: null,
    };
    if (projectId && c.botIds.length) {
      const p = this.project(projectId);
      p.team = [...new Set([...p.team, ...c.botIds])];
    }
    this.data.cards.push(c);
    this.save();
    return c;
  }
  archiveCard(cardId) {
    const c = this.data.cards.find(c => c.id === cardId);
    if (!c) throw Error('Card not found');
    if (c.archivedAt) return c;
    if (
      this.data.runs.some(
        r =>
          r.cardId === cardId &&
          (active(r) || ['uncertain', 'checkpointed', 'feedback'].includes(r.status)),
      ) ||
      this.store.data.jobs.some(
        j =>
          (j.workflowUnit?.cardId === cardId ||
            this.store.data.chats.some(
              chat => chat.id === j.chatId && chat.kanbanCardId === cardId,
            )) &&
          ['queued', 'deferred', 'running', 'waiting'].includes(j.status),
      )
    )
      throw Error('Stop and reconcile current work before removing the card');
    const authorization = c.autoAuthorization;
    c.archivedAt = now();
    delete c.autoAuthorization;
    try {
      this.save();
    } catch (error) {
      delete c.archivedAt;
      if (authorization) c.autoAuthorization = authorization;
      throw error;
    }
    return c;
  }
  restoreCard(cardId) {
    const c = this.data.cards.find(c => c.id === cardId);
    if (!c) throw Error('Card not found');
    if (!c.archivedAt) return c;
    const at = c.archivedAt,
      previous = c.requiresUserStart;
    delete c.archivedAt;
    c.requiresUserStart = true;
    try {
      this.save();
    } catch (error) {
      c.archivedAt = at;
      if (previous === undefined) delete c.requiresUserStart;
      else c.requiresUserStart = previous;
      throw error;
    }
    return c;
  }
  assignCard(cardId, botIds, { routingMode = 'manual', taskRole = 'auto' } = {}) {
    if (
      !['manual', 'automatic'].includes(routingMode) ||
      (taskRole !== 'auto' && !Object.hasOwn(ROLE_NAMES, taskRole))
    )
      throw Error('Invalid routing choice');
    const c = this.card(cardId);
    if (
      !Array.isArray(botIds) ||
      new Set(botIds).size !== botIds.length ||
      botIds.some(id => !this.store.data.bots.some(b => b.id === id && !b.deletedAt))
    )
      throw Error('Select existing bots');
    if (
      this.data.runs.some(
        r =>
          r.cardId === cardId &&
          (active(r) || ['uncertain', 'checkpointed', 'feedback'].includes(r.status)),
      )
    )
      throw Error('Finish or reconcile current work before changing assignment');
    c.routingMode = routingMode;
    c.taskRole = taskRole;
    delete c.autoAuthorization;
    delete c.routingNeedsResume;
    delete c.routingStatus;
    c.botIds = [...botIds];
    c.assignmentMode = botIds.length ? 'card' : 'stage';
    if (c.projectId) {
      const p = this.project(c.projectId);
      p.team = [...new Set([...p.team, ...botIds])];
    }
    this.save();
    return c;
  }
  editCard(cardId, input) {
    const c = this.card(cardId);
    if (input.entryId !== c.entryId) throw Error('Card changed; reload before editing');
    if (
      this.data.runs.some(
        r =>
          r.cardId === cardId &&
          (active(r) || ['uncertain', 'feedback', 'checkpointed'].includes(r.status)),
      )
    )
      throw Error('Finish or reconcile work before editing');
    if (
      this.data.approvals.some(
        a => a.cardId === cardId && a.entryId === c.entryId && a.status === 'pending',
      )
    )
      throw Error('Resolve the pending approval before editing');
    const title = required(input.title, 'Title', 180);
    if (typeof input.text !== 'string' || input.text.length > 12000)
      throw Error('Invalid description');
    if (title === c.title && input.text === c.initialText) return c;
    const previous = structuredClone(c);
    c.revisions ??= [];
    c.revisions.push({ title: c.title, text: c.initialText, at: now() });
    c.title = title;
    c.initialText = input.text;
    try {
      this.save();
    } catch (error) {
      for (const key of Object.keys(c)) delete c[key];
      Object.assign(c, previous);
      throw error;
    }
    return c;
  }
  comment(cardId, input) {
    const c = this.card(cardId),
      requestId = required(input.requestId, 'Comment request', 120),
      text = required(input.text, 'Comment', 12000);
    const prior = c.comments?.find(m => m.requestId === requestId);
    if (prior) return prior;
    const message = { id: id(), requestId, text, at: now(), author: 'user' };
    c.comments ??= [];
    c.comments.push(message);
    try {
      this.save();
    } catch (error) {
      c.comments.pop();
      throw error;
    }
    return message;
  }
  session(projectId, input) {
    this.project(projectId);
    if (input.cardId && this.card(input.cardId).projectId !== projectId)
      throw Error('Card belongs to another project');
    const s = {
      id: id(),
      projectId,
      cardId: input.cardId || null,
      name: required(input.name, 'Session name', 180),
      messages: [],
      createdAt: now(),
    };
    this.data.sessions.push(s);
    this.save();
    return s;
  }
  discuss(sessionId, input) {
    const s = this.data.sessions.find(s => s.id === sessionId);
    if (!s) throw Error('Session not found');
    s.messages.push({
      id: id(),
      role: 'user',
      text: required(input.text, 'Message'),
      createdAt: now(),
    });
    this.save();
    return s;
  }
  move(cardId, stage) {
    const c = this.card(cardId),
      stages = c.kind === 'idea' ? IDEA_STAGES : TASK_STAGES;
    if (
      this.data.runs.some(
        r =>
          r.cardId === c.id &&
          (active(r) || ['uncertain', 'feedback', 'checkpointed'].includes(r.status)),
      )
    )
      throw Error('Finish or reconcile the current run first');
    if (stage === c.stage) return c;
    const legal =
      c.kind === 'idea'
        ? {
            idea: ['specification'],
            specification: [],
            development: ['testing'],
            testing: ['development', 'approval'],
            approval: [],
            done: [],
          }
        : { todo: ['in-progress'], 'in-progress': ['approval'], approval: [], done: [] };
    if (!stages.includes(stage) || !legal[c.stage].includes(stage))
      throw Error('This transition requires user approval or is invalid');
    this.enter(c, stage);
    this.save();
    return c;
  }
  enter(c, stage) {
    c.stage = stage;
    c.entryId = id();
    c.feedback = null;
    if (stage === 'approval') this.approval(c, 'completion');
  }
  approval(c, kind) {
    let a = this.data.approvals.findLast(
      a => a.cardId === c.id && a.entryId === c.entryId && a.kind === kind,
    );
    if (!a || a.status === 'rejected') {
      a = { id: id(), cardId: c.id, entryId: c.entryId, kind, status: 'pending', createdAt: now() };
      this.data.approvals.push(a);
    }
    return a;
  }
  requestDevelopment(cardId) {
    const c = this.card(cardId);
    if (c.kind !== 'idea' || c.stage !== 'specification') throw Error('Specification required');
    if (
      this.data.runs.some(
        r =>
          r.cardId === c.id &&
          (active(r) || ['uncertain', 'feedback', 'checkpointed'].includes(r.status)),
      )
    )
      throw Error('Finish preparation, submit feedback or reconcile first');
    const a = this.approval(c, 'development');
    this.save();
    return a;
  }
  decide(approvalId, accept, feedback = '') {
    if (typeof accept !== 'boolean') throw Error('Decision must be boolean');
    const a = this.data.approvals.find(a => a.id === approvalId);
    if (!a) throw Error('Approval not found');
    const c = this.card(a.cardId);
    if (a.status !== 'pending') return c;
    if (a.entryId !== c.entryId) throw Error('Stale approval');
    if (
      this.data.runs.some(
        r =>
          r.cardId === c.id &&
          (active(r) || ['uncertain', 'feedback', 'checkpointed'].includes(r.status)),
      )
    )
      throw Error('Finish or reconcile the current run first');
    a.status = accept ? 'accepted' : 'rejected';
    a.feedback = String(feedback).slice(0, 12000);
    a.decidedAt = now();
    if (a.kind === 'development') this.enter(c, accept ? 'development' : 'specification');
    else this.enter(c, accept ? 'done' : c.kind === 'idea' ? 'development' : 'in-progress');
    if (!accept) c.requiresUserStart = true;
    c.feedback = a.feedback;
    c.lastReview = { approvalId: a.id, status: a.status, feedback: a.feedback, at: a.decidedAt };
    this.save();
    return c;
  }
  feedback(cardId, text, { continueWork = false } = {}) {
    if (typeof continueWork !== 'boolean') throw Error('Continue work must be boolean');
    const c = this.card(cardId),
      r = this.data.runs.findLast(r => r.cardId === c.id && r.entryId === c.entryId);
    if (r?.status !== 'feedback') throw Error('No preparation awaiting feedback');
    const feedback = required(text, 'Feedback');
    const before = structuredClone(c),
      approvalIds = new Set(this.data.approvals.map(a => a.id));
    r.status = 'completed';
    r.feedback = feedback;
    c.feedback = feedback;
    try {
      if (continueWork) {
        c.entryId = id();
        r.outcomeDeclined = true;
      } else if (r.pendingOutcome) this.applyOutcome(c, r, r.pendingOutcome);
      this.save();
    } catch (error) {
      for (const key of Object.keys(c)) delete c[key];
      Object.assign(c, before);
      this.data.approvals = this.data.approvals.filter(a => approvalIds.has(a.id));
      r.status = 'feedback';
      delete r.transitionApplied;
      throw error;
    }
    return c;
  }
  parseOutcome(run, result) {
    if (!result?.workflow) return null;
    const w = result.workflow;
    if (typeof w.simulated !== 'boolean' || (result.synthetic === true && !w.simulated))
      throw Error('Outcome must identify simulated execution truthfully');
    const allowed = {
      specification: ['specification-ready', 'work-failed'],
      development: ['development-completed', 'work-failed'],
      testing: ['validation-passed', 'validation-failed', 'work-failed'],
      'in-progress': ['task-completed', 'work-failed'],
    };
    if (!allowed[run.stage]?.includes(w.kind)) throw Error('Invalid outcome for current stage');
    return {
      kind: w.kind,
      simulated: w.simulated,
      evidence: required(w.evidence, 'Outcome evidence', 12000),
    };
  }
  applyOutcome(card, run, outcome) {
    if (run.transitionApplied) return;
    if (card.entryId !== run.entryId || card.stage !== run.stage)
      throw Error('Stale executor outcome');
    const from = card.stage;
    if (outcome.kind === 'specification-ready') {
      const a = this.approval(card, 'development');
      a.generatedByRun = run.id;
    } else {
      const to = {
        'development-completed': 'testing',
        'validation-passed': 'approval',
        'validation-failed': 'development',
        'task-completed': 'approval',
        'work-failed': from,
      }[outcome.kind];
      if (!to) throw Error('Invalid executor outcome');
      this.enter(card, to);
    }
    if (['validation-failed', 'work-failed'].includes(outcome.kind)) card.requiresUserStart = true;
    card.lastProgress = { ...outcome, from, to: card.stage, runId: run.id, at: now() };
    card.simulated = outcome.simulated;
    run.transitionApplied = { from, to: card.stage, entryId: card.entryId };
  }

  control(projectId, action, until = null) {
    const p = this.scope(projectId);
    if (!['play', 'pause', 'resume', 'stop'].includes(action)) throw Error('Invalid control');
    if (until !== null && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()))
      throw Error('Choose a future resume time');
    if (action === 'pause') {
      p.individual = true;
      p.until = until;
    } else if (action === 'stop') {
      for (const c of this.data.cards.filter(c => c.projectId === (projectId || null))) {
        delete c.autoAuthorization;
        c.routingStatus = { status: 'stopped', reason: 'Stopped by user' };
      }
      p.stopped = true;
      p.individual = true;
      p.until = null;
    } else {
      p.individual = false;
      p.shutdown = false;
      p.stopped = false;
      p.until = null;
    }
    this.settle(p);
    this.save();
    this.executor?.control?.(projectId, action);
    return p;
  }
  bulk(action) {
    if (!['pause', 'resume'].includes(action)) throw Error('Invalid bulk control');
    for (const p of [this.data.general, ...this.data.projects]) {
      p.bulk = action === 'pause';
      if (action === 'resume') p.shutdown = false;
      this.settle(p);
    }
    this.save();
    if (action === 'pause')
      for (const p of [this.data.general, ...this.data.projects])
        this.executor?.control?.(p.id || null, 'pause');
  }
  routingQueue(c, code, reason) {
    const next = { status: 'waiting', code, reason, entryId: c.entryId };
    if (JSON.stringify(c.routingStatus) !== JSON.stringify(next)) {
      c.routingStatus = next;
      this.save();
    }
    return { queued: true, cardId: c.id, entryId: c.entryId, ...next };
  }
  botBusy(botId, runId) {
    return (
      this.executor?.botBusy?.(botId, runId) ||
      this.store.data.jobs.some(
        j =>
          j.botId === botId &&
          (!runId || j.workflowUnit?.runId !== runId) &&
          ['queued', 'deferred', 'running', 'waiting'].includes(j.status),
      ) ||
      this.data.runs.some(
        r => r.id !== runId && r.botIds?.includes(botId) && (active(r) || r.status === 'uncertain'),
      )
    );
  }
  async tick() {
    if (this.closed) return;
    let changed = false;
    for (const p of [this.data.general, ...this.data.projects])
      if (p.until && Date.parse(p.until) <= Date.now()) {
        p.individual = false;
        p.until = null;
        this.settle(p);
        changed = true;
      }
    const order = new Map(this.data.projects.map((p, i) => [p.id, i]));
    const cards = [...this.data.cards].sort(
      (a, b) => (order.get(a.projectId) ?? -1) - (order.get(b.projectId) ?? -1),
    );
    for (const c of cards) {
      const config = c.projectId ? this.project(c.projectId).stages[workingStage(c)] : null,
        authorizedAuto =
          c.routingMode === 'automatic' && c.autoAuthorization && !c.routingNeedsResume;
      if (
        !c.archivedAt &&
        (authorizedAuto ||
          (!this.executor?.manualOnly &&
            config &&
            config.mode !== 'manual' &&
            c.stage !== 'idea')) &&
        !['approval', 'done'].includes(c.stage) &&
        !c.requiresUserStart &&
        !this.blocked(this.scope(c.projectId)) &&
        !this.data.approvals.some(
          a => a.cardId === c.id && a.entryId === c.entryId && a.status === 'pending',
        )
      ) {
        try {
          this.start(c.id, { automatic: true });
        } catch (error) {
          if (c.admissionError !== error.message) {
            c.admissionError = error.message;
            changed = true;
          }
        }
      }
    }
    if (changed) this.save();
  }
  start(cardId, { automatic = false, cores = 1, memory = 256 * 1024 * 1024, entryId } = {}) {
    const c = this.card(cardId),
      p = this.scope(c.projectId);
    if (entryId !== undefined && entryId !== c.entryId) {
      const prior = this.data.runs.find(r => r.cardId === c.id && r.entryId === entryId);
      if (prior) return prior;
      throw Error('Stale stage entry');
    }
    if (
      this.data.runs.some(
        r =>
          r.cardId === c.id &&
          r.entryId !== c.entryId &&
          (active(r) || ['uncertain', 'feedback', 'checkpointed'].includes(r.status)),
      )
    )
      throw Error('Finish or reconcile prior card work first');
    const existing = this.data.runs.findLast(r => r.cardId === c.id && r.entryId === c.entryId);
    if (existing && existing.status !== 'checkpointed') return existing;
    if (existing) {
      cores = existing.cores;
      memory = existing.memory;
    }
    if (this.closed) throw Error('Kanban is shutting down');
    if (
      this.data.approvals.some(
        a => a.cardId === c.id && a.entryId === c.entryId && a.status === 'pending',
      )
    )
      throw Error('User approval pending');
    if (this.blocked(p)) throw Error('Work is paused or project is inactive');
    if (['approval', 'done'].includes(c.stage)) throw Error('This stage cannot run');
    if (
      automatic &&
      this.executor?.manualOnly &&
      !(c.routingMode === 'automatic' && c.autoAuthorization && !c.routingNeedsResume)
    )
      throw Error('Explicit user start required for live execution');
    if (automatic && ((c.stage === 'idea' && !c.autoAuthorization) || c.requiresUserStart))
      throw Error('Explicit user start required');
    const stage = workingStage(c);
    const configured = c.projectId ? this.project(c.projectId).stages[stage] : null;
    let config =
      c.assignmentMode === 'card' && c.botIds?.length
        ? { mode: 'manual', botIds: c.botIds }
        : configured?.botIds?.length
          ? configured
          : { mode: 'manual', botIds: c.botIds || [] };
    if (c.routingMode === 'automatic') {
      if (automatic && (!c.autoAuthorization || c.routingNeedsResume))
        throw Error('Explicit routing start or restart review required');
      if (!automatic) {
        c.autoAuthorization ??= { id: id(), at: now() };
        c.routingNeedsResume = false;
        c.requiresUserStart = false;
        this.save();
      }
      if (existing) config = { mode: 'manual', botIds: existing.botIds };
      else {
        const match = routingCandidates(
          c,
          this.data.projects,
          this.store.data.bots,
          this.executor?.routingEligibility,
        );
        if (!match.role && !match.candidates.length)
          return this.routingQueue(
            c,
            'missing-type',
            'Choose the task type for automatic selection, or select an existing agent manually',
          );
        if (!match.candidates.length)
          return this.routingQueue(
            c,
            'missing-role',
            `No eligible ${ROLE_NAMES[match.role] || 'stage'} specialist or capable general-purpose agent. ${match.unavailable || ''} Set an existing agent role title/stage assignment, connect the required existing service, or choose manually`,
          );
        const bot = match.candidates.find(b => !this.botBusy(b.id));
        if (!bot)
          return this.routingQueue(
            c,
            'busy',
            'Waiting for a suitable agent to finish its existing work across all chats and boards',
          );
        config = { mode: 'manual', botIds: [bot.id] };
        c.routingStatus = {
          status: 'selected',
          entryId: c.entryId,
          botId: bot.id,
          role: match.role,
          basis: match.basis,
          reason: `Selected ${bot.name} from ${match.basis}`,
        };
        if (c.projectId) {
          const project = this.project(c.projectId);
          if (!(project.teamExplicit ?? !!project.team.length))
            project.team = [...new Set([...project.team, bot.id])];
        }
      }
    } else if (automatic && (!config || config.mode === 'manual'))
      throw Error('Manual Run required');
    if (!this.executor) throw Error('Execution adapter disabled; no provider work submitted');
    if (!config?.botIds.length) throw Error('Assign stage bots first');
    if (existing && JSON.stringify(existing.botIds) !== JSON.stringify(config.botIds))
      throw Error(
        'Restore the checkpointed stage assignment or explicitly abandon remaining units',
      );
    if (
      c.projectId &&
      (existing?.botIds || config.botIds).some(b => !this.project(c.projectId).team.includes(b))
    )
      throw Error('Assigned bots must belong to the project team');
    if (
      (existing?.botIds || config.botIds).some(
        b => !this.store.data.bots.some(x => x.id === b && !x.deletedAt),
      )
    )
      throw Error('Restore or replace unavailable assigned bots');
    if (!Number.isFinite(cores) || cores <= 0 || !Number.isFinite(memory) || memory <= 0)
      throw Error('Invalid resources');
    if (!this.hasCapacity(cores, memory)) {
      if (c.routingMode === 'automatic')
        return this.routingQueue(c, 'resources', 'Waiting for available host CPU and RAM');
      throw Error('Insufficient available CPU or RAM');
    }
    const previousAdmissionError = c.admissionError;
    delete c.admissionError;
    const r = existing || {
      id: id(),
      cardId: c.id,
      projectId: c.projectId,
      entryId: c.entryId,
      stage,
      status: 'running',
      botIds: [...config.botIds],
      mode: config.mode,
      cores,
      memory,
      startedAt: now(),
      checkpoint: null,
    };
    const previousStatus = r.status,
      previousError = r.error;
    if (!existing) this.data.runs.push(r);
    r.status = 'running';
    delete r.error;
    try {
      this.save();
    } catch (error) {
      if (!existing) this.data.runs.splice(this.data.runs.indexOf(r), 1);
      else r.status = previousStatus;
      if (previousError) r.error = previousError;
      if (previousAdmissionError) c.admissionError = previousAdmissionError;
      throw Error('Admission persistence failed; no executor submitted: ' + error.message);
    }
    let terminalSnapshot, approvalIds;
    const unit = Promise.resolve()
      .then(() => {
        if (c.entryId !== r.entryId) throw Error('Stale stage entry');
        if (c.stage !== r.stage) {
          const from = c.stage;
          c.stage = r.stage;
          c.lastProgress = {
            kind: 'started',
            from,
            to: r.stage,
            runId: r.id,
            simulated: this.executor.simulated === true,
            evidence: 'Execution unit started',
            at: now(),
          };
        }
        c.requiresUserStart = false;
        r.simulated = this.executor.simulated === true;
        this.save();
        return this.executor({
          run: structuredClone(r),
          shouldContinue: () => !this.closed && !this.blocked(this.scope(c.projectId)),
          canSubmit: () => {
            try {
              return this.hasCapacity(r.cores, r.memory, r.id);
            } catch {
              return false;
            }
          },
          checkpoint: progress => {
            const durable = JSON.parse(JSON.stringify(progress));
            r.progress = durable;
            r.checkpoint = { at: now(), progress: durable };
            this.save();
          },
          card: structuredClone(c),
          context: {
            project: c.projectId ? structuredClone(this.project(c.projectId)) : null,
            sessions: structuredClone(this.data.sessions.filter(s => s.projectId === c.projectId)),
            bots: structuredClone(this.store.data.bots.filter(b => r.botIds.includes(b.id))),
            history: structuredClone(
              this.data.runs.filter(previous => previous.cardId === c.id && previous.id !== r.id),
            ),
          },
        });
      })
      .then(result => {
        terminalSnapshot = structuredClone(c);
        approvalIds = new Set(this.data.approvals.filter(a => a.cardId === c.id).map(a => a.id));
        const durable = JSON.parse(JSON.stringify(result ?? null));
        r.checkpoint = { at: now(), result: durable };
        r.status =
          result?.yielded === true ? 'checkpointed' : r.mode === 'semi' ? 'feedback' : 'completed';
        if (r.status !== 'checkpointed') {
          const outcome = this.parseOutcome(r, durable);
          if (outcome) {
            r.pendingOutcome = outcome;
            r.simulated = outcome.simulated;
            if (r.status === 'completed') this.applyOutcome(c, r, outcome);
          }
        }
      })
      .catch(error => {
        r.status = 'uncertain';
        r.error = String(error.message || error);
      })
      .finally(() => {
        r.finishedAt = now();
        this.pending.delete(r.id);
        this.settle(p);
        try {
          this.save();
        } catch (error) {
          if (terminalSnapshot) {
            for (const key of Object.keys(c)) delete c[key];
            Object.assign(c, terminalSnapshot);
            this.data.approvals = this.data.approvals.filter(
              a => a.cardId !== c.id || approvalIds.has(a.id),
            );
            delete r.transitionApplied;
          }
          r.status = 'uncertain';
          r.error = 'Checkpoint persistence failed: ' + error.message;
          this.persistenceError = r.error;
          this.settle(p);
        }
      });
    this.pending.set(r.id, unit);
    return r;
  }
  hasCapacity(cores, memory, excludeRunId = null) {
    const resource = this.resources();
    if (
      resource.cpuMeasured === false ||
      !Number.isFinite(resource.cores) ||
      resource.cores < 0 ||
      !Number.isFinite(resource.memory) ||
      resource.memory < 0
    )
      throw Error('Resource measurements unavailable');
    const reservations = this.data.runs.filter(r => r.id !== excludeRunId && reservesResources(r));
    if (
      reservations.some(
        r =>
          !Number.isFinite(r.cores) || r.cores <= 0 || !Number.isFinite(r.memory) || r.memory <= 0,
      )
    )
      throw Error('Outstanding resource reservation is unknown');
    const reserved = reservations.reduce(
      (v, r) => ({ cores: v.cores + r.cores, memory: v.memory + r.memory }),
      { cores: 0, memory: 0 },
    );
    return (
      Math.min(resource.cores, (resource.totalCores ?? resource.cores) - reserved.cores) >= cores &&
      Math.min(resource.memory, (resource.totalMemory ?? resource.memory) - reserved.memory) >=
        memory
    );
  }
  async close() {
    this.closed = true;
    for (const p of [this.data.general, ...this.data.projects]) {
      p.shutdown = true;
      this.settle(p);
    }
    let failure;
    try {
      this.save();
    } catch (error) {
      failure = error;
    }
    for (const p of [this.data.general, ...this.data.projects])
      this.executor?.control?.(p.id || null, 'pause');
    await Promise.allSettled([...this.pending.values()]);
    if (failure) throw failure;
  }
  reconcile(runId, { checkpoint, retry = false } = {}) {
    if (typeof retry !== 'boolean') throw Error('Retry must be boolean');
    const r = this.data.runs.find(r => r.id === runId);
    if (!r || !['uncertain', 'checkpointed'].includes(r.status))
      throw Error('Uncertain or checkpointed run required');
    if (r.status === 'checkpointed' && retry)
      throw Error('Use Resume and Run to continue checkpointed work');
    checkpoint = required(checkpoint, 'Record review of effects', 12000);
    this.executor?.reconcile?.(r, { retry, checkpoint });
    r.checkpoint = { at: now(), review: checkpoint, progress: r.progress ?? null };
    r.status = retry ? 'checkpointed' : 'reconciled';
    if (!retry) {
      const c = this.card(r.cardId);
      delete c.autoAuthorization;
      if (c.entryId === r.entryId) {
        c.entryId = id();
        c.requiresUserStart = true;
      }
    }
    this.settle(this.scope(r.projectId));
    this.save();
    return r;
  }
}
