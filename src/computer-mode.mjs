import fs from 'node:fs';

export const COMPUTER_MODES = Object.freeze(['none', 'vm', 'host']);
export const HOST_WARNING =
  'A host bot runs as the server’s OS user. Its shell can read private keys, the access key and browser cookies, and can call the app’s API as the owner. No application setting can stop that.';
// Metadata only: this reports what the status should say and never starts anything.
export function hostCapability({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  const state = exists('/.dockerenv')
    ? 'container'
    : env.WSL_DISTRO_NAME
      ? 'wsl'
      : platform !== 'linux'
        ? 'unsupported'
        : env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY
          ? 'wayland'
          : env.DISPLAY
            ? 'x11'
            : 'no-display';
  return { platform, state, screen: state === 'x11' };
}
export function resolveComputer(bot = {}, { defaultVm = false } = {}) {
  return bot.computer ?? (defaultVm ? 'vm' : 'none');
}
export function computerSnapshot(
  store,
  { vm = false, defaultVm = false, host = hostCapability() } = {},
) {
  return {
    vm: { available: vm },
    host,
    warning: HOST_WARNING,
    bots: store.data.bots
      .filter(bot => !bot.deletedAt)
      .map(bot => ({
        id: bot.id,
        name: bot.name,
        computer: resolveComputer(bot, { defaultVm }),
      })),
  };
}
// Only the authenticated settings route calls this. Bot creation, templates and agent
// tools cannot reach it, so a bot can never give itself a computer.
export function setComputerMode(store, input = {}, capability = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !['botId', 'mode', 'confirmHost'].includes(key))
  )
    throw new Error('Unknown computer settings field');
  const { botId, mode, confirmHost = false } = input;
  if (typeof botId !== 'string' || !botId) throw new Error('Invalid bot ID');
  if (!COMPUTER_MODES.includes(mode)) throw new Error('Unknown computer mode');
  const bot = store.bot(botId);
  if (bot.deletedAt) throw new Error('Restore this bot before editing it');
  if (mode === 'vm' && !capability.vm)
    throw new Error('Virtual computers are not configured on this installation');
  if (mode === 'host' && confirmHost !== true)
    throw new Error('Explicit confirmation is required for host control');
  if (
    store.data.jobs.some(
      job =>
        job.botId === bot.id && ['running', 'waiting', 'queued', 'deferred'].includes(job.status),
    )
  )
    throw new Error('Wait for this bot’s work to finish before changing its computer');
  bot.computer = mode;
  store.save();
  return computerSnapshot(store, capability);
}
