import { desktopScope, scopeKey } from './desktop-provider-session.mjs';
export function sessionRegistration(record, scope = record) {
  const trusted = desktopScope(record);
  if (!trusted.sessionId || scopeKey(trusted) !== scopeKey(scope))
    throw Error('Registered bot session identity required');
  if (
    !Number.isInteger(record.uid) ||
    record.uid < 1000 ||
    record.uid > 60000 ||
    !Number.isInteger(record.cid) ||
    record.cid < 3 ||
    record.cid > 0xfffffffe
  )
    throw Error('Invalid registered session transport');
  return { ...trusted, uid: record.uid, cid: record.cid };
}
export function sessionEnvelope(record, scope, channel) {
  const registered = sessionRegistration(record, scope);
  if (!['worker', 'display'].includes(channel)) throw Error('Unsupported session channel');
  return { protocol: 'scx-session-v1', channel, scope: desktopScope(registered) };
}
export function validateDesktopRegistrations(records) {
  const modes = new Map(),
    owners = new Map(),
    users = new Set(),
    sessions = new Set();
  for (const r of records) {
    const scope = desktopScope(r),
      computer = scope.vmId,
      mode = scope.sessionId ? 'sessions' : 'legacy';
    if (modes.has(computer) && modes.get(computer) !== mode)
      throw Error('Shared computer cannot retain the legacy unprivileged transport');
    modes.set(computer, mode);
    if (mode === 'sessions') {
      sessionRegistration(r);
      const owner = JSON.stringify([
        scope.accountId,
        scope.environmentId,
        scope.computerId,
        scope.generation,
      ]);
      if (owners.has(computer) && owners.get(computer) !== owner)
        throw Error('One environment and generation per shared computer required');
      owners.set(computer, owner);
      const uid = computer + '\0' + r.uid,
        session = computer + '\0' + r.sessionId;
      if (users.has(uid) || sessions.has(session))
        throw Error('Shared desktops need distinct Unix users and sessions');
      users.add(uid);
      sessions.add(session);
    }
  }
  return records;
}
