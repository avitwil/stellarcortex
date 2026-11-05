import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  parseClaudeUsage,
  mergeClaudeRateLimitEvent,
  claudeUsageSnapshot,
  emptyClaudeUsage,
} from '../src/claude-usage.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

const observedAt = '2026-10-26T10:00:00.000Z';
const native = {
  type: 'result',
  local_command: 'usage',
  num_turns: 0,
  total_cost_usd: 0,
  duration_api_ms: 0,
  result:
    "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 2% used · resets Oct 26, 7pm (Asia/Jerusalem)\nCurrent week (all models): 2% used · resets Nov 1, 12pm (Asia/Jerusalem)\n\nWhat's contributing to your limits usage?\nApproximate · sessions on this machine only · shares overlap\n\nLast 24h · 4 requests · 3 sessions\n  Top MCP servers: stellarcortex 92%\nCurrent week (Sonnet): 99% used",
};

test('native Claude usage reports quota percentages and exact reset text without reading contribution estimates', () => {
  const usage = parseClaudeUsage(native, { observedAt });
  assert.equal(usage.available, true);
  assert.equal(usage.source, 'claude-code');
  assert.equal(usage.observedAt, observedAt);
  assert.deepEqual(Object.keys(usage.rateLimitsByLimitId), ['five_hour', 'seven_day']);
  const short = usage.rateLimitsByLimitId.five_hour.primary,
    week = usage.rateLimitsByLimitId.seven_day.primary;
  assert.equal(short.usedPercent, 2);
  assert.equal(week.usedPercent, 2);
  assert.equal(short.windowDurationMins, 300);
  assert.equal(week.windowDurationMins, 10080);
  assert.equal(short.resetsAt, null);
  assert.equal(short.resetText, 'Oct 26, 7pm (Asia/Jerusalem)');
  assert.equal(week.resetText, 'Nov 1, 12pm (Asia/Jerusalem)');
});

test('only a verified local usage command can become a meter; model text and token costs cannot', () => {
  for (const response of [
    { ...native, local_command: undefined },
    { ...native, num_turns: 1 },
    { ...native, is_error: true },
    { type: 'result', num_turns: 0, result: 'Current session: 100% used', total_cost_usd: 0 },
    'not json',
  ]) {
    const usage = parseClaudeUsage(response, { observedAt });
    assert.equal(usage.available, false);
    assert.deepEqual(usage.rateLimitsByLimitId, {});
    assert.ok(usage.error);
  }
  const zero = parseClaudeUsage({ ...native, result: 'Current session: 0% used' }, { observedAt });
  assert.equal(zero.rateLimitsByLimitId.five_hour.primary.usedPercent, 0);
  const unknown = parseClaudeUsage(
    { ...native, result: 'Subscription usage is unavailable' },
    { observedAt },
  );
  assert.equal(unknown.available, false);
});

test('structured usage keeps server order and scoped rows while excluding session dollar estimates and raw data', () => {
  const report = {
    type: 'assistant',
    usage_report: {
      session: { total_cost_usd: 100, model_usage: { input_tokens: 9999 } },
      rate_limits: {
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 12.5,
            resets_at: '2026-10-26T12:00:00Z',
            severity: 'normal',
            is_active: true,
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 30,
            resets_at: null,
            severity: 'warning',
            is_active: false,
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 80,
            resets_at: '2026-11-01T10:00:00Z',
            scope: { model: { display_name: 'Opus' }, surface: { display_name: 'Claude Code' } },
            severity: 'critical',
            is_active: false,
          },
          {
            kind: 'future_kind',
            group: 'future',
            percent: null,
            resets_at: 'not a date',
            secret: 'must-not-survive',
          },
        ],
      },
    },
    secret: 'not for storage',
  };
  const usage = parseClaudeUsage(report, { observedAt }),
    rows = Object.values(usage.rateLimitsByLimitId);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].primary.usedPercent, 12.5);
  assert.equal(rows[0].primary.resetsAt, Date.parse('2026-10-26T12:00:00Z') / 1000);
  assert.equal(rows[2].scope.model.display_name, 'Opus');
  assert.equal(rows[2].severity, 'critical');
  assert.equal(rows[2].primary.usedPercent, 80);
  assert.equal(rows[3].primary.usedPercent, null);
  assert.equal(rows[3].primary.resetsAt, null);
  assert.equal(JSON.stringify(usage).includes('must-not-survive'), false);
  assert.equal(JSON.stringify(usage).includes('total_cost_usd'), false);
  const empty = parseClaudeUsage({ rate_limits: { limits: [] } }, { observedAt });
  assert.equal(empty.available, false);
  assert.equal(empty.emptyMeters, true);
  const missing = parseClaudeUsage({ rate_limits: null }, { observedAt });
  assert.equal(missing.available, false);
  assert.ok(missing.error);
});

test('rate-limit events use documented fractions and retain unknown percent instead of manufacturing zero or full', () => {
  const previous = parseClaudeUsage(native, { observedAt });
  const current = mergeClaudeRateLimitEvent(
    previous,
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        utilization: 0.82,
        rateLimitType: 'five_hour',
        resetsAt: 1793020000,
        accessToken: 'secret',
      },
    },
    { observedAt },
  );
  assert.equal(current.rateLimitsByLimitId.five_hour.primary.usedPercent, 82);
  assert.equal(current.rateLimitsByLimitId.seven_day.primary.usedPercent, 2);
  assert.equal(current.rateLimitsByLimitId.five_hour.primary.status, 'allowed_warning');
  assert.equal(JSON.stringify(current).includes('accessToken'), false);
  const blocked = mergeClaudeRateLimitEvent(
    current,
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rate_limit_type: 'seven_day_opus',
        resets_at: 1793020000,
      },
    },
    { observedAt },
  );
  assert.equal(blocked.rateLimitsByLimitId.seven_day_opus.primary.usedPercent, null);
  assert.equal(blocked.rateLimitsByLimitId.seven_day_opus.primary.status, 'rejected');
  const invalid = mergeClaudeRateLimitEvent(
    null,
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 82 },
    },
    { observedAt },
  );
  assert.equal(invalid.rateLimitsByLimitId.five_hour.primary.usedPercent, null);
  assert.equal(
    mergeClaudeRateLimitEvent(null, {
      type: 'result',
      rate_limit_info: { status: 'allowed', utilization: 1, rateLimitType: 'five_hour' },
    }),
    null,
  );
  assert.equal(
    mergeClaudeRateLimitEvent(null, {
      type: 'rate_limit_event',
      rate_limit_info: { utilization: 1, rateLimitType: 'unknown' },
    }),
    null,
  );
});

test('old or reset quota observations stay explicitly stale and are never reset to invented zero', () => {
  const usage = parseClaudeUsage(native, { observedAt }),
    fresh = claudeUsageSnapshot(usage, { now: Date.parse(observedAt) + 1000 });
  assert.equal(fresh.stale, false);
  const old = claudeUsageSnapshot(usage, { now: Date.parse(observedAt) + 600000 });
  assert.equal(old.stale, true);
  assert.equal(old.rateLimitsByLimitId.five_hour.primary.usedPercent, 2);
  const event = mergeClaudeRateLimitEvent(
    usage,
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.5,
        resetsAt: Date.parse(observedAt) / 1000 + 1,
      },
    },
    { observedAt },
  );
  const expired = claudeUsageSnapshot(event, { now: Date.parse(observedAt) + 2000 });
  assert.equal(expired.stale, true);
  assert.equal(expired.rateLimitsByLimitId.five_hour.primary.expired, true);
  assert.equal(expired.rateLimitsByLimitId.five_hour.primary.usedPercent, 50);
  const failed = claudeUsageSnapshot(fresh, {
    now: Date.parse(observedAt) + 2000,
    error: 'CLI disconnected',
  });
  assert.equal(failed.stale, true);
  assert.equal(failed.error, 'CLI disconnected');
  assert.equal(emptyClaudeUsage().available, false);
  assert.equal(emptyClaudeUsage().observedAt, null);
});

test('Engine persists safe Claude usage independently of active tasks and restores last observation after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-usage-test-')),
    store = new Store(dir);
  class Runtime extends EventEmitter {
    ready = false;
    hydrateUsage(value) {
      this.hydrated = value;
    }
    async stop() {}
  }
  const codex = new Runtime(),
    claude = new Runtime(),
    engine = new Engine(store, codex, { close: async () => {} }, null, { providers: { claude } });
  t.after(async () => {
    await engine.close();
    const relative = path.relative(os.tmpdir(), dir);
    if (!relative.startsWith('stellarcortex-usage-test-') || relative.includes(path.sep))
      throw new Error('Invalid test cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  claude.emit('notification', {
    method: 'account/rateLimits/updated',
    params: { usage: parseClaudeUsage(native, { observedAt }) },
  });
  assert.equal(
    store.data.providerUsage.claude.rateLimitsByLimitId.five_hour.primary.usedPercent,
    2,
  );
  codex.emit('notification', {
    method: 'account/rateLimits/updated',
    params: { usage: { source: 'codex' } },
  });
  const restored = new Store(dir);
  assert.equal(restored.data.providerUsage.claude.source, 'claude-code');
  assert.equal(restored.data.providerUsage.claude.observedAt, observedAt);
  assert.equal(restored.data.jobs.length, 0);
  const restartedClaude = new Runtime(),
    restarted = new Engine(restored, new Runtime(), { close: async () => {} }, null, {
      providers: { claude: restartedClaude },
    });
  assert.equal(restartedClaude.hydrated.observedAt, observedAt);
  await restarted.close();
});
