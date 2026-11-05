import { isCustomProvider } from './bot-models.js';
export const CONNECTION_PROVIDER_IDS = ['openai-api', 'anthropic-api', 'local'];
export const isConnectionProvider = provider =>
  CONNECTION_PROVIDER_IDS.includes(provider) || isCustomProvider(provider);
export const API_PROTOCOLS = ['chat-completions', 'responses', 'anthropic'];
export function isOpenCodeEndpoint(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'opencode.ai';
  } catch {
    return false;
  }
}
export const API_PROVIDER_PRESETS = [
  {
    id: 'nvidia',
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    protocol: 'chat-completions',
  },
  {
    id: 'opencode',
    label: 'OpenCode · Chat Completions',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    modelsUrl: 'https://opencode.ai/inference/v1/models',
    protocol: 'chat-completions',
  },
  {
    id: 'opencode-responses',
    label: 'OpenCode · GPT / Responses',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    modelsUrl: 'https://opencode.ai/inference/v1/models',
    protocol: 'responses',
  },
  {
    id: 'opencode-anthropic',
    label: 'OpenCode · Claude / Messages',
    baseUrl: 'https://opencode.ai/inference/anthropic/v1',
    modelsUrl: 'https://opencode.ai/inference/v1/models',
    protocol: 'anthropic',
  },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' },
  { id: 'other', label: 'Other', baseUrl: '', protocol: 'chat-completions' },
];
export const LOCAL_ENGINE_PRESETS = [
  { id: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', defaultBaseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', label: 'llama.cpp', defaultBaseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', label: 'vLLM', defaultBaseUrl: 'http://127.0.0.1:8000/v1' },
];

// Only these non-secret fields can enter a UI draft. Password inputs remain in
// the form until submission and are never copied to this object or storage.
export function connectionDraft(connection = {}) {
  return {
    name: typeof connection.name === 'string' ? connection.name : '',
    baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl : '',
    modelsUrl: typeof connection.modelsUrl === 'string' ? connection.modelsUrl : '',
    protocol: API_PROTOCOLS.includes(connection.protocol)
      ? connection.protocol
      : 'chat-completions',
    engine: typeof connection.engine === 'string' ? connection.engine : 'ollama',
    defaultModel: typeof connection.defaultModel === 'string' ? connection.defaultModel : '',
    toolsEnabled: connection.toolsEnabled !== false,
    visionEnabled: connection.visionEnabled === true,
  };
}
export function safeConnectionMetadata(connection = {}) {
  return {
    provider: connection.provider,
    name: connection.name,
    kind: connection.kind,
    ...connectionDraft(connection),
    hasApiKey: connection.hasApiKey === true,
    configured: connection.configured === true,
    revision: connection.revision,
  };
}

export function connectionUpdate(provider, values, apiKey = '', { removeApiKey = false } = {}) {
  if (!isConnectionProvider(provider)) throw new Error('Unknown connection provider');
  const draft = connectionDraft(values),
    payload = { defaultModel: draft.defaultModel.trim() };
  if (provider === 'local')
    Object.assign(payload, {
      baseUrl: draft.baseUrl.trim(),
      engine: draft.engine,
      toolsEnabled: draft.toolsEnabled,
      visionEnabled: draft.visionEnabled,
    });
  if (isCustomProvider(provider))
    Object.assign(payload, {
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      modelsUrl: draft.modelsUrl.trim(),
      protocol: draft.protocol,
      toolsEnabled: draft.toolsEnabled,
      visionEnabled: draft.visionEnabled,
    });
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (removeApiKey && key) throw new Error('Choose either a replacement key or key removal');
  if (removeApiKey) payload.removeApiKey = true;
  else if (key) payload.apiKey = key;
  return payload;
}

export function newConnectionDraft(presetId = 'nvidia', presets = API_PROVIDER_PRESETS) {
  const preset = presets.find(item => item.id === presetId);
  if (!preset) throw new Error('Unknown API preset');
  return connectionDraft({
    name: preset.id === 'other' ? '' : preset.label,
    baseUrl: preset.baseUrl,
    modelsUrl: preset.modelsUrl,
    protocol: preset.protocol,
  });
}
export function connectionCreate(values, apiKey = '') {
  const draft = connectionDraft(values),
    payload = {
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      protocol: draft.protocol,
      toolsEnabled: draft.toolsEnabled,
      visionEnabled: draft.visionEnabled,
      apiKey: String(apiKey || '').trim(),
    };
  if (draft.defaultModel.trim()) payload.defaultModel = draft.defaultModel.trim();
  if (draft.modelsUrl.trim()) payload.modelsUrl = draft.modelsUrl.trim();
  return payload;
}
export function endpointKeyRequired(provider, values, saved, apiKey = '') {
  const normalize = url =>
    String(url || '')
      .trim()
      .replace(/\/+$/, '');
  return (
    isCustomProvider(provider) &&
    saved?.hasApiKey === true &&
    normalize(values?.baseUrl) !== normalize(saved.baseUrl) &&
    !String(apiKey || '').trim()
  );
}

export function changeLocalEngine(values, engine, presets = LOCAL_ENGINE_PRESETS) {
  const preset = presets.find(item => item.id === engine);
  if (!preset) throw new Error('Unknown local engine');
  return { ...connectionDraft(values), engine, baseUrl: preset.defaultBaseUrl };
}
export function connectionNeedsSave(provider, values, saved, apiKey = '') {
  return (
    !!String(apiKey || '').trim() ||
    JSON.stringify(connectionUpdate(provider, values)) !==
      JSON.stringify(connectionUpdate(provider, connectionDraft(saved)))
  );
}
