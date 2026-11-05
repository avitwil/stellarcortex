// Application authorization for separate bot desktops on one environment computer.
// This policy never treats shared VM membership as access to another bot's home,
// browser profile, display socket, or credentials. Provisioning remains trusted.
const valid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function environmentComputerPolicy(input) {
  if (
    !input ||
    !valid(input.environmentId) ||
    !valid(input.accountId) ||
    !valid(input.computerId) ||
    typeof input.defaultAccess !== 'boolean'
  )
    throw Error('Trusted environment computer policy required');
  const overrides = input.overrides || {};
  if (
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    Object.entries(overrides).some(([key, value]) => !valid(key) || typeof value !== 'boolean')
  )
    throw Error('Invalid bot access override');
  return { ...input, overrides: { ...overrides } };
}
export function botComputerAccess(policy, bot, { accountId, environmentId }) {
  const p = environmentComputerPolicy(policy);
  if (
    accountId !== p.accountId ||
    environmentId !== p.environmentId ||
    !bot ||
    !valid(bot.id) ||
    bot.deletedAt ||
    bot.environmentId !== environmentId
  )
    return false;
  if (Object.hasOwn(p.overrides, bot.id)) return p.overrides[bot.id];
  if (bot.computer) return bot.computer === 'vm';
  return p.defaultAccess;
}
export function registeredBotSession(policy, bot, identity, records) {
  if (!botComputerAccess(policy, bot, identity))
    throw Error('Computer access is disabled for this bot');
  const own = records.filter(
    r =>
      r.accountId === identity.accountId &&
      r.environmentId === identity.environmentId &&
      r.computerId === policy.computerId &&
      r.botId === bot.id,
  );
  if (own.length !== 1)
    throw Error(
      own.length
        ? 'Duplicate bot desktop assignment'
        : 'Bot desktop session has not been provisioned',
    );
  const r = own[0];
  if (
    !valid(r.sessionId) ||
    !Number.isInteger(r.uid) ||
    r.uid < 1000 ||
    !Number.isInteger(r.displayNumber) ||
    r.displayNumber < 1 ||
    r.displayNumber > 4095
  )
    throw Error('Trusted separate-user desktop registration required');
  for (const other of records) {
    if (other === r || other.computerId !== r.computerId || other.accountId !== r.accountId)
      continue;
    if (
      other.botId !== r.botId &&
      (other.sessionId === r.sessionId ||
        other.uid === r.uid ||
        other.displayNumber === r.displayNumber)
    )
      throw Error('Bots cannot share a desktop identity, Unix user, or display number');
  }
  return { ...r };
}
