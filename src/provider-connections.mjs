import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { metadataHost } from './browser.mjs';

export const HTTP_PROVIDERS = ['openai-api', 'anthropic-api', 'local'];
export const LOCAL_ENGINES = [
  { id: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'llamacpp', label: 'llama.cpp', defaultBaseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'lmstudio', label: 'LM Studio', defaultBaseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'vllm', label: 'vLLM', defaultBaseUrl: 'http://127.0.0.1:8000/v1' },
];
export const CONNECTION_NAMES = {
  'openai-api': 'OpenAI API',
  'anthropic-api': 'Claude API',
  local: 'Local model',
};
export const API_PROTOCOLS = ['chat-completions', 'responses', 'anthropic'];
export const API_PRESETS = [
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
  { id: 'custom', label: 'Other provider', baseUrl: '', protocol: 'chat-completions' },
];
const isCustom = provider =>
  typeof provider === 'string' && /^custom-[a-z0-9-]{1,80}$/.test(provider);
const cloudUrls = {
  'openai-api': 'https://api.openai.com/v1',
  'anthropic-api': 'https://api.anthropic.com/v1',
};
const defaults = provider => ({
  provider,
  baseUrl: isCustom(provider) ? '' : cloudUrls[provider] || LOCAL_ENGINES[0].defaultBaseUrl,
  engine: provider === 'local' ? 'ollama' : null,
  apiKey: '',
  defaultModel: '',
  toolsEnabled: true,
  visionEnabled: !isCustom(provider) && provider !== 'local',
  enabled: false,
  revision: 'initial',
  ...(isCustom(provider)
    ? { name: 'API provider', protocol: 'chat-completions', modelsUrl: '' }
    : {}),
});
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 1000 || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error('Enter a valid model server URL, including http:// or https://');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid model server URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Model server URL must use HTTP(S) without credentials, query parameters or fragments',
    );
  if (metadataHost(url.hostname))
    throw new Error('Cloud metadata endpoints cannot be model servers');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  if (/\/(?:chat\/completions|responses|models|messages)$/.test(url.pathname))
    throw new Error(
      'Enter the API base URL from the provider documentation, not a specific operation URL',
    );
  return url.toString().replace(/\/+$/, '');
}
export function normalizeModelsUrl(value, baseUrl) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1000 || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error('Enter a valid model-list URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid model-list URL');
  }
  if (
    url.origin !== new URL(baseUrl).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Model-list URL must use the same origin as the API URL, without credentials, query parameters or fragments',
    );
  return url.toString();
}

// Secrets live outside workspace/state/templates. Encryption prevents accidental
// disclosure in a config-only copy; the OS account must also protect the key file.
export class ProviderConnections {
  constructor(dataDir) {
    this.dir = path.join(path.resolve(dataDir), 'private');
    this.file = path.join(this.dir, 'provider-connections.enc');
    this.keyFile = path.join(this.dir, 'provider-connections.key');
    this.data = Object.fromEntries(HTTP_PROVIDERS.map(provider => [provider, defaults(provider)]));
    if (fs.existsSync(this.file)) {
      try {
        const key = fs.readFileSync(this.keyFile),
          envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (key.length !== 32 || envelope.version !== 1) throw new Error('Invalid envelope');
        const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const stored = JSON.parse(
          Buffer.concat([
            cipher.update(Buffer.from(envelope.data, 'base64')),
            cipher.final(),
          ]).toString('utf8'),
        );
        for (const provider of Object.keys(stored)) {
          if (!HTTP_PROVIDERS.includes(provider) && !isCustom(provider))
            throw new Error('Invalid saved provider');
          if (
            isCustom(provider) &&
            (!API_PROTOCOLS.includes(stored[provider].protocol) ||
              typeof stored[provider].name !== 'string')
          )
            throw new Error('Invalid saved API connection');
          this.data[provider] = {
            ...defaults(provider),
            ...stored[provider],
            provider,
            baseUrl: cloudUrls[provider] || normalizeBaseUrl(stored[provider].baseUrl),
          };
          if (isCustom(provider))
            this.data[provider].modelsUrl = normalizeModelsUrl(
              stored[provider].modelsUrl || '',
              this.data[provider].baseUrl,
            );
        }
      } catch {
        throw new Error(
          'Saved provider connections could not be decrypted. Restore both private connection files from the same backup.',
        );
      }
    }
  }
  ids() {
    return Object.keys(this.data);
  }
  has(provider) {
    return Object.hasOwn(this.data, provider);
  }
  get(provider) {
    if (!this.has(provider)) throw new Error('Unknown API or local provider');
    const value = this.data[provider];
    return { ...value, configured: provider === 'local' ? value.enabled : !!value.apiKey };
  }
  public(provider) {
    const { apiKey, enabled, ...value } = this.get(provider);
    return {
      ...value,
      name: isCustom(provider) ? value.name : CONNECTION_NAMES[provider],
      kind: provider === 'local' ? 'local' : 'api',
      hasApiKey: !!apiKey,
    };
  }
  list() {
    return {
      connections: this.ids().map(provider => this.public(provider)),
      localEngines: LOCAL_ENGINES,
      apiPresets: API_PRESETS,
    };
  }
  create(input) {
    if (this.ids().filter(isCustom).length >= 50)
      throw new Error('This installation supports up to 50 custom API connections');
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !input.apiKey ||
      !input.baseUrl ||
      !input.name
    )
      throw new Error('Enter the provider name, API base URL and API key');
    const provider = `custom-${randomUUID()}`;
    return this.applyUpdate(provider, input, defaults(provider));
  }
  update(provider, input) {
    if (!this.has(provider)) throw new Error('Unknown API or local provider');
    return this.applyUpdate(provider, input, this.data[provider]);
  }
  applyUpdate(provider, input, current) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Connection settings must be an object');
    const allowed = new Set([
      'apiKey',
      'removeApiKey',
      'baseUrl',
      'engine',
      'defaultModel',
      'toolsEnabled',
      'visionEnabled',
    ]);
    if (isCustom(provider)) {
      allowed.add('name');
      allowed.add('protocol');
      allowed.add('modelsUrl');
    }
    if (Object.keys(input).some(key => !allowed.has(key)))
      throw new Error('Unsupported connection setting');
    const next = { ...current };
    if ('name' in input) {
      if (
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.trim().length > 80 ||
        /[\u0000-\u001f\u007f]/.test(input.name)
      )
        throw new Error('Provider name must contain 1–80 characters');
      next.name = input.name.trim();
    }
    if ('protocol' in input) {
      if (!API_PROTOCOLS.includes(input.protocol))
        throw new Error('Choose Chat Completions, Responses or Anthropic Messages');
      next.protocol = input.protocol;
    }
    if ('engine' in input) {
      if (provider !== 'local' || !LOCAL_ENGINES.some(engine => engine.id === input.engine))
        throw new Error('Choose Ollama, llama.cpp, LM Studio or vLLM');
      if (next.engine !== input.engine && !('baseUrl' in input))
        next.baseUrl = LOCAL_ENGINES.find(engine => engine.id === input.engine).defaultBaseUrl;
      next.engine = input.engine;
    }
    if ('baseUrl' in input) {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      if (provider !== 'local' && !isCustom(provider) && baseUrl !== cloudUrls[provider])
        throw new Error('Cloud API keys can only be sent to the official provider endpoint');
      if (
        isCustom(provider) &&
        current.apiKey &&
        baseUrl !== current.baseUrl &&
        !input.apiKey &&
        !input.removeApiKey
      )
        throw new Error(
          'Re-enter the API key when changing the server URL; the saved key will not be sent to a new endpoint',
        );
      next.baseUrl = baseUrl;
    }
    if (isCustom(provider))
      next.modelsUrl = normalizeModelsUrl(
        'modelsUrl' in input ? input.modelsUrl : next.modelsUrl || '',
        next.baseUrl,
      );
    if ('apiKey' in input) {
      if (
        typeof input.apiKey !== 'string' ||
        input.apiKey.length > 4096 ||
        /[\u0000-\u0020\u007f]/.test(input.apiKey)
      )
        throw new Error('API key must be a single token without whitespace');
      if (input.apiKey) next.apiKey = input.apiKey;
    }
    if ('removeApiKey' in input && typeof input.removeApiKey !== 'boolean')
      throw new Error('removeApiKey must be true or false');
    if (input.removeApiKey) {
      if (input.apiKey) throw new Error('Cannot replace and remove the key together');
      next.apiKey = '';
    }
    if ('defaultModel' in input) {
      if (
        typeof input.defaultModel !== 'string' ||
        input.defaultModel.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(input.defaultModel)
      )
        throw new Error('Model ID must be text, at most 200 characters');
      next.defaultModel = input.defaultModel.trim();
    }
    for (const field of ['toolsEnabled', 'visionEnabled'])
      if (field in input) {
        if (typeof input[field] !== 'boolean') throw new Error(`${field} must be true or false`);
        next[field] = input[field];
      }
    next.enabled = true;
    next.revision = randomUUID();
    const updated = { ...this.data, [provider]: next };
    this.save(updated);
    this.data = updated;
    return this.public(provider);
  }
  save(data) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.keyFile))
      fs.writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const key = fs.readFileSync(this.keyFile);
    if (key.length !== 32) throw new Error('Invalid provider encryption key');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const payload = JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    });
    const temp = path.join(this.dir, `connections-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
}
