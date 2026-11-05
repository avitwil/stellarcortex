const SOURCE = 'claude-code';
const statuses = new Set(['allowed', 'allowed_warning', 'rejected']);
const durations = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  overage: null,
};
const labels = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus)',
  seven_day_sonnet: 'Current week (Sonnet)',
  overage: 'Extra usage',
};
const text = value =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 250)
    : null;
const percent = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const timestamp = value =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e11 ? value : null;
const isoTimestamp = value =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? Date.parse(value) / 1000
    : null;
const observation = value =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : new Date().toISOString();
export function emptyClaudeUsage(error = null) {
  return {
    rateLimits: null,
    rateLimitsByLimitId: {},
    available: false,
    observedAt: null,
    source: SOURCE,
    detail: null,
    stale: true,
    error,
  };
}
function snapshot(entries, observedAt, detail, extra = {}) {
  return {
    rateLimits: null,
    rateLimitsByLimitId: Object.fromEntries(entries),
    available: entries.length > 0,
    observedAt: observation(observedAt),
    source: SOURCE,
    detail,
    stale: false,
    error: null,
    ...extra,
  };
}
function entry(
  id,
  name,
  usedPercent,
  {
    resetsAt = null,
    resetText = null,
    status = null,
    windowDurationMins = null,
    observedAt,
    kind = null,
    group = null,
    scope = null,
    severity = null,
    isActive = null,
  } = {},
) {
  return [
    id,
    {
      limitId: id,
      limitName: name,
      primary: { usedPercent, windowDurationMins, resetsAt, resetText, status },
      observedAt: observation(observedAt),
      kind,
      group,
      scope,
      severity,
      isActive,
    },
  ];
}
function scopedLabel(scope) {
  return [scope?.model?.display_name, scope?.surface?.display_name]
    .map(text)
    .filter(Boolean)
    .join(' · ');
}
function structuredReport(report, observedAt) {
  const rows = report.rate_limits?.limits;
  if (!Array.isArray(rows))
    return {
      ...emptyClaudeUsage('Claude Code did not report subscription usage meters.'),
      observedAt: observation(observedAt),
      detail: 'usage-report',
    };
  const entries = [],
    seen = new Map();
  for (const row of rows.slice(0, 50)) {
    if (!row || typeof row !== 'object' || typeof row.kind !== 'string') continue;
    const kind = text(row.kind),
      group = text(row.group),
      scope = {
        model: row.scope?.model ? { display_name: text(row.scope.model.display_name) } : null,
        surface: row.scope?.surface ? { display_name: text(row.scope.surface.display_name) } : null,
      };
    const scopeName = scopedLabel(scope),
      base =
        kind === 'session'
          ? 'five_hour'
          : kind === 'weekly_all'
            ? 'seven_day'
            : `${kind}${scopeName ? `:${scopeName}` : ''}`;
    const number = seen.get(base) || 0;
    seen.set(base, number + 1);
    const key = number ? `${base}:${number}` : base;
    const name =
      kind === 'session'
        ? labels.five_hour
        : kind === 'weekly_all'
          ? labels.seven_day
          : kind === 'weekly_scoped'
            ? `Current week${scopeName ? ` (${scopeName})` : ''}`
            : [group, scopeName || kind].filter(Boolean).join(' · ');
    entries.push(
      entry(key, name, percent(row.percent), {
        resetsAt: isoTimestamp(row.resets_at),
        resetText: text(row.resets_at),
        windowDurationMins:
          kind === 'session' ? 300 : group === 'weekly' || kind.startsWith('weekly') ? 10080 : null,
        observedAt,
        kind,
        group,
        scope,
        severity: text(row.severity),
        isActive: typeof row.is_active === 'boolean' ? row.is_active : null,
      }),
    );
  }
  return snapshot(entries, observedAt, 'usage-report', { emptyMeters: rows.length === 0 });
}

// /usage is a native Claude Code command. Accept its report only when the CLI
// confirms it did not run a model turn. Token totals are never subscription quota.
export function parseClaudeUsage(value, { observedAt = new Date().toISOString() } = {}) {
  let response = value;
  if (typeof value === 'string') {
    try {
      response = JSON.parse(value);
    } catch {
      return emptyClaudeUsage('Claude Code returned an invalid usage report.');
    }
  }
  if (!response || typeof response !== 'object')
    return emptyClaudeUsage('Claude Code returned an invalid usage report.');
  if (response.type === 'assistant' && response.usage_report)
    return structuredReport(response.usage_report, observedAt);
  if (Object.hasOwn(response, 'rate_limits')) return structuredReport(response, observedAt);
  if (response.local_command !== 'usage' || response.num_turns !== 0 || response.is_error === true)
    return emptyClaudeUsage('Claude Code did not return its native /usage report.');
  if (response.usage_report) return structuredReport(response.usage_report, observedAt);
  if (typeof response.result !== 'string')
    return emptyClaudeUsage('Claude Code returned no usage text.');
  const entries = [];
  for (const line of response.result.split(/\r?\n/)) {
    if (/^What[’']s contributing to your limits usage\?/i.test(line.trim())) break;
    const match =
      /^Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*[·•]\s*resets\s+(.+))?\s*$/i.exec(
        line.trim(),
      );
    if (!match) continue;
    const usedPercent = percent(Number(match[3]));
    if (usedPercent === null) continue;
    const weekly = match[1].toLowerCase().startsWith('week'),
      scope = text(match[2]);
    const id = !weekly
      ? 'five_hour'
      : !scope || scope.toLowerCase() === 'all models'
        ? 'seven_day'
        : scope.toLowerCase() === 'opus'
          ? 'seven_day_opus'
          : scope.toLowerCase() === 'sonnet'
            ? 'seven_day_sonnet'
            : `seven_day:${scope}`;
    if (entries.some(([key]) => key === id)) continue;
    entries.push(
      entry(id, labels[id] || `Current week (${scope})`, usedPercent, {
        windowDurationMins: weekly ? 10080 : 300,
        resetText: text(match[4]),
        observedAt,
        kind: weekly ? 'weekly' : 'session',
        group: weekly ? 'weekly' : 'session',
      }),
    );
  }
  if (!entries.length)
    return {
      ...emptyClaudeUsage('Claude Code did not report recognizable subscription usage meters.'),
      observedAt: observation(observedAt),
      detail: 'usage-command',
    };
  return snapshot(entries, observedAt, 'usage-command');
}

// The SDK documents event utilization as a fraction, while /usage percent is
// already 0..100. Keep these paths separate to avoid displaying 2% as 200%.
export function mergeClaudeRateLimitEvent(
  previous,
  message,
  { observedAt = new Date().toISOString() } = {},
) {
  if (message?.type !== 'rate_limit_event') return null;
  const info = message.rate_limit_info || message.rateLimitInfo;
  if (!info || typeof info !== 'object') return null;
  const type = info.rateLimitType ?? info.rate_limit_type;
  if (typeof type !== 'string' || !Object.hasOwn(durations, type)) return null;
  const usedPercent =
    typeof info.utilization === 'number' &&
    Number.isFinite(info.utilization) &&
    info.utilization >= 0 &&
    info.utilization <= 1
      ? info.utilization * 100
      : null;
  const status = statuses.has(info.status) ? info.status : null,
    resetsAt = timestamp(info.resetsAt ?? info.resets_at);
  if (usedPercent === null && !status && !resetsAt) return null;
  const entries = Object.entries(previous?.rateLimitsByLimitId || {})
    .filter(([key]) => key !== type)
    .slice(0, 49);
  entries.push(
    entry(type, labels[type], usedPercent, {
      resetsAt,
      status,
      windowDurationMins: durations[type],
      observedAt,
    }),
  );
  return snapshot(entries, observedAt, 'rate-limit-event');
}

export function claudeUsageSnapshot(
  value,
  { now = Date.now(), maxAgeMs = 300000, error = null } = {},
) {
  if (!value || value.source !== SOURCE) return emptyClaudeUsage(error);
  const observed = Date.parse(value.observedAt),
    entries = Object.entries(value.rateLimitsByLimitId || {})
      .slice(0, 50)
      .map(([key, limit]) => {
        const primary = limit.primary || {},
          resetsAt = timestamp(primary.resetsAt),
          observed = Date.parse(limit.observedAt),
          expired = resetsAt !== null && resetsAt * 1000 <= now;
        return [
          key,
          {
            ...limit,
            stale: expired || !Number.isFinite(observed) || now - observed > maxAgeMs,
            primary: { ...primary, usedPercent: percent(primary.usedPercent), resetsAt, expired },
          },
        ];
      });
  const expired = entries.some(([, limit]) => limit.stale),
    stale =
      !!(error || value.error) ||
      !Number.isFinite(observed) ||
      now - observed > maxAgeMs ||
      expired;
  return {
    ...value,
    rateLimits: null,
    rateLimitsByLimitId: Object.fromEntries(entries),
    available: entries.length > 0,
    stale,
    error: error || value.error || null,
  };
}
