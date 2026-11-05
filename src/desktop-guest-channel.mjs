import { sessionRegistration } from './desktop-session-registration.mjs';
import { spawn } from 'node:child_process';
const passive = new Set([
  'execution.ping',
  'execution.status',
  'execution.inspect',
  'browser.read',
  'browser.snapshot',
  'browser.login.status',
  'desktop.snapshot',
  'files.list',
  'files.read',
  'files.inspect',
  'files.chunk',
]);
const allowed = new Set([
  ...passive,
  'execution.cancel',
  'execution.reconcile',
  'browser.action',
  'browser.login',
  'browser.takeover',
  'desktop.takeover',
  'files.write',
  'shell.run',
  'desktop.type',
  'desktop.input',
  'desktop.releaseInputs',
]);
// transient is the only field left out of every digest and journal. It carries a password and nothing else.
export function guestEnvelope(record, { scope, requestId, method, args = {}, transient }) {
  if (
    !allowed.has(method) ||
    typeof requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(requestId) ||
    !Number.isInteger(record.cid) ||
    record.cid < 3
  )
    throw Error('Invalid registered guest request');
  if (record.sessionId) sessionRegistration(record, scope);
  if (
    ['desktop.input', 'desktop.releaseInputs', 'desktop.snapshot'].includes(method) &&
    !record.sessionId
  )
    throw Error('Session-local desktop adapter required');
  return {
    protocol: 'scx-guest-v1',
    vmId: scope.vmId,
    generation: scope.generation,
    botId: scope.botId,
    ...(record.sessionId
      ? {
          sessionId: scope.sessionId,
          computerId: scope.computerId,
          environmentId: scope.environmentId,
          accountId: scope.accountId,
        }
      : {}),
    requestId,
    method,
    args,
    ...(transient ? { transient } : {}),
  };
}
export function callRegisteredGuest(
  record,
  input,
  {
    helper = '/opt/stellarcortex-desktop-broker/scripts/desktop-vsock-call.py',
    spawnImpl = spawn,
  } = {},
) {
  const request = guestEnvelope(record, input),
    payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw Error('Guest request too large');
  const seconds =
    request.method === 'shell.run' && Number.isInteger(request.args.timeoutMs)
      ? Math.min(3605, Math.max(45, Math.ceil(request.args.timeoutMs / 1000) + 5))
      : 45;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      '/usr/bin/python3',
      ['-I', helper, String(record.cid), String(seconds), ...(record.sessionId ? ['701'] : [])],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '',
      error = '',
      tooLarge = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), (seconds + 2) * 1000);
    timer.unref();
    child.stdout.on('data', b => {
      out += b;
      if (Buffer.byteLength(out) > 16 * 1024 * 1024) {
        tooLarge = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', b => {
      error = (error + b).slice(-2048);
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('Guest transport could not start'));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      try {
        if (code !== 0 || tooLarge) throw Error('Guest transport ended without a confirmed reply');
        const reply = JSON.parse(out);
        if (typeof reply.relayError === 'string')
          throw Object.assign(
            Error('Guest refused the request: ' + reply.relayError.slice(0, 300)),
            { settled: true },
          );
        if (
          reply.protocol !== request.protocol ||
          reply.vmId !== request.vmId ||
          reply.generation !== request.generation ||
          reply.requestId !== request.requestId
        )
          throw Error('Guest reply identity mismatch');
        if (
          record.sessionId &&
          ['sessionId', 'computerId', 'environmentId', 'accountId', 'botId'].some(
            k => reply[k] !== request[k],
          )
        )
          throw Error('Guest session reply identity mismatch');
        if (reply.uncertain)
          throw Error('Guest operation outcome requires review; no automatic replay');
        if (reply.error) throw Object.assign(Error(reply.error), { settled: true });
        resolve(reply.result);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
export const passiveGuestMethod = method => passive.has(method);
