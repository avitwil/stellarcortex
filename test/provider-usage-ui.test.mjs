import test from 'node:test';
import assert from 'node:assert/strict';
import {
  latestUsageReport,
  reportUsageWindows,
  accountUpdateAction,
} from '../public/provider-usage.js';

test('unknown quota percentages stay unknown while exact percentages and reset text survive', () => {
  const report = {
    rateLimitsByLimitId: {
      five_hour: {
        limitName: 'Current session',
        primary: {
          usedPercent: 2,
          windowDurationMins: 300,
          resetsAt: null,
          resetText: 'Oct 26, 7pm (Asia/Jerusalem)',
        },
      },
      seven_day: {
        primary: { usedPercent: null, windowDurationMins: 10080, status: 'allowed_warning' },
      },
      blank: { primary: { usedPercent: '' } },
      missing: { primary: { resetsAt: 1700000000 } },
    },
  };
  const windows = reportUsageWindows(report);
  assert.equal(windows[0].usedPercent, 2);
  assert.equal(windows[0].resetText, 'Oct 26, 7pm (Asia/Jerusalem)');
  assert.equal(windows[0].resetsAt, null);
  assert.deepEqual(
    windows.slice(1).map(window => window.usedPercent),
    [null, null, null],
  );
  assert.equal(windows[1].status, 'allowed_warning');
  assert.deepEqual(reportUsageWindows(null), []);
});

test('newer persisted provider usage wins over an older account response and equal-time failure retains stale metadata', () => {
  const old = {
      observedAt: '2026-10-26T10:00:00Z',
      source: 'claude-code',
      rateLimitsByLimitId: {},
    },
    current = { observedAt: '2026-10-26T10:05:00Z', source: 'claude-code', available: true };
  assert.equal(latestUsageReport(old, current), current);
  assert.equal(latestUsageReport(current, old), current);
  assert.equal(latestUsageReport(null, old), old);
  const failed = { ...current, stale: true, error: 'Unavailable' };
  assert.equal(latestUsageReport(failed, current), failed);
  assert.equal(latestUsageReport({ available: false }, current), current);
  assert.equal(latestUsageReport(null, undefined), null);
});

test('Codex fallback windows remain compatible and ratios are not guessed from percentages', () => {
  const report = {
    rateLimits: {
      primary: { usedPercent: 0.5, windowDurationMins: 300 },
      secondary: { usedPercent: '25', windowDurationMins: 10080 },
    },
  };
  assert.deepEqual(
    reportUsageWindows(report).map(window => window.usedPercent),
    [0.5, 25],
  );
  assert.equal(
    reportUsageWindows({ rateLimits: { primary: { usedPercent: NaN } } })[0].usedPercent,
    null,
  );
});

test('account clear and scope changes cannot revive an earlier account quota by timestamp', () => {
  const previous = { accountKey: 'account-a', observedAt: '2026-10-26T11:00:00Z', available: true };
  const cleared = {
    accountKey: 'account-b',
    reset: true,
    observedAt: null,
    available: false,
    rateLimitsByLimitId: {},
  };
  assert.equal(latestUsageReport(cleared, previous), cleared);
  assert.equal(latestUsageReport(previous, cleared), cleared);
  assert.equal(latestUsageReport({ accountKey: 'account-b', observedAt: null }, previous), null);
  const unscoped = { observedAt: '2026-10-26T12:00:00Z', available: true };
  const fresh = { accountKey: 'account-b', observedAt: '2026-10-26T11:30:00Z', available: true };
  assert.equal(latestUsageReport(fresh, unscoped), fresh);
  const logout = { accountKey: null, reset: true, available: false };
  assert.equal(latestUsageReport(logout, fresh), logout);
});

test('Claude usage events update quota directly while identity events route to their matching provider', () => {
  const usage = { accountKey: 'account-b', reset: true, available: false };
  assert.deepEqual(accountUpdateAction({ provider: 'claude', usage }), {
    kind: 'usage',
    provider: 'claude',
    usage,
  });
  assert.deepEqual(accountUpdateAction({ provider: 'claude' }), {
    kind: 'identity',
    provider: 'claude',
  });
  assert.deepEqual(accountUpdateAction({}), { kind: 'identity', provider: 'codex' });
  assert.equal(accountUpdateAction({ provider: 'unknown', usage }), null);
});

test('each usage window retains stale and expired state independently', () => {
  const windows = reportUsageWindows({
    observedAt: '2026-10-26T12:00:00Z',
    rateLimitsByLimitId: {
      five_hour: { stale: true, observedAt: '2026-10-26T10:00:00Z', primary: { usedPercent: 2 } },
      seven_day: { stale: false, primary: { usedPercent: 5 } },
      expired: { primary: { usedPercent: 40, expired: true } },
    },
  });
  assert.deepEqual(
    windows.map(window => window.stale),
    [true, false, true],
  );
  assert.equal(windows[0].observedAt, '2026-10-26T10:00:00Z');
  assert.equal(windows[1].observedAt, '2026-10-26T12:00:00Z');
});
