export const BOT_MODEL_FIELDS = ['model', 'reasoningEffort', 'serviceTier'];
export const PROVIDERS = ['codex', 'claude', 'openai-api', 'anthropic-api', 'local'];
export const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude Code',
  'openai-api': 'OpenAI API',
  'anthropic-api': 'Anthropic API',
  local: 'Local engine',
};
export const isCustomProvider = value =>
  typeof value === 'string' && /^custom-[a-z0-9-]{1,80}$/.test(value);
export const isHttpProvider = value =>
  ['openai-api', 'anthropic-api', 'local'].includes(value) || isCustomProvider(value);
export const providerLabel = value =>
  PROVIDER_LABELS[value] || (isCustomProvider(value) ? 'API provider' : String(value));
export function providerOf(value) {
  if (value === undefined) return 'codex';
  if (!PROVIDERS.includes(value) && !isCustomProvider(value))
    throw new Error(
      `provider must be one of: ${PROVIDERS.join(', ')}, or a registered custom connection ID`,
    );
  return value;
}
// Switching runtimes must not carry a model name, effort or speed from the old provider.
export function botModelFields(input, current = null) {
  const provider = providerOf(input.provider === undefined ? current?.provider : input.provider);
  const changed = !!current && provider !== providerOf(current.provider);
  return { provider, ...modelFields(input, { defaults: !current || changed }) };
}
export function modelFields(input, { defaults = false } = {}) {
  const result = {};
  for (const key of BOT_MODEL_FIELDS) {
    if (input[key] === undefined) {
      if (defaults) result[key] = '';
      continue;
    }
    const max = key === 'model' ? 200 : 64;
    if (
      typeof input[key] !== 'string' ||
      input[key].length > max ||
      /[\u0000-\u001f\u007f]/.test(input[key])
    )
      throw new Error(
        `${key} must be text (maximum ${max} characters); use an empty string to inherit`,
      );
    result[key] = input[key].trim();
  }
  return result;
}
export const modelSettingsChanged = (input, current = {}) =>
  BOT_MODEL_FIELDS.some(
    key =>
      input[key] !== undefined && modelFields({ [key]: input[key] })[key] !== (current[key] || ''),
  );
const nameOf = model => model?.model || model?.id;
const errorText = error => error?.message || String(error);
export function resolveModelSettings(bot, settings, catalog = {}) {
  const requested = modelFields(bot, { defaults: true }),
    models = catalog.models || [],
    provider = providerOf(bot.provider),
    label = providerLabel(provider);
  const model =
    requested.model ||
    (provider === 'codex' ? settings.model : '') ||
    catalog.defaultModel ||
    (catalog.defaultModelKnown === false ? null : nameOf(models.find(m => m.isDefault))) ||
    null;
  if (!model && catalog.defaultModelKnown === false)
    throw new Error(
      `The ${label} default model could not be read. Choose a model explicitly or retry when ${label} configuration is available.`,
    );
  const selected = models.find(m => m.id === model || m.model === model);
  if (models.length && !selected)
    throw new Error(
      `Model "${model}" is unavailable in the ${label} model list. Choose an available model for ${bot.name || 'this bot'}.`,
    );
  const reasoningEffort = requested.reasoningEffort || selected?.defaultReasoningEffort || null;
  const serviceTier = requested.serviceTier || selected?.defaultServiceTier || 'default';
  if (selected) {
    const efforts = (selected.supportedReasoningEfforts || []).map(e =>
      typeof e === 'string' ? e : e.reasoningEffort,
    );
    if (reasoningEffort && !efforts.includes(reasoningEffort))
      throw new Error(
        `Model "${model}" does not support reasoning effort "${reasoningEffort}". Choose one of: ${efforts.join(', ') || 'model default'}.`,
      );
    const tiers = (selected.serviceTiers || []).map(t => (typeof t === 'string' ? t : t.id));
    if (serviceTier !== 'default' && !tiers.includes(serviceTier))
      throw new Error(
        `Model "${model}" does not support service tier "${serviceTier}". Choose Standard or an advertised speed.`,
      );
  }
  return {
    model: nameOf(selected) || model,
    reasoningEffort,
    serviceTier,
    requested,
    catalogKnown: !!selected,
  };
}

export class ModelCatalog {
  constructor(runtime, cwd, { ttl = 300000, retry = 15000, provider = 'codex' } = {}) {
    this.runtime = runtime;
    this.cwd = cwd;
    this.provider = providerOf(provider);
    this.label = providerLabel(this.provider);
    this.ttl = ttl;
    this.retry = retry;
    this.generation = 0;
    this.reset();
  }
  snapshot() {
    return {
      models: this.models,
      defaultModel: this.defaultModel,
      defaultModelKnown: this.defaultModelKnown,
      defaultModelError: this.defaultModelError,
      modelsError: this.modelsError,
      modelsStale: !!this.catalogError && !!this.models.length,
    };
  }
  invalidate() {
    this.expires = 0;
  }
  reset() {
    this.generation++;
    this.configurationVersion = this.runtime.configurationVersion ?? null;
    this.models = [];
    this.defaultModel = null;
    this.configuredModel = null;
    this.defaultModelKnown = false;
    this.defaultModelError = null;
    this.catalogError = null;
    this.modelsError = null;
    this.expires = 0;
    this.pending = null;
  }
  async get({ force = false } = {}) {
    if (this.configurationVersion !== (this.runtime.configurationVersion ?? null)) this.reset();
    if (this.pending) return this.pending;
    if (!force && Date.now() < this.expires) return this.snapshot();
    const pending = this.load(this.generation).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
  // For a turn about to start: the list on hand now, refreshed behind it. A first read gets a moment, then the turn goes on without it.
  async quick(wait = 150) {
    if (this.configurationVersion !== (this.runtime.configurationVersion ?? null)) this.reset();
    const known = this.models.length > 0 || this.defaultModelKnown,
      fresh = this.get();
    fresh.catch(() => {});
    if (known) return this.snapshot();
    let timer;
    return Promise.race([
      fresh,
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ ...this.snapshot(), defaultModelKnown: true }), wait);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  async pages() {
    const models = [],
      seen = new Set();
    let cursor;
    for (let page = 0; page < 50; page++) {
      const result = await this.runtime.request(
        'model/list',
        { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
        15000,
      );
      if (!Array.isArray(result.data))
        throw new Error(`${this.label} returned an invalid model catalog`);
      models.push(...result.data);
      if (!result.nextCursor) {
        if (!models.length) throw new Error(`No models are available from ${this.label}`);
        return [...new Map(models.map(m => [nameOf(m), m])).values()];
      }
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor))
        throw new Error(`${this.label} model catalog pagination did not advance`);
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new Error(`${this.label} model catalog exceeded the pagination limit`);
  }
  async load(generation = this.generation) {
    const [models, config] = await Promise.allSettled([
      this.pages(),
      this.runtime.request('config/read', { cwd: this.cwd, includeLayers: false }, 15000),
    ]);
    if (this.configurationVersion !== (this.runtime.configurationVersion ?? null)) this.reset();
    if (generation !== this.generation) return this.get();
    if (models.status === 'fulfilled') {
      this.models = models.value;
      this.catalogError = null;
    } else this.catalogError = errorText(models.reason);
    this.defaultModelKnown = config.status === 'fulfilled';
    this.defaultModelError =
      config.status === 'rejected'
        ? `${this.label} default model unavailable: ${errorText(config.reason)}`
        : null;
    if (this.defaultModelKnown)
      this.configuredModel =
        typeof config.value.config?.model === 'string'
          ? config.value.config.model.trim() || null
          : null;
    this.defaultModel = this.defaultModelKnown
      ? this.configuredModel || nameOf(this.models.find(m => m.isDefault)) || null
      : null;
    this.modelsError =
      [this.catalogError, this.defaultModelError].filter(Boolean).join('; ') || null;
    this.expires = Date.now() + (this.modelsError ? this.retry : this.ttl);
    return this.snapshot();
  }
}
