import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionDraft,
  connectionUpdate,
  changeLocalEngine,
  safeConnectionMetadata,
  connectionNeedsSave,
  LOCAL_ENGINE_PRESETS,
  API_PROVIDER_PRESETS,
  newConnectionDraft,
  connectionCreate,
  endpointKeyRequired,
  isConnectionProvider,
  isOpenCodeEndpoint,
} from '../public/provider-connections.js';
import {
  botProvider,
  changeBotProvider,
  providerModelDefaults,
  PROVIDER_IDS,
  availableProviderIds,
  isCustomProvider,
} from '../public/bot-models.js';
import {
  tokenUsageSummary,
  reportUsageWindows,
  accountUpdateAction,
} from '../public/provider-usage.js';

test('API keys never enter non-secret connection drafts or safe UI metadata', () => {
  const source = {
    provider: 'openai-api',
    kind: 'api',
    apiKey: 'secret-value',
    password: 'other-secret',
    hasApiKey: true,
    configured: true,
    defaultModel: 'model-a',
    baseUrl: 'https://api.example/v1',
    keyHint: 'secret-value',
  };
  const draft = connectionDraft(source),
    safe = safeConnectionMetadata(source);
  assert.equal(JSON.stringify(draft).includes('secret'), false);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(safe.hasApiKey, true);
  assert.equal(safe.defaultModel, 'model-a');
  assert.equal(Object.hasOwn(draft, 'apiKey'), false);
  assert.equal(Object.hasOwn(safe, 'apiKey'), false);
});

test('blank password preserves saved key; explicit replacement and removal produce distinct requests', () => {
  const values = {
    defaultModel: ' model-a ',
    baseUrl: 'http://private/v1',
    apiKey: 'must-not-copy',
  };
  assert.deepEqual(connectionUpdate('openai-api', values, ''), { defaultModel: 'model-a' });
  assert.deepEqual(connectionUpdate('anthropic-api', values, ' new-key '), {
    defaultModel: 'model-a',
    apiKey: 'new-key',
  });
  assert.deepEqual(connectionUpdate('openai-api', values, '', { removeApiKey: true }), {
    defaultModel: 'model-a',
    removeApiKey: true,
  });
  assert.throws(
    () => connectionUpdate('openai-api', values, 'new-key', { removeApiKey: true }),
    /either/,
  );
  assert.equal(Object.hasOwn(connectionUpdate('openai-api', values), 'baseUrl'), false);
});

test('all four local presets set their endpoint and preserve independently chosen capabilities', () => {
  for (const preset of LOCAL_ENGINE_PRESETS) {
    const changed = changeLocalEngine(
      {
        baseUrl: 'http://custom/v1',
        defaultModel: 'my-model',
        toolsEnabled: false,
        visionEnabled: true,
      },
      preset.id,
    );
    assert.equal(changed.baseUrl, preset.defaultBaseUrl);
    assert.equal(changed.defaultModel, 'my-model');
    assert.equal(changed.toolsEnabled, false);
    assert.equal(changed.visionEnabled, true);
    assert.equal(connectionUpdate('local', changed).engine, preset.id);
  }
  assert.deepEqual(
    LOCAL_ENGINE_PRESETS.map(engine => engine.id),
    ['ollama', 'lmstudio', 'llamacpp', 'vllm'],
  );
  assert.throws(() => changeLocalEngine({}, 'invalid'), /Unknown/);
});

test('test-connection action detects unsaved keys and endpoint changes before probing saved settings', () => {
  const saved = {
    baseUrl: 'http://127.0.0.1:11434/v1',
    engine: 'ollama',
    defaultModel: 'model-a',
    toolsEnabled: true,
    visionEnabled: false,
  };
  assert.equal(connectionNeedsSave('local', saved, saved), false);
  assert.equal(
    connectionNeedsSave('local', { ...saved, baseUrl: 'http://another/v1' }, saved),
    true,
  );
  assert.equal(connectionNeedsSave('openai-api', saved, saved, 'new-key'), true);
  assert.equal(
    connectionNeedsSave('openai-api', { ...saved, baseUrl: 'http://ignored' }, saved),
    false,
  );
});

test('all HTTP providers reset previous model controls and use their own configured default', () => {
  assert.deepEqual(PROVIDER_IDS, ['codex', 'claude', 'openai-api', 'anthropic-api', 'local']);
  for (const provider of ['openai-api', 'anthropic-api', 'local']) {
    assert.equal(botProvider({ provider }), provider);
    assert.deepEqual(
      changeBotProvider(
        { provider: 'codex', model: 'gpt-old', reasoningEffort: 'ultra', serviceTier: 'priority' },
        provider,
      ),
      { provider, model: '', reasoningEffort: '', serviceTier: '' },
    );
    assert.deepEqual(
      providerModelDefaults(
        provider,
        { model: 'codex-only' },
        { defaultModel: 'endpoint-model', defaultModelKnown: true },
      ),
      { workspaceModel: '', defaultModel: 'endpoint-model', defaultModelKnown: true },
    );
    assert.equal(accountUpdateAction({ provider, usage: { kind: 'tokens' } }).kind, 'usage');
  }
});

test('API/local usage displays only reported counters and never invents a subscription quota', () => {
  const report = {
    kind: 'tokens',
    source: 'api-runtime',
    inputTokens: 125,
    outputTokens: 25,
    totalTokens: 150,
    requests: 2,
    scope: 'this-installation',
    observedAt: '2026-10-26T12:00:00Z',
  };
  assert.deepEqual(tokenUsageSummary(report), {
    inputTokens: 125,
    outputTokens: 25,
    totalTokens: 150,
    requests: 2,
    reportedRequests: null,
    partial: false,
    scope: 'this-installation',
    observedAt: '2026-10-26T12:00:00Z',
  });
  assert.deepEqual(reportUsageWindows(report), []);
  assert.equal(tokenUsageSummary({ kind: 'tokens', inputTokens: null }).inputTokens, null);
  assert.equal(tokenUsageSummary({ kind: 'tokens', outputTokens: NaN }).outputTokens, null);
  assert.equal(tokenUsageSummary({ rateLimits: { primary: { usedPercent: 2 } } }), null);
  const missing = tokenUsageSummary({
    kind: 'tokens',
    requests: 2,
    reportedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.equal(missing.inputTokens, null);
  assert.equal(missing.totalTokens, null);
  assert.equal(missing.requests, 2);
  assert.equal(missing.partial, true);
  const partial = tokenUsageSummary({ ...report, reportedRequests: 1 });
  assert.equal(partial.partial, true);
  assert.equal(partial.totalTokens, 150);
});

test('dynamic provider IDs stay isolated across picker, bot defaults, and usage events', () => {
  const provider = 'custom-nvidia-main',
    second = 'custom-opencode-claude';
  assert.equal(isCustomProvider(provider), true);
  assert.equal(isConnectionProvider(provider), true);
  assert.equal(botProvider({ provider }), provider);
  assert.deepEqual(
    changeBotProvider(
      { provider: 'codex', model: 'gpt-old', reasoningEffort: 'ultra', serviceTier: 'priority' },
      provider,
    ),
    { provider, model: '', reasoningEffort: '', serviceTier: '' },
  );
  assert.deepEqual(
    availableProviderIds(
      [{ provider, name: 'NVIDIA' }],
      [{ id: second }],
      [{ provider }],
      provider,
    ).slice(PROVIDER_IDS.length),
    [provider, second],
  );
  assert.equal(
    providerModelDefaults(provider, { model: 'codex-only' }, { defaultModel: 'nvidia/model' })
      .workspaceModel,
    '',
  );
  assert.equal(accountUpdateAction({ provider, usage: { kind: 'tokens' } }).provider, provider);
  assert.equal(
    botProvider({ provider: 'custom-unavailable-but-saved' }),
    'custom-unavailable-but-saved',
  );
  for (const invalid of [
    'custom-',
    'custom-UPPER',
    'custom-a/b',
    'custom-<script>',
    'custom-' + 'a'.repeat(81),
  ]) {
    assert.equal(isCustomProvider(invalid), false);
    assert.equal(accountUpdateAction({ provider: invalid }), null);
    assert.throws(() => changeBotProvider({}, invalid));
  }
});

test('API presets create discoverable connections without requiring a model ID or retaining the key', () => {
  for (const preset of API_PROVIDER_PRESETS.filter(item => item.id !== 'other')) {
    const draft = newConnectionDraft(preset.id),
      payload = connectionCreate({ ...draft, apiKey: 'ignored-source-secret' }, ' key-from-form ');
    assert.equal(payload.apiKey, 'key-from-form');
    assert.equal(payload.baseUrl, preset.baseUrl);
    assert.equal(payload.protocol, preset.protocol);
    assert.equal(Object.hasOwn(payload, 'defaultModel'), false);
    assert.equal(Object.hasOwn(draft, 'apiKey'), false);
  }
  const other = newConnectionDraft('other');
  assert.equal(other.baseUrl, '');
  assert.equal(other.name, '');
  assert.equal(newConnectionDraft('openai').protocol, 'responses');
  assert.equal(newConnectionDraft('nvidia').protocol, 'chat-completions');
  assert.equal(newConnectionDraft('opencode').baseUrl, 'https://opencode.ai/inference/openai/v1');
  assert.equal(newConnectionDraft('opencode-responses').protocol, 'responses');
  const claude = newConnectionDraft('opencode-anthropic');
  assert.equal(claude.protocol, 'anthropic');
  assert.equal(claude.baseUrl, 'https://opencode.ai/inference/anthropic/v1');
  assert.equal(
    connectionCreate(claude, 'key').modelsUrl,
    'https://opencode.ai/inference/v1/models',
  );
  assert.equal(isOpenCodeEndpoint('https://opencode.ai/inference/openai/v1'), true);
  assert.equal(isOpenCodeEndpoint('https://opencode.ai.example/zen/v1'), false);
});

test('custom connection metadata excludes secrets and destination edits require reentering a saved key', () => {
  const provider = 'custom-example',
    saved = {
      provider,
      name: 'Example',
      protocol: 'anthropic',
      baseUrl: 'https://example.com/v1',
      hasApiKey: true,
      defaultModel: 'claude-test',
      toolsEnabled: true,
      visionEnabled: false,
      apiKey: 'never-retain',
    };
  const safe = safeConnectionMetadata(saved),
    draft = connectionDraft(saved);
  assert.equal(safe.name, 'Example');
  assert.equal(safe.protocol, 'anthropic');
  assert.equal(JSON.stringify(safe).includes('never-retain'), false);
  assert.equal(endpointKeyRequired(provider, draft, saved), false);
  const changed = { ...draft, baseUrl: 'https://new.example.com/v1' };
  assert.equal(endpointKeyRequired(provider, changed, saved), true);
  assert.equal(endpointKeyRequired(provider, changed, saved, 'replacement'), false);
  assert.equal(
    endpointKeyRequired(provider, { ...draft, baseUrl: draft.baseUrl + '/' }, saved),
    false,
  );
  const payload = connectionUpdate(provider, changed, 'replacement');
  assert.equal(payload.name, 'Example');
  assert.equal(payload.protocol, 'anthropic');
  assert.equal(payload.apiKey, 'replacement');
  assert.equal(connectionNeedsSave(provider, changed, saved), true);
  assert.equal(Object.hasOwn(connectionUpdate(provider, draft), 'apiKey'), false);
});
