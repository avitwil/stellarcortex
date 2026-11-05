export const modelId = model => String(model?.model || model?.id || '');
export function modelChoiceGroups(models = []) {
  const visible = models.filter(model => modelId(model) && !model.hidden);
  if (!visible.some(model => model.selectionKind === 'version' || model.selectionKind === 'alias'))
    return [{ kind: 'models', models: visible }];
  return ['default', 'version', 'alias', 'models']
    .map(kind => ({
      kind,
      models: visible.filter(
        model =>
          (['default', 'version', 'alias'].includes(model.selectionKind)
            ? model.selectionKind
            : 'models') === kind,
      ),
    }))
    .filter(group => group.models.length);
}
export const botModelValues = bot =>
  Object.fromEntries(
    ['model', 'reasoningEffort', 'serviceTier'].map(key => [key, String(bot?.[key] || '')]),
  );
export const PROVIDER_IDS = ['codex', 'claude', 'openai-api', 'anthropic-api', 'local'];
export const isCustomProvider = provider =>
  typeof provider === 'string' && /^custom-[a-z0-9-]{1,80}$/.test(provider);
export const isProviderId = provider =>
  PROVIDER_IDS.includes(provider) || isCustomProvider(provider);
export const botProvider = bot => (isProviderId(bot?.provider) ? bot.provider : 'codex');
export function availableProviderIds(...collections) {
  return [
    ...new Set([
      ...PROVIDER_IDS,
      ...collections
        .flat()
        .map(item => (typeof item === 'string' ? item : item?.provider || item?.id))
        .filter(isProviderId),
    ]),
  ];
}
export function providerModelDefaults(provider, settings = {}, account = {}) {
  return {
    workspaceModel: provider === 'codex' ? settings.model || '' : '',
    defaultModel: account.defaultModel || '',
    defaultModelKnown: account.defaultModelKnown,
  };
}
export function changeBotProvider(bot, provider) {
  if (!isProviderId(provider)) throw new Error('Unknown provider');
  return { provider, ...(botProvider(bot) === provider ? botModelValues(bot) : botModelValues()) };
}
export function botEffortControl(values, context) {
  const effort = values.reasoningEffort || context.model?.defaultReasoningEffort || '';
  const options =
    context.efforts.length && !context.model?.defaultReasoningEffort
      ? [{ reasoningEffort: '' }, ...context.efforts]
      : context.efforts;
  return { effort, options, index: options.findIndex(item => item.reasoningEffort === effort) };
}

export function botModelContext(values, models = [], defaults = {}) {
  const catalog = Array.isArray(models) ? models : [];
  const visible = catalog.filter(model => modelId(model) && !model.hidden);
  const unresolvedDefault =
    !values.model && !defaults.workspaceModel && defaults.defaultModelKnown === false;
  const inheritedId =
    defaults.workspaceModel ||
    defaults.defaultModel ||
    (defaults.defaultModelKnown === false ? '' : modelId(visible.find(model => model.isDefault)));
  const id = values.model || inheritedId;
  const model = catalog.find(item => modelId(item) === id);
  const available = !!model && !model.hidden;
  const efforts = available
    ? (model.supportedReasoningEfforts || [])
        .map(item => (typeof item === 'string' ? { reasoningEffort: item } : item))
        .filter(item => item.reasoningEffort)
    : [];
  const tiers = available
    ? (model.serviceTiers || []).filter(item => item.id && item.id !== 'default')
    : [];
  return { visible, inheritedId, id, model, available, efforts, tiers, unresolvedDefault };
}

export function changeBotModel(values, nextModel, models, defaults) {
  const next = { ...values, model: nextModel },
    reset = [];
  if (values.model === nextModel) return { values: next, reset };
  const context = botModelContext(next, models, defaults);
  if (
    next.reasoningEffort &&
    !context.efforts.some(item => item.reasoningEffort === next.reasoningEffort)
  ) {
    next.reasoningEffort = '';
    reset.push('reasoningEffort');
  }
  if (
    next.serviceTier &&
    next.serviceTier !== 'default' &&
    !context.tiers.some(item => item.id === next.serviceTier)
  ) {
    next.serviceTier = '';
    reset.push('serviceTier');
  }
  return { values: next, reset };
}

// An unrelated profile edit must preserve an older, unavailable configuration.
export function validateBotModelValues(
  values,
  original,
  models,
  defaults,
  { catalogReady = true } = {},
) {
  const keys = ['model', 'reasoningEffort', 'serviceTier'];
  const changed = keys.some(key => (values[key] || '') !== (original[key] || ''));
  if (!changed) return [];
  if (!catalogReady) return ['catalog'];
  const context = botModelContext(values, models, defaults),
    errors = [];
  if (context.unresolvedDefault) errors.push('defaultModel');
  if (values.model && !context.available) errors.push('model');
  if (
    values.reasoningEffort &&
    !context.efforts.some(item => item.reasoningEffort === values.reasoningEffort)
  )
    errors.push('reasoningEffort');
  if (
    values.serviceTier &&
    values.serviceTier !== 'default' &&
    !context.tiers.some(item => item.id === values.serviceTier)
  )
    errors.push('serviceTier');
  return errors;
}
