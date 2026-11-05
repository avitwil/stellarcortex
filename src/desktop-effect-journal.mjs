import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { desktopScope } from './desktop-provider-session.mjs';
// Shell and lifecycle operations can affect the entire VM. File writes and
// graphical input use distinct resources; file writes serialize with each other.
export function effectResource(operation) {
  const action = operation.action || operation.kind;
  if (action === 'guest' && operation.method === 'files.write') return 'files';
  if (
    action === 'input' ||
    (action === 'guest' &&
      ['desktop.type', 'browser.action', 'browser.takeover', 'desktop.takeover'].includes(
        operation.method,
      ))
  )
    return 'desktop';
  return '*';
}
export function operationScopesConflict(a, b, opA = {}, opB = {}) {
  if (a.accountId !== b.accountId || a.vmId !== b.vmId || a.generation !== b.generation)
    return false;
  const global = op => ['start', 'shutdown'].includes(op.action || op.kind);
  // Session-local shells run as separate non-sudo Unix users. VM lifecycle still conflicts with every session.
  if ((a.sessionId || b.sessionId) && a.sessionId !== b.sessionId && !global(opA) && !global(opB))
    return false;
  return true;
}
export function effectsConflict(a, b) {
  const x = effectResource(a),
    y = effectResource(b);
  return x === '*' || y === '*' || x === y;
}
export class DesktopEffectJournal {
  constructor(file) {
    this.file = file;
    this.pending = new Map();
    this.records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    let recovered = false;
    for (const r of Object.values(this.records))
      if (r.state === 'inflight') {
        r.state = 'uncertain';
        r.recoveredAt = new Date().toISOString();
        recovered = true;
      }
    if (recovered) this.save();
  }
  save() {
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.records));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(path.dirname(this.file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
  async execute({ scope, requestId, operation, recoveryOnly = false }, fn) {
    desktopScope(scope);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
      throw Error('Durable request identity required');
    const digest = createHash('sha256').update(JSON.stringify({ scope, operation })).digest('hex'),
      old = this.records[requestId];
    if (old) {
      if (old.digest !== digest) throw Error('Request identity reused with different operation');
      if (this.pending.has(requestId)) return this.pending.get(requestId);
      if (old.state === 'done') return old.result;
      throw Error('Recorded ' + old.state + ' operation is never replayed automatically');
    }
    if (recoveryOnly && !['release-inputs', 'cancel-guest'].includes(operation.action))
      throw Error(
        'Only input releases or scoped cancellation may bypass an unrelated uncertain effect',
      );
    if (
      !recoveryOnly &&
      Object.values(this.records).some(
        r =>
          operationScopesConflict(r.scope, scope, r, operation) &&
          r.state === 'inflight' &&
          effectsConflict(r, operation),
      )
    )
      throw Error(
        'This VM has a running operation; cancel it or wait for completion. Observation remains available',
      );
    this.records[requestId] = {
      digest,
      scope: desktopScope(scope),
      kind: operation.action,
      method: operation.method || null,
      targetRequestId: operation.targetRequestId || null,
      state: 'inflight',
      createdAt: new Date().toISOString(),
    };
    this.save();
    const work = (async () => {
      try {
        const result = await Promise.resolve().then(fn);
        this.records[requestId] = {
          ...this.records[requestId],
          state: 'done',
          completedAt: new Date().toISOString(),
          result,
        };
        this.save();
        return result;
      } catch (error) {
        this.records[requestId] = {
          ...this.records[requestId],
          state: error.settled === true ? 'settled-error' : 'uncertain',
          completedAt: new Date().toISOString(),
          errorType: error.name || 'Error',
        };
        this.save();
        throw error;
      } finally {
        this.pending.delete(requestId);
      }
    })();
    this.pending.set(requestId, work);
    return work;
  }
  scoped(requestId, scope) {
    desktopScope(scope);
    const r = this.records[requestId];
    if (!r || JSON.stringify(r.scope) !== JSON.stringify(desktopScope(scope)))
      throw Error('Review scope mismatch');
    return r;
  }
  list(scope) {
    desktopScope(scope);
    return Object.entries(this.records)
      .filter(([, r]) => JSON.stringify(r.scope) === JSON.stringify(desktopScope(scope)))
      .map(([requestId, r]) => ({
        requestId,
        kind: r.kind,
        method: r.method || null,
        state: r.state,
        digest: r.digest,
        createdAt: r.createdAt,
        completedAt: r.completedAt || null,
        active: this.pending.has(requestId),
      }));
  }
  review(requestId, { scope, note }) {
    desktopScope(scope);
    const r = this.scoped(requestId, scope);
    if (r.state !== 'uncertain' || this.pending.has(requestId))
      throw Error('Only a settled uncertain record can be reviewed');
    if (typeof note !== 'string' || !note.trim() || note.length > 4000)
      throw Error('Explicit owner review note required');
    r.state = 'reviewed-abandoned';
    r.reviewNote = note;
    r.reviewedAt = new Date().toISOString();
    this.save();
    return { reviewed: true, noReplay: true };
  }
}
