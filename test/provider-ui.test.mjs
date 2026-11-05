import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botProvider,
  botModelValues,
  botModelContext,
  providerModelDefaults,
  changeBotProvider,
  validateBotModelValues,
  botEffortControl,
  modelChoiceGroups,
} from '../public/bot-models.js';

const codexModels = [
  {
    model: 'gpt-model',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
  },
];
const claudeModels = [
  {
    model: 'sonnet',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
    serviceTiers: [],
  },
];

test('legacy bots stay on Codex and provider changes clear model, effort and speed together', () => {
  const existing = { model: 'gpt-model', reasoningEffort: 'ultra', serviceTier: 'priority' };
  assert.equal(botProvider(existing), 'codex');
  assert.deepEqual(changeBotProvider(existing, 'codex'), { provider: 'codex', ...existing });
  assert.deepEqual(changeBotProvider(existing, 'claude'), {
    provider: 'claude',
    model: '',
    reasoningEffort: '',
    serviceTier: '',
  });
  assert.deepEqual(
    changeBotProvider({ provider: 'claude', model: 'sonnet', reasoningEffort: 'high' }, 'codex'),
    { provider: 'codex', model: '', reasoningEffort: '', serviceTier: '' },
  );
  assert.throws(() => changeBotProvider(existing, 'invalid'), /Unknown provider/);
  assert.equal(existing.model, 'gpt-model');
});

test('Claude inherits only its own catalog and never a Codex workspace model or capabilities', () => {
  const settings = { model: 'gpt-model' },
    empty = botModelValues();
  const claudeDefaults = providerModelDefaults('claude', settings, {
    defaultModel: 'sonnet',
    defaultModelKnown: true,
  });
  const context = botModelContext(empty, claudeModels, claudeDefaults);
  assert.equal(context.id, 'sonnet');
  assert.deepEqual(context.tiers, []);
  assert.deepEqual(
    context.efforts.map(item => item.reasoningEffort),
    ['medium', 'high'],
  );
  assert.equal(
    botModelContext(
      empty,
      codexModels,
      providerModelDefaults('codex', settings, { defaultModel: 'other' }),
    ).id,
    'gpt-model',
  );
  assert.equal(
    botModelContext(
      empty,
      [],
      providerModelDefaults('claude', settings, { defaultModelKnown: false }),
    ).id,
    '',
  );
  assert.deepEqual(
    validateBotModelValues(
      { model: 'sonnet', reasoningEffort: 'ultra', serviceTier: 'priority' },
      empty,
      claudeModels,
      claudeDefaults,
    ),
    ['reasoningEffort', 'serviceTier'],
  );
});

test('unknown provider effort defaults have an Auto slider stop without inventing a selected effort', () => {
  const empty = botModelValues(),
    context = botModelContext(empty, claudeModels, {});
  assert.deepEqual(botEffortControl(empty, context), {
    effort: '',
    index: 0,
    options: [{ reasoningEffort: '' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  });
  assert.equal(botEffortControl({ ...empty, reasoningEffort: 'high' }, context).index, 2);
  const codex = botEffortControl(empty, botModelContext(empty, codexModels, {}));
  assert.equal(codex.effort, 'low');
  assert.deepEqual(
    codex.options.map(item => item.reasoningEffort),
    ['low', 'ultra'],
  );
});

test('model choices separate exact version IDs from rolling families without rewriting saved aliases', () => {
  const models = [
    { model: 'sonnet', selectionKind: 'alias', displayName: 'Claude Sonnet' },
    { model: 'claude-sonnet-5-5', selectionKind: 'version', displayName: 'Claude Sonnet 5.5' },
    { model: 'default', selectionKind: 'default' },
    { model: 'hidden', selectionKind: 'version', hidden: true },
  ];
  assert.deepEqual(
    modelChoiceGroups(models).map(group => ({
      kind: group.kind,
      ids: group.models.map(model => model.model),
    })),
    [
      { kind: 'default', ids: ['default'] },
      { kind: 'version', ids: ['claude-sonnet-5-5'] },
      { kind: 'alias', ids: ['sonnet'] },
    ],
  );
  assert.equal(botModelContext({ model: 'sonnet' }, models, {}).id, 'sonnet');
  assert.equal(
    botModelContext({ model: 'claude-sonnet-5-5' }, models, {}).model.displayName,
    'Claude Sonnet 5.5',
  );
  assert.equal(modelChoiceGroups(codexModels)[0].kind, 'models');
});
