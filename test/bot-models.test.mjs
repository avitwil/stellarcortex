import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botModelValues,
  botModelContext,
  changeBotModel,
  validateBotModelValues,
} from '../public/bot-models.js';

const models = [
  {
    model: 'deep',
    displayName: 'Deep',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
  },
  { model: 'quick', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], serviceTiers: [] },
  { model: 'hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
];
test('bot model choices inherit workspace then configured Codex then catalog default without inventing options', () => {
  const empty = botModelValues();
  assert.equal(
    botModelContext(empty, models, { workspaceModel: 'quick', defaultModel: 'deep' }).id,
    'quick',
  );
  assert.equal(botModelContext(empty, models, { defaultModel: 'quick' }).id, 'quick');
  assert.equal(botModelContext(empty, models).id, 'deep');
  assert.equal(
    botModelContext({ ...empty, model: 'deep' }, models, { workspaceModel: 'quick' }).id,
    'deep',
  );
  assert.deepEqual(
    botModelContext(empty, models).visible.map(model => model.model),
    ['deep', 'quick'],
  );
  assert.deepEqual(botModelContext({ ...empty, model: 'quick' }, models).tiers, []);
  assert.equal(botModelContext(empty, models, { defaultModelKnown: false }).id, '');
  assert.equal(
    botModelContext(empty, models, { workspaceModel: 'quick', defaultModelKnown: false }).id,
    'quick',
  );
  assert.deepEqual(
    validateBotModelValues({ model: 'deep', reasoningEffort: '', serviceTier: '' }, empty, models, {
      defaultModelKnown: false,
    }),
    [],
  );
  assert.deepEqual(
    validateBotModelValues(empty, { ...empty, model: 'deep' }, models, {
      defaultModelKnown: false,
    }),
    ['defaultModel'],
  );
});
test('changing model resets unsupported effort and speed, retaining supported explicit choices', () => {
  const original = { model: 'deep', reasoningEffort: 'ultra', serviceTier: 'priority' };
  assert.deepEqual(changeBotModel(original, 'quick', models), {
    values: { model: 'quick', reasoningEffort: '', serviceTier: '' },
    reset: ['reasoningEffort', 'serviceTier'],
  });
  assert.deepEqual(
    changeBotModel(
      { model: 'deep', reasoningEffort: 'low', serviceTier: 'default' },
      'quick',
      models,
    ).values,
    { model: 'quick', reasoningEffort: 'low', serviceTier: 'default' },
  );
  assert.deepEqual(original, { model: 'deep', reasoningEffort: 'ultra', serviceTier: 'priority' });
});
test('unavailable saved values survive profile edits while new unsupported settings and unloaded catalogs are blocked', () => {
  const stale = { model: 'retired', reasoningEffort: 'old', serviceTier: 'retired-tier' };
  assert.deepEqual(validateBotModelValues(stale, stale, [], {}, { catalogReady: false }), []);
  assert.deepEqual(validateBotModelValues(stale, botModelValues(), models, {}), [
    'model',
    'reasoningEffort',
    'serviceTier',
  ]);
  assert.deepEqual(
    validateBotModelValues(
      { model: 'hidden', reasoningEffort: '', serviceTier: '' },
      botModelValues(),
      models,
      {},
    ),
    ['model'],
  );
  assert.deepEqual(
    validateBotModelValues(
      { model: 'deep', reasoningEffort: 'low', serviceTier: 'priority' },
      botModelValues(),
      models,
      {},
    ),
    [],
  );
  assert.deepEqual(
    validateBotModelValues(
      { model: 'deep', reasoningEffort: 'low', serviceTier: 'priority' },
      botModelValues(),
      models,
      {},
      { catalogReady: false },
    ),
    ['catalog'],
  );
  assert.deepEqual(validateBotModelValues(botModelValues(), stale, models, {}), []);
});
