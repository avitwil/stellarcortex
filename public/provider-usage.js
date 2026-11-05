import { isProviderId } from './bot-models.js';

export function latestUsageReport(...reports) {
  const valid = reports.filter(report => report && typeof report === 'object');
  const reset = valid.find(report => report.reset === true);
  if (reset) return reset;
  const scoped = valid.filter(report => Object.hasOwn(report, 'accountKey'));
  // A timestamp cannot establish that two reports belong to the same account.
  // Unscoped legacy reports cannot fill gaps in a newly scoped account either.
  if (new Set(scoped.map(report => report.accountKey)).size > 1) return null;
  return (scoped.length ? scoped : valid).reduce((latest, report) => {
    if (!latest) return report;
    const current = Date.parse(report.observedAt),
      previous = Date.parse(latest.observedAt);
    return Number.isFinite(current) && (!Number.isFinite(previous) || current > previous)
      ? report
      : latest;
  }, null);
}

export function accountUpdateAction(payload = {}) {
  const provider = payload.provider || 'codex';
  if (!isProviderId(provider)) return null;
  return payload.usage && typeof payload.usage === 'object'
    ? { kind: 'usage', provider, usage: payload.usage }
    : { kind: 'identity', provider };
}

export function tokenUsageSummary(report) {
  if (report?.kind !== 'tokens') return null;
  const count = value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const requests = count(report.requests),
    reportedRequests = count(report.reportedRequests),
    tokensReported = reportedRequests !== 0;
  return {
    inputTokens: tokensReported ? count(report.inputTokens) : null,
    outputTokens: tokensReported ? count(report.outputTokens) : null,
    totalTokens: tokensReported ? count(report.totalTokens) : null,
    requests,
    reportedRequests,
    partial: requests !== null && reportedRequests !== null && reportedRequests < requests,
    observedAt: report.observedAt || null,
    scope: report.scope || null,
  };
}

export function reportUsageWindows(report) {
  const entries = Object.entries(report?.rateLimitsByLimitId || {});
  const buckets = entries.length
    ? entries
    : report?.rateLimits
      ? [['usage', report.rateLimits]]
      : [];
  return buckets.flatMap(([id, bucket]) =>
    ['primary', 'secondary'].flatMap(kind => {
      const window = bucket?.[kind];
      if (!window || typeof window !== 'object') return [];
      const value = window.usedPercent;
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim()
            ? Number(value)
            : NaN;
      return [
        {
          id,
          label: bucket.limitName || bucket.name || id,
          kind,
          ...window,
          stale: bucket.stale === true || window.expired === true,
          observedAt: bucket.observedAt || report.observedAt || null,
          usedPercent: Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null,
        },
      ];
    }),
  );
}
