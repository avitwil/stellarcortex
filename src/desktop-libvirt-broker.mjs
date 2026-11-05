import { effectsConflict, operationScopesConflict } from './desktop-effect-journal.mjs';
import { randomUUID } from 'node:crypto';
import {
  callRegisteredGuest,
  passiveGuestMethod,
  guestEnvelope,
} from './desktop-guest-channel.mjs';
import { captureLibvirtConsole } from './desktop-capture.mjs';
import { execFile } from 'node:child_process';
import { logProcessOutput } from './process-output.mjs';
import { promisify } from 'node:util';
import { desktopScope, scopeKey } from './desktop-provider-session.mjs';
import { qmpInputCommand, parseQmpReply, qmpReleaseCommand } from './desktop-qmp.mjs';
const execute = promisify(execFile);
export class LibvirtDesktopBroker {
  constructor({
    registry,
    approved = false,
    run = args =>
      execute('/usr/bin/virsh', ['--connect', 'qemu:///system', ...args], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
      }).catch(error => {
        // The rejection holds the command line and stderr, and it travels back to the browser.
        logProcessOutput('virsh', error.stderr, String(error.signal || error.code));
        throw new Error('virsh failed. Details are in the server log.');
      }),
    effects,
    captureDirectory,
    callGuest = callRegisteredGuest,
  }) {
    Object.assign(this, { registry, approved, run, effects, captureDirectory, callGuest });
  }
  record(scope) {
    desktopScope(scope);
    const r = this.registry.get(scope.accountId, scope.botId);
    if (
      !r ||
      scopeKey(r) !== scopeKey(scope) ||
      r.domain !== 'scx-desktop-' + scope.vmId ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.uuid || '')
    )
      throw Error('Unregistered or stale VM identity');
    return r;
  }
  async checked(scope) {
    const r = this.record(scope);
    const answer = await this.run(['domuuid', r.domain]);
    if (answer.stdout.trim().toLowerCase() !== r.uuid.toLowerCase())
      throw Error('Libvirt domain identity changed');
    return r;
  }
  async status(scope) {
    const r = await this.checked(scope),
      result = await this.run(['domstate', r.uuid]);
    return { scope: desktopScope(scope), state: result.stdout.trim() };
  }
  async release({ scope, requestId }) {
    if (!this.approved || !this.effects) throw Error('Approved audited broker required');
    const r = await this.checked(scope);
    return this.effects.execute(
      {
        scope: desktopScope(scope),
        requestId,
        operation: { action: 'release-inputs' },
        recoveryOnly: true,
      },
      async () => {
        if (r.sessionId)
          return this.callGuest(r, { scope, requestId, method: 'desktop.releaseInputs', args: {} });
        const schema = parseQmpReply(
          (
            await this.run([
              'qemu-monitor-command',
              r.uuid,
              JSON.stringify({ execute: 'query-qmp-schema' }),
            ])
          ).stdout,
        );
        parseQmpReply(
          (
            await this.run([
              'qemu-monitor-command',
              r.uuid,
              JSON.stringify(qmpReleaseCommand(schema)),
            ])
          ).stdout,
        );
        return { released: true };
      },
    );
  }
  async guest(input) {
    const r = await this.checked(input.scope);
    guestEnvelope(r, input);
    if (passiveGuestMethod(input.method)) return this.callGuest(r, input);
    return this.mutate(
      input.scope,
      input.requestId,
      { action: 'guest', method: input.method, args: input.args },
      () => this.callGuest(r, input),
    );
  }
  async operations(scope) {
    this.record(scope);
    if (!this.effects) throw Error('Audit unavailable');
    return { operations: this.effects.list(scope) };
  }
  async cancel({ scope, requestId, targetRequestId }) {
    if (!this.approved || !this.effects) throw Error('Approved audited broker required');
    const r = await this.checked(scope);
    if (
      typeof targetRequestId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(targetRequestId) ||
      targetRequestId === requestId
    )
      throw Error('Specific cancellation target required');
    if (!this.effects.records[targetRequestId]) {
      this.effects.records[targetRequestId] = {
        scope: desktopScope(scope),
        kind: 'guest',
        state: 'cancelled-before-start',
        digest: null,
        createdAt: new Date().toISOString(),
      };
      this.effects.save();
      return { requested: true, state: 'cancelled-before-start' };
    }
    const target = this.effects.scoped(targetRequestId, scope);
    if (target.kind !== 'guest' || !['shell.run', 'desktop.type'].includes(target.method))
      throw Error('This operation cannot be safely cancelled; inspect without replaying');
    if (!['inflight', 'uncertain'].includes(target.state))
      return { requested: false, state: target.state };
    return this.effects.execute(
      {
        scope: desktopScope(scope),
        requestId,
        operation: { action: 'cancel-guest', targetRequestId },
        recoveryOnly: true,
      },
      () =>
        this.callGuest(r, {
          scope,
          requestId,
          method: 'execution.cancel',
          args: { requestId: targetRequestId },
        }),
    );
  }
  async review({ scope, targetRequestId, expectedDigest, note, confirm }) {
    if (!this.approved || !this.effects || confirm !== true)
      throw Error('Explicit owner review required');
    const r = await this.checked(scope),
      target = this.effects.scoped(targetRequestId, scope);
    if (
      target.state !== 'uncertain' ||
      this.effects.pending.has(targetRequestId) ||
      target.digest !== expectedDigest
    )
      throw Error('Operation changed or is still active; refresh before review');
    if (typeof note !== 'string' || !note.trim() || note.length > 4000)
      throw Error('Actual effects review note required');
    if (target.kind === 'guest' || target.kind === 'cancel-guest') {
      const observed = await this.callGuest(r, {
        scope,
        requestId: randomUUID(),
        method: 'execution.inspect',
        args: { requestId: targetRequestId },
      });
      if (observed.active || observed.state === 'inflight')
        throw Error('Guest operation is still active; cancellation is not rollback');
      // Persist intent before remote reconciliation; if the reply is lost, leave
      // the host record uncertain. A later inspection determines the outcome.
      target.reviewAttempt = {
        at: new Date().toISOString(),
        note,
        guestObservedState: observed.state || 'not-found',
      };
      this.effects.save();
      if (observed.state !== 'reviewed-abandoned')
        await this.callGuest(r, {
          scope,
          requestId: randomUUID(),
          method: 'execution.reconcile',
          args: { requestId: targetRequestId, note, tombstone: true },
        });
    }
    return this.effects.review(targetRequestId, { scope, note });
  }
  async capture(scope) {
    const r = await this.checked(scope);
    if (r.sessionId)
      return this.callGuest(r, {
        scope,
        requestId: randomUUID(),
        method: 'desktop.snapshot',
        args: {},
      });
    if (!this.captureDirectory) throw Error('Private capture directory required');
    return captureLibvirtConsole({ run: this.run, uuid: r.uuid, directory: this.captureDirectory });
  }
  async mutate(scope, requestId, operation, work) {
    if (!this.approved) throw Error('Infrastructure approval is required');
    if (!this.effects) throw Error('Durable effect journal required');
    const r = await this.checked(scope);
    // Preserve uncertain history, but check actual remote activity rather than
    // turning a missing reply into a permanent admission lock.
    for (const [id, prior] of Object.entries(this.effects.records)) {
      if (
        !operationScopesConflict(prior.scope, scope, prior, operation) ||
        prior.state !== 'uncertain' ||
        prior.kind !== 'guest' ||
        !effectsConflict(prior, operation)
      )
        continue;
      const observed = await this.callGuest(r, {
        scope: prior.scope,
        requestId: randomUUID(),
        method: 'execution.inspect',
        args: { requestId: id },
      });
      if (observed.active || observed.state === 'inflight')
        throw Error(
          `Operation ${id} (${prior.method || 'guest action'}) is still running. Cancel that operation or wait; observation remains available.`,
        );
    }
    return this.effects.execute({ scope: desktopScope(scope), requestId, operation }, () =>
      work(r),
    );
  }
  change({ scope, action, requestId }) {
    if (scope.sessionId)
      throw Error('Shared computer lifecycle requires an environment-level owner action');
    if (!['start', 'shutdown'].includes(action)) throw Error('Unsupported lifecycle action');
    return this.mutate(scope, requestId, { action }, async r => {
      await this.run([action, r.uuid]);
      return { requested: true, action };
    });
  }
  input({ scope, requestId, action, frame }) {
    const command = qmpInputCommand(action, frame);
    return this.mutate(scope, requestId, { action: 'input', command }, async r => {
      if (r.sessionId)
        return this.callGuest(r, {
          scope,
          requestId,
          method: 'desktop.input',
          args: { action, frame },
        });
      let completed = 0;
      try {
        for (const event of command.arguments.events) {
          const result = await this.run([
            'qemu-monitor-command',
            r.uuid,
            JSON.stringify({ execute: 'input-send-event', arguments: { events: [event] } }),
          ]);
          parseQmpReply(result.stdout);
          completed++;
          if (event.type === 'key' || event.type === 'btn')
            await new Promise(resolve => setTimeout(resolve, 40));
        }
      } catch (error) {
        if (completed) error.settled = false;
        throw error;
      }
      return { ok: true };
    });
  }
}
