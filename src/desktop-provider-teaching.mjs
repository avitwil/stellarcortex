import { randomUUID } from 'node:crypto';
import { scopeKey } from './desktop-provider-session.mjs';
import {
  safeDemonstrationStep,
  noDemonstrationSecrets,
  demonstrationText,
} from '../public/computer-demonstration.js';
import { frameRedactionPlan } from './guest-redaction.mjs';
// Explicit, owner-reviewed teaching for the new provider. Raw captures are
// memory-only and expire; only reviewed redacted examples reach saveSkill.
export class DesktopTeachingDrafts {
  constructor({
    coordinator,
    capture,
    redact,
    saveSkill,
    clock = () => Date.now(),
    ttlMs = 600000,
  }) {
    Object.assign(this, { coordinator, capture, redact, saveSkill, clock, ttlMs });
    this.drafts = new Map();
    this.timer = setInterval(() => this.prune(), 1000);
    this.timer.unref();
  }
  authorize(scope, lease) {
    if (!this.coordinator.canWrite(scope, lease))
      throw Error('Current human control required for teaching');
  }
  prune() {
    for (const [id, d] of this.drafts) {
      if (d.expiresAt <= this.clock()) this.drafts.delete(id);
      else
        for (const [key, frame] of d.frames)
          if (frame.expiresAt <= this.clock()) d.frames.delete(key);
    }
  }
  close() {
    clearInterval(this.timer);
    this.drafts.clear();
  }
  start(scope, lease, objective) {
    this.authorize(scope, lease);
    this.prune();
    if (
      typeof objective !== 'string' ||
      !objective.trim() ||
      objective.length > 2000 ||
      !noDemonstrationSecrets(objective)
    )
      throw Error('Non-sensitive teaching objective required');
    if (this.drafts.size >= 8) throw Error('Review or discard existing teaching drafts');
    for (const d of this.drafts.values())
      if (d.scopeKey === scopeKey(scope) && !d.saved)
        throw Error('Review or discard the existing teaching draft');
    const id = randomUUID();
    this.drafts.set(id, {
      id,
      scope,
      scopeKey: scopeKey(scope),
      connectionId: lease.connectionId,
      objective: objective.trim(),
      expiresAt: this.clock() + this.ttlMs,
      steps: [],
      frames: new Map(),
      reviewedFrames: [],
      state: 'recording',
    });
    return { id, objective, expiresInMs: this.ttlMs };
  }
  get(id, scope, lease) {
    this.authorize(scope, lease);
    this.prune();
    const d = this.drafts.get(id);
    if (!d || d.scopeKey !== scopeKey(scope) || d.connectionId !== lease.connectionId)
      throw Error('Teaching draft expired or belongs to another control session');
    return d;
  }
  record(id, scope, lease, event, dimensions) {
    const d = this.get(id, scope, lease);
    if (d.state !== 'recording') return;
    if (d.steps.length >= 500) {
      d.state = 'paused';
      d.reason = 'Action limit reached; stop and review';
      return;
    }
    const step = safeDemonstrationStep(event, dimensions);
    if (step) {
      d.steps.push(step);
      if (step.action === 'manual-input') d.state = 'paused';
    }
  }
  recordInput(scope, lease, event) {
    if (!this.coordinator.canWrite(scope, lease)) return;
    this.prune();
    for (const d of this.drafts.values())
      if (
        d.scopeKey === scopeKey(scope) &&
        d.connectionId === lease.connectionId &&
        d.state === 'recording'
      ) {
        // Pointer coordinates are meaningful only after an explicit reference capture.
        if (['click', 'drag', 'doubleClick'].includes(event.action) && !d.dimensions) {
          d.state = 'paused';
          d.reason = 'Capture a reference frame before demonstrating pointer actions';
          continue;
        }
        try {
          this.record(d.id, scope, lease, event, d.dimensions);
        } catch {
          d.state = 'paused';
          d.reason = 'Input could not be recorded safely';
        }
      }
  }
  status(id, scope, lease) {
    const d = this.get(id, scope, lease);
    return { state: d.state, count: d.steps.length, reason: d.reason || null };
  }
  stop(id, scope, lease) {
    const d = this.get(id, scope, lease);
    d.state = 'review';
    return { state: d.state, steps: d.steps, instructions: demonstrationText(d) };
  }
  reviewText(id, scope, lease, { index, text, confirmed }) {
    const d = this.get(id, scope, lease);
    if (
      d.saved ||
      d.saving ||
      d.state !== 'review' ||
      !Number.isInteger(index) ||
      !['manual-input', 'reviewed-text'].includes(d.steps[index]?.action)
    )
      throw Error('Stop recording and select a text step to review');
    if (text === null) d.steps[index] = { action: 'manual-input' };
    else {
      if (confirmed !== true)
        throw Error('Confirm storage and model disclosure for this text step');
      d.steps[index] = safeDemonstrationStep({ action: 'reviewed-text', text, reviewed: true });
    }
    return { state: d.state, steps: d.steps, instructions: demonstrationText(d) };
  }
  resume(id, scope, lease, { safeScreenConfirmed }) {
    const d = this.get(id, scope, lease);
    if (d.saved || d.saving || safeScreenConfirmed !== true)
      throw Error('Confirm the screen is safe before continuing');
    d.state = 'recording';
    d.reason = null;
    return this.status(id, scope, lease);
  }
  async captureFrame(id, scope, lease) {
    const d = this.get(id, scope, lease);
    if (d.state !== 'recording') throw Error('Teaching capture is paused');
    if (d.frames.size >= 4) throw Error('Review or discard existing frames');
    const frame = await this.capture(scope);
    this.get(id, scope, lease);
    if (d.state !== 'recording') throw Error('Teaching capture was paused');
    if (
      !frame ||
      typeof frame.image !== 'string' ||
      frame.image.length > 8 * 1024 * 1024 ||
      !['image/jpeg', 'image/png'].includes(frame.mimeType)
    )
      throw Error('Bounded image required');
    frameRedactionPlan({
      width: frame.width,
      height: frame.height,
      crop: { x: 0, y: 0, width: frame.width, height: frame.height },
    });
    d.dimensions = { width: frame.width, height: frame.height };
    const frameId = randomUUID();
    d.frames.set(frameId, { ...frame, expiresAt: this.clock() + 30000 });
    return { frameId, ...frame };
  }
  async preview(id, scope, lease, { frameId, crop, masks, safeScreenConfirmed }) {
    const d = this.get(id, scope, lease),
      frame = d.frames.get(frameId);
    if (!frame || frame.expiresAt <= this.clock())
      throw Error('Capture expired; take a new explicit capture');
    if (safeScreenConfirmed !== true) throw Error('Review the capture area first');
    frameRedactionPlan({ ...frame, crop, masks });
    const preview = await this.redact(frame, { crop, masks });
    this.get(id, scope, lease);
    if (frame.expiresAt <= this.clock()) throw Error('Capture expired during redaction');
    if (
      typeof preview?.image !== 'string' ||
      preview.image.length > 6 * 1024 * 1024 ||
      !['image/jpeg', 'image/png'].includes(preview.mimeType)
    )
      throw Error('Invalid redacted preview');
    const previewId = randomUUID();
    d.reviewedFrames.push({
      previewId,
      frame: { image: preview.image, mimeType: preview.mimeType },
      reviewed: false,
    });
    d.frames.delete(frameId);
    return { previewId, ...preview };
  }
  review(id, scope, lease, { previewId, reviewedNoSecrets }) {
    const d = this.get(id, scope, lease),
      frame = d.reviewedFrames.find(f => f.previewId === previewId);
    if (!frame || reviewedNoSecrets !== true) throw Error('Explicit preview review required');
    frame.reviewed = true;
  }
  async save(id, scope, lease, { name, instructions, reviewed }) {
    const d = this.get(id, scope, lease);
    if (d.saved) return d.saved;
    if (d.steps.length && d.state !== 'review')
      throw Error('Stop and review recorded actions before saving');
    if (d.saving) throw Error('Teaching save is already pending');
    if (
      reviewed !== true ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      typeof instructions !== 'string' ||
      !instructions.trim() ||
      instructions.length > 12000 ||
      !noDemonstrationSecrets(name + '\n' + instructions)
    )
      throw Error('Reviewed non-sensitive instructions required');
    const frames = d.reviewedFrames.filter(f => f.reviewed).map(f => f.frame);
    if (!d.steps.length && !frames.length)
      throw Error('Demonstrate an action or review a visual example');
    d.saving = true;
    d.state = 'review';
    try {
      d.saved = await this.saveSkill({
        scope: d.scope,
        demonstrationId: d.id,
        objective: d.objective,
        name,
        instructions,
        steps: d.steps,
        frames,
      });
      d.frames.clear();
      d.reviewedFrames = [];
      return d.saved;
    } finally {
      d.saving = false;
    }
  }
  discard(id, scope, lease) {
    this.get(id, scope, lease);
    this.drafts.delete(id);
  }
}
