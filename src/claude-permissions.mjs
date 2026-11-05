// Claude Code modes, verified against the official CLI reference / permissions docs.
import { fileURLToPath } from 'node:url';
import { SUDO_DENY_RULES } from './elevation-policy.mjs';
export const CLAUDE_PERMISSION_MODES = Object.freeze({
  manual: 'default',
  automatic: 'auto',
  free: 'bypassPermissions',
});
export const FREE_MODE_BLOCKED =
  'Free (Dangerous) is unavailable: this integration uses Claude Code --restricted to preserve workspace boundaries, which refuses bypassPermissions. No permissions were bypassed. Choose Manual or Automatic.';
export function permissionMode(value, { inherit = false } = {}) {
  if (inherit && (value === null || value === 'inherit')) return null;
  if (typeof value !== 'string' || !Object.hasOwn(CLAUDE_PERMISSION_MODES, value))
    throw new Error('Unknown Claude permission mode');
  return value;
}
export function resolveClaudePermission(bot = {}, settings = {}) {
  const requested = bot.claudePermissionMode ?? settings.claudePermissionMode ?? 'manual';
  const mode = permissionMode(requested);
  return {
    mode,
    cliMode: CLAUDE_PERMISSION_MODES[mode],
    source: bot.claudePermissionMode == null ? 'workspace' : 'bot',
    available: mode !== 'free',
    blockedReason: mode === 'free' ? FREE_MODE_BLOCKED : null,
  };
}
export const NATIVE_ACTION_TOOLS = Object.freeze(['Bash', 'Write', 'Edit', 'NotebookEdit']);
const shellPath = value => `"${value.replaceAll('\\', '/')}"`;
// Second layer only. External content never reaches a turn that has these tools; the
// hook stops the rest of a turn that asked for it, which auto mode would not prompt for.
export const claudeExternalHook = flag => ({
  PreToolUse: [
    {
      matcher: NATIVE_ACTION_TOOLS.join('|'),
      hooks: [
        {
          type: 'command',
          command: [
            process.execPath,
            fileURLToPath(new URL('./claude-external-hook.mjs', import.meta.url)),
            flag,
          ]
            .map(shellPath)
            .join(' '),
        },
      ],
    },
  ],
});
export function claudePermissionArgs(mode = 'manual', { blockActions = false } = {}) {
  permissionMode(mode);
  // Do not remove --restricted to make bypass work. It is an independent boundary.
  if (mode === 'free') throw new Error(FREE_MODE_BLOCKED);
  const permissions = {
    ...(mode === 'manual' && !blockActions ? { ask: ['Bash', 'Write', 'Edit'] } : {}),
    deny: [...(blockActions ? NATIVE_ACTION_TOOLS : []), ...SUDO_DENY_RULES],
  };
  return [
    '--permission-mode',
    CLAUDE_PERMISSION_MODES[mode],
    '--settings',
    JSON.stringify({ fastMode: false, permissions }),
  ];
}
export function permissionSnapshot(store) {
  return {
    defaultMode: store.data.settings.claudePermissionMode ?? 'manual',
    restricted: true,
    bots: store.data.bots
      .filter(bot => !bot.deletedAt)
      .map(bot => ({
        id: bot.id,
        name: bot.name,
        provider: bot.provider,
        override: bot.claudePermissionMode ?? null,
        ...resolveClaudePermission(bot, store.data.settings),
      })),
  };
}
// Only the authenticated settings route calls this. Bot creation, templates and
// agent tools cannot opt into bypass or confirm a user's dangerous-mode choice.
export function setClaudePermission(store, { botId = null, mode, confirmDangerous = false } = {}) {
  const selected = permissionMode(mode, { inherit: botId !== null });
  const bot = botId !== null ? store.bot(botId) : null;
  if (bot?.deletedAt) throw new Error('Restore this bot before editing it');
  if (
    (selected === 'free' ||
      (bot && selected === null && store.data.settings.claudePermissionMode === 'free')) &&
    confirmDangerous !== true
  )
    throw new Error('Explicit confirmation is required for Free (Dangerous) mode');
  if (
    store.data.jobs.some(
      job =>
        ['running', 'waiting', 'queued'].includes(job.status) && (!bot || job.botId === bot.id),
    )
  )
    throw new Error('Wait for active and queued work to finish before changing permission modes');
  (bot || store.data.settings).claudePermissionMode = selected;
  store.save();
  return permissionSnapshot(store);
}
