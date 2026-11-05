import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { isCustomProvider, isHttpProvider, providerLabel } from './models.mjs';
import { connectionUrl } from './browser.mjs';

const engines = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
const protocols = new Set(['chat-completions', 'responses', 'anthropic']);
const uuid = /^[0-9a-f-]{36}$/i;
const MAX_STREAM = 24 * 1024 * 1024,
  MAX_SESSION = 48 * 1024 * 1024,
  MAX_TEXT = 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const clone = value => structuredClone(value);
const safeModel = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const jsonText = value => (typeof value === 'string' ? value : JSON.stringify(value));
export function redactProviderError(value, secrets = []) {
  let text = String(value?.message || value || 'Provider request failed');
  for (const secret of secrets)
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  return text
    .replace(/\b(?:sk-|sk-ant-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s/]+:[^\s@]+@/gi, '[redacted-url]')
    .slice(0, 1500);
}
export function httpModelEfforts(provider, model) {
  if (provider === 'local' || isCustomProvider(provider)) return [];
  if (provider === 'openai-api') {
    if (/^gpt-(?:6-astra|6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(model))
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-6-(?:sol|luna)(?:-\d{4}-\d{2}-\d{2})?$/.test(model))
      return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    return [];
  }
  if (
    /^claude-(?:(?:opus|sonnet)-5(?:-5)?|haiku-5-5|opus-4-[78]|(?:fable|mythos)-5(?:-1)?)(?:-\d{8})?$/.test(
      model,
    )
  )
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^claude-(?:opus|sonnet)-4-6(?:-\d{8})?$/.test(model))
    return ['low', 'medium', 'high', 'max'];
  return [];
}
async function boundedText(response, limit) {
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Provider response exceeded its size limit');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

// SSE parsing is independent of network chunk boundaries and CRLF framing.
export async function* providerEvents(response, signal) {
  if (!response.body) throw new Error('The provider returned no response stream');
  const decoder = new TextDecoder();
  let buffer = '',
    data = [],
    event = '',
    bytes = 0;
  const packet = () => {
    const result = { event, data: data.join('\n') };
    data = [];
    event = '';
    return result;
  };
  for await (const chunk of response.body) {
    if (signal?.aborted) throw signal.reason || new Error('Request cancelled');
    bytes += chunk.length;
    if (bytes > MAX_STREAM) throw new Error('Provider response exceeded the stream limit');
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 4 * 1024 * 1024)
      throw new Error('Provider stream event exceeded the size limit');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) {
        if (data.length) yield packet();
        else event = '';
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
  if (data.length) yield packet();
}

export class HttpProvider extends EventEmitter {
  constructor({
    provider,
    getConfig,
    dataDir,
    fetchImpl = fetch,
    maxRounds = 12,
    requestTimeoutMs = 180000,
    toolTimeoutMs = 610000,
  } = {}) {
    super();
    if (!isHttpProvider(provider)) throw new Error('Unknown HTTP provider');
    if (typeof getConfig !== 'function' || !dataDir)
      throw new Error('HTTP provider configuration is required');
    this.provider = provider;
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.maxRounds = Math.min(24, Math.max(1, maxRounds));
    this.requestTimeoutMs = requestTimeoutMs;
    this.toolTimeoutMs = toolTimeoutMs;
    this.ready = false;
    this.installed = true;
    this.threads = new Map();
    this.turns = new Map();
    this.pending = new Map();
    this.usageRecords = new Map();
    this.lastAccountKey = null;
    this.dir = path.resolve(dataDir, 'provider-sessions', provider);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  config() {
    const raw = this.getConfig() || {},
      apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '',
      engine = raw.engine || 'ollama';
    const custom = isCustomProvider(this.provider),
      protocol = custom
        ? raw.protocol || 'chat-completions'
        : this.provider === 'openai-api'
          ? 'responses'
          : this.provider === 'anthropic-api'
            ? 'anthropic'
            : 'chat-completions';
    if (!protocols.has(protocol))
      throw new Error('Choose Chat Completions, Responses, or Anthropic Messages protocol');
    let baseUrl =
      this.provider === 'openai-api'
        ? 'https://api.openai.com/v1'
        : this.provider === 'anthropic-api'
          ? 'https://api.anthropic.com/v1'
          : raw.baseUrl;
    if (this.provider === 'local' && !engines.has(engine))
      throw new Error('Choose Ollama, LM Studio, llama.cpp, or vLLM');
    if (baseUrl) {
      let url;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new Error('Enter a valid model server URL');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Model server URL must be HTTP(S), without credentials, query, or fragment',
        );
      baseUrl = url.href.replace(/\/+$/, '');
    }
    let modelsUrl = '';
    if (raw.modelsUrl) {
      let catalog;
      try {
        catalog = new URL(raw.modelsUrl);
      } catch {
        throw new Error('Enter an absolute model catalog URL');
      }
      if (
        !['http:', 'https:'].includes(catalog.protocol) ||
        catalog.username ||
        catalog.password ||
        catalog.search ||
        catalog.hash
      )
        throw new Error(
          'Model catalog URL must be HTTP(S), without credentials, query, or fragment',
        );
      if (!baseUrl || catalog.origin !== new URL(baseUrl).origin)
        throw new Error('Model catalog URL must use the same origin as the API server');
      modelsUrl = catalog.href;
    }
    const configured =
        raw.enabled !== false &&
        (this.provider === 'local' ? !!baseUrl : custom ? !!baseUrl && !!apiKey : !!apiKey),
      binding = hash(
        JSON.stringify(
          custom
            ? [this.provider, baseUrl || '', apiKey, protocol]
            : [this.provider, baseUrl || '', apiKey, engine],
        ),
      );
    return {
      apiKey,
      baseUrl,
      modelsUrl,
      engine,
      protocol,
      configured,
      binding,
      revision: typeof raw.revision === 'string' ? raw.revision : binding,
      defaultModel: safeModel(raw.defaultModel) ? raw.defaultModel : null,
      toolsEnabled: raw.toolsEnabled !== false,
      visionEnabled: raw.visionEnabled === true,
    };
  }
  get displayName() {
    try {
      const raw = this.getConfig() || {},
        name = raw.name ?? raw.displayName;
      return typeof name === 'string' && name.trim()
        ? name
            .trim()
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .slice(0, 100)
        : providerLabel(this.provider);
    } catch {
      return providerLabel(this.provider);
    }
  }
  get configurationVersion() {
    try {
      return this.config().revision;
    } catch {
      return 'invalid';
    }
  }
  configurationChanged() {
    this.lastAccountKey = null;
    const config = this.config();
    this.notify('account/updated', { provider: this.provider });
    this.notify('account/rateLimits/updated', { usage: { ...this.usage(config), reset: true } });
  }
  async start() {
    this.ready = true;
  }
  notify(method, params) {
    this.emit('notification', { method, params });
  }
  error(error, config) {
    return new Error(redactProviderError(error, [config?.apiKey]));
  }
  headers(config) {
    return config.protocol === 'anthropic'
      ? {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        };
  }
  async http(
    config,
    route,
    { method = 'GET', body, signal, timeout = this.requestTimeoutMs } = {},
  ) {
    if (!config.configured)
      throw new Error(
        this.provider === 'local'
          ? 'Configure and enable an existing local model server in Settings.'
          : isCustomProvider(this.provider)
            ? 'Configure the API server URL and API key in Settings.'
            : 'Add an API key in Settings.',
      );
    const controller = new AbortController(),
      abort = () => controller.abort(signal.reason || new Error('Cancelled'));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(
      () => controller.abort(new Error('Provider request timed out')),
      timeout,
    );
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    try {
      const target = new URL(/^https?:\/\//i.test(route) ? route : `${config.baseUrl}${route}`);
      if (
        target.origin !== new URL(config.baseUrl).origin ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error('Provider requests must stay on the configured API origin');
      if (this.provider === 'local' || isCustomProvider(this.provider))
        await connectionUrl(target.href);
      const response = await this.fetchImpl(target.href, {
        method,
        headers: this.headers(config),
        redirect: 'error',
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        let detail = '';
        try {
          detail = await boundedText(response, 8192);
        } catch {
          detail = 'Error response exceeded its size limit or could not be read';
        }
        throw new Error(`Provider HTTP ${response.status}: ${detail || response.statusText}`);
      }
      return { response, signal: controller.signal, cleanup };
    } catch (error) {
      cleanup();
      throw this.error(error, config);
    }
  }
  async getModels(config, { cursor } = {}) {
    const query =
      config.protocol === 'anthropic'
        ? `?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}`
        : '';
    const { response, cleanup } = await this.http(
      config,
      `${config.modelsUrl || '/models'}${query}`,
      { timeout: 15000 },
    );
    try {
      const text = await boundedText(response, 4 * 1024 * 1024);
      const result = JSON.parse(text);
      if (!Array.isArray(result.data))
        throw new Error('The server returned an invalid model catalog');
      const data = result.data
        .filter(raw => safeModel(raw.id))
        .map(raw =>
          this.model(raw.id, config, {
            displayName: typeof raw.display_name === 'string' ? raw.display_name : raw.id,
            availability: 'listed',
            catalogSource: 'provider',
          }),
        );
      return {
        data,
        nextCursor:
          config.protocol === 'anthropic' && result.has_more && typeof result.last_id === 'string'
            ? result.last_id
            : null,
      };
    } catch (error) {
      throw this.error(error, config);
    } finally {
      cleanup();
    }
  }
  model(model, config, extra = {}) {
    return {
      id: model,
      model,
      displayName: model,
      isDefault: model === config.defaultModel,
      supportedReasoningEfforts: httpModelEfforts(this.provider, model).map(reasoningEffort => ({
        reasoningEffort,
        description: reasoningEffort,
      })),
      defaultReasoningEffort: null,
      serviceTiers: [],
      defaultServiceTier: 'default',
      ...extra,
    };
  }
  sessionFile(id) {
    if (!uuid.test(id)) throw new Error('Invalid provider session ID');
    return path.join(this.dir, `${id}.json`);
  }
  save(thread) {
    const file = this.sessionFile(thread.id),
      value = JSON.stringify({
        version: 1,
        provider: this.provider,
        id: thread.id,
        binding: thread.binding,
        history: thread.history,
        ...(thread.pendingCalls?.length ? { pendingCalls: thread.pendingCalls } : {}),
      });
    if (Buffer.byteLength(value) > MAX_SESSION)
      throw new Error('Conversation reached its stored context limit. Start a new conversation.');
    fs.writeFileSync(`${file}.tmp`, value, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  load(id) {
    const file = this.sessionFile(id);
    if (!fs.existsSync(file))
      throw new Error('Provider conversation is unavailable. Start a new conversation.');
    if (fs.statSync(file).size > MAX_SESSION)
      throw new Error('Provider conversation exceeds its size limit');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      saved.provider !== this.provider ||
      saved.id !== id ||
      saved.version !== 1 ||
      !Array.isArray(saved.history)
    )
      throw new Error('Invalid provider conversation');
    return saved;
  }
  usage(config) {
    if (!this.usageRecords.has(config.binding)) {
      const file = path.join(this.dir, `usage-${config.binding}.json`);
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
      const valid = saved?.accountKey === config.binding && saved?.source === 'api-runtime';
      this.usageRecords.set(config.binding, {
        source: 'api-runtime',
        kind: 'tokens',
        provider: this.provider,
        accountKey: config.binding,
        configurationVersion: config.revision,
        inputTokens: valid ? count(saved.inputTokens) || 0 : 0,
        outputTokens: valid ? count(saved.outputTokens) || 0 : 0,
        totalTokens: valid ? count(saved.totalTokens) || 0 : 0,
        requests: valid ? count(saved.requests) || 0 : 0,
        reportedRequests: valid ? count(saved.reportedRequests) || 0 : 0,
        observedAt: valid ? saved.observedAt : null,
        scope: 'this-installation',
        available: true,
      });
    }
    return {
      ...clone(this.usageRecords.get(config.binding)),
      configurationVersion: config.revision,
    };
  }
  recordUsage(config, values, { request = false } = {}) {
    const usage = this.usage(config);
    if (request) usage.requests++;
    else if (values) {
      const input = count(values.input_tokens ?? values.prompt_tokens),
        output = count(values.output_tokens ?? values.completion_tokens);
      if (input !== null && output !== null) {
        const cached =
          config.protocol === 'anthropic'
            ? (count(values.cache_creation_input_tokens) || 0) +
              (count(values.cache_read_input_tokens) || 0)
            : 0;
        usage.inputTokens += input + cached;
        usage.outputTokens += output;
        usage.totalTokens += input + cached + output;
        usage.reportedRequests++;
      }
    }
    usage.observedAt = new Date().toISOString();
    this.usageRecords.set(config.binding, usage);
    const file = path.join(this.dir, `usage-${config.binding}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(usage), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    const current = this.config();
    if (config.binding === current.binding && config.revision === current.revision)
      this.notify('account/rateLimits/updated', { usage });
  }
  async request(method, params = {}) {
    const config = this.config();
    if (method === 'account/read')
      return {
        account: config.configured
          ? {
              type: this.provider === 'local' ? 'local' : 'api',
              planType: this.provider === 'local' ? config.engine : 'API',
            }
          : null,
        configured: config.configured,
        error: config.configured ? null : 'Configure this provider in Settings.',
      };
    if (method === 'config/read') return { config: { model: config.defaultModel } };
    if (method === 'connection/test') {
      const models = await this.getModels(config);
      return { connected: true, models: models.data, modelCount: models.data.length };
    }
    if (method === 'model/list') {
      try {
        return await this.getModels(config, params);
      } catch (error) {
        if (!config.defaultModel || !config.configured) throw error;
        return {
          data: [
            this.model(config.defaultModel, config, {
              availability: 'unverified',
              catalogSource: 'configured',
              description: `Manual model ID; catalog unavailable: ${error.message}`,
            }),
          ],
          nextCursor: null,
        };
      }
    }
    if (method === 'account/rateLimits/read') return this.usage(config);
    if (method === 'thread/start' || method === 'thread/resume') {
      const id = params.threadId || randomUUID();
      if (this.turns.has(id)) throw new Error('This provider conversation is busy');
      const stored =
        method === 'thread/resume'
          ? this.threads.get(id) || this.load(id)
          : { id, binding: config.binding, history: [] };
      if (stored.binding !== config.binding)
        throw new Error('Provider connection changed. Start a fresh provider conversation.');
      const thread = {
        ...stored,
        ...params,
        id,
        binding: config.binding,
        history: stored.history,
        dynamicTools: clone(params.dynamicTools || stored.dynamicTools || []),
      };
      if (thread.pendingCalls?.length) {
        this.appendResults(
          { thread, config },
          thread.pendingCalls.map(call => ({
            call,
            response: call.result || {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: 'The server stopped before this tool result was confirmed. Do not repeat consequential actions automatically.',
                },
              ],
            },
          })),
        );
        delete thread.pendingCalls;
      }
      this.threads.set(id, thread);
      this.save(thread);
      return {
        thread: { id },
        model: params.model || config.defaultModel,
        reasoningEffort: null,
        serviceTier: 'default',
      };
    }
    if (method === 'turn/start') {
      const thread = this.threads.get(params.threadId);
      if (!thread) throw new Error('Provider conversation is not initialized');
      if (this.turns.has(thread.id)) throw new Error('This provider conversation is busy');
      if (thread.binding !== config.binding)
        throw new Error('Provider connection changed before the turn started');
      const model = params.model || thread.model || config.defaultModel;
      if (!safeModel(model)) throw new Error('Choose a model before sending a message.');
      if (!config.configured) throw new Error('Configure this provider in Settings.');
      const effort = params.effort || thread.config?.model_reasoning_effort || null;
      if (effort && !httpModelEfforts(this.provider, model).includes(effort))
        throw new Error('This model does not advertise that reasoning effort');
      if (params.serviceTier && params.serviceTier !== 'default')
        throw new Error('This provider uses Standard speed');
      const turn = {
        id: randomUUID(),
        threadId: thread.id,
        controller: new AbortController(),
        config: clone(config),
        model,
        effort,
        thread: {
          ...thread,
          history: clone(thread.history),
          dynamicTools: clone(thread.dynamicTools),
        },
        params: clone(params),
        cancelled: false,
        textSize: 0,
        pendingCalls: [],
        callIds: new Set(),
        closed: false,
      };
      this.turns.set(thread.id, turn);
      setImmediate(() =>
        this.run(turn).catch(error =>
          this.finish(turn, turn.cancelled ? 'interrupted' : 'failed', error),
        ),
      );
      return { turn: { id: turn.id } };
    }
    if (method === 'turn/interrupt') {
      const turn = this.turns.get(params.threadId);
      if (turn && (!params.turnId || turn.id === params.turnId)) {
        turn.cancelled = true;
        turn.controller.abort(new Error('Stopped by the user'));
        this.rejectTurn(turn);
      }
      return {};
    }
    throw new Error(`Unsupported ${this.provider} request`);
  }
  emitText(turn, id, text, { complete = false } = {}) {
    if (!text) return;
    turn.textSize += text.length;
    if (turn.textSize > MAX_TEXT) throw new Error('Provider text output exceeded its limit');
    this.notify(
      complete ? 'item/completed' : 'item/agentMessage/delta',
      complete
        ? { threadId: turn.threadId, item: { id, type: 'agentMessage', text } }
        : { threadId: turn.threadId, itemId: id, delta: text },
    );
  }
  input(text, config) {
    return config.protocol === 'responses'
      ? { role: 'user', content: [{ type: 'input_text', text }] }
      : { role: 'user', content: text };
  }
  async run(turn) {
    this.notify('turn/started', { threadId: turn.threadId, turn: { id: turn.id } });
    turn.thread.history.push(
      this.input(
        (turn.params.input || [])
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n'),
        turn.config,
      ),
    );
    for (let round = 0; round < this.maxRounds; round++) {
      if (turn.controller.signal.aborted) throw new Error('Stopped by the user');
      this.save(turn.thread);
      const result = await (turn.config.protocol === 'responses'
        ? this.responses(turn, round)
        : turn.config.protocol === 'anthropic'
          ? this.messages(turn, round)
          : this.chat(turn, round));
      if (result.calls.length > 32) throw new Error('Provider returned too many tool calls');
      for (const call of result.calls) {
        if (
          typeof call.id !== 'string' ||
          !call.id ||
          call.id.length > 300 ||
          turn.callIds.has(call.id)
        )
          throw new Error('Provider returned an invalid or duplicate tool call ID');
        turn.callIds.add(call.id);
      }
      turn.thread.history.push(...result.items);
      this.recordUsage(turn.config, result.usage);
      turn.pendingCalls = result.calls;
      turn.thread.pendingCalls = turn.pendingCalls;
      this.save(turn.thread);
      if (!result.calls.length) {
        await this.finish(turn, 'completed');
        return;
      }
      const results = [];
      for (const call of result.calls) {
        if (turn.controller.signal.aborted) throw new Error('Stopped by the user');
        const response = await this.tool(turn, call);
        results.push({ call, response });
        // Persist all outputs together after the advertised call batch. On an
        // interruption, finish() supplies error outputs for unfinished calls.
        call.result = response;
        this.save(turn.thread);
      }
      this.appendResults(turn, results);
      turn.pendingCalls = [];
      delete turn.thread.pendingCalls;
      this.save(turn.thread);
    }
    throw new Error(
      `Task reached the ${this.maxRounds}-round tool limit. Review its partial results.`,
    );
  }
  tools(turn, kind) {
    if (!turn.config.toolsEnabled) return [];
    return turn.thread.dynamicTools.map(t =>
      kind === 'responses'
        ? {
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          }
        : kind === 'anthropic'
          ? { name: t.name, description: t.description, input_schema: t.inputSchema }
          : {
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            },
    );
  }
  async streamed(turn, route, body, consume) {
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_SESSION)
      throw new Error('Conversation exceeds its request context limit');
    this.recordUsage(turn.config, null, { request: true });
    const transport = await this.http(turn.config, route, {
      method: 'POST',
      body,
      signal: turn.controller.signal,
    });
    try {
      for await (const packet of providerEvents(transport.response, transport.signal)) {
        if (packet.data === '[DONE]') {
          consume({ type: 'done' });
          continue;
        }
        let event;
        try {
          event = JSON.parse(packet.data);
        } catch {
          throw new Error('Provider returned invalid streaming JSON');
        }
        if (event.error || event.type === 'error') throw new Error(jsonText(event.error || event));
        consume(event);
      }
    } finally {
      transport.cleanup();
    }
  }
  async responses(turn, round) {
    let completed = null;
    const items = new Map(),
      textById = new Map();
    const body = {
      model: turn.model,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 16384,
      instructions: turn.thread.developerInstructions || '',
      input: turn.thread.history,
      tools: this.tools(turn, 'responses'),
      ...(turn.effort ? { reasoning: { effort: turn.effort } } : {}),
    };
    await this.streamed(turn, '/responses', body, event => {
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done')
        items.set(event.output_index, event.item);
      if (event.type === 'response.output_text.delta') {
        const id = event.item_id || `${turn.id}:${round}:${event.output_index || 0}`;
        textById.set(id, (textById.get(id) || '') + event.delta);
        this.emitText(turn, id, event.delta);
      }
      if (['response.failed', 'response.incomplete'].includes(event.type))
        throw new Error(event.response?.error?.message || 'Provider response was incomplete');
      if (event.type === 'response.completed') completed = event.response;
    });
    if (!completed || (completed.status && completed.status !== 'completed'))
      throw new Error('Provider stream ended before response completion');
    const output = completed.output || [...items.values()];
    if (!Array.isArray(output)) throw new Error('Provider returned invalid output');
    for (const item of output)
      if (item.type === 'message') {
        const text = (item.content || [])
          .filter(c => c.type === 'output_text')
          .map(c => c.text)
          .join('');
        if (text && !textById.has(item.id))
          this.emitText(turn, item.id || `${turn.id}:${round}`, text, { complete: true });
      }
    this.notify('thread/settingsUpdated', {
      threadId: turn.threadId,
      model: completed.model || turn.model,
      reasoningEffort: turn.effort,
      serviceTier: 'default',
    });
    return {
      items: output,
      calls: output
        .filter(item => item.type === 'function_call')
        .map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments })),
      usage: completed.usage,
    };
  }
  async messages(turn, round) {
    const blocks = new Map();
    let stopped = false,
      stopReason = null,
      usage = {},
      actualModel = turn.model;
    const body = {
      model: turn.model,
      stream: true,
      max_tokens: 16384,
      system: turn.thread.developerInstructions || '',
      messages: turn.thread.history,
      tools: this.tools(turn, 'anthropic'),
      ...(turn.effort ? { output_config: { effort: turn.effort } } : {}),
    };
    await this.streamed(turn, '/messages', body, event => {
      if (event.type === 'message_start') {
        usage = { ...event.message?.usage };
        actualModel = event.message?.model || actualModel;
      }
      if (event.type === 'content_block_start') blocks.set(event.index, { ...event.content_block });
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (!block) throw new Error('Missing Anthropic content block');
        const d = event.delta;
        if (d.type === 'text_delta') {
          block.text = (block.text || '') + d.text;
          this.emitText(turn, `${turn.id}:${round}:${event.index}`, d.text);
        } else if (d.type === 'input_json_delta')
          block.partial = (block.partial || '') + d.partial_json;
        else if (d.type === 'thinking_delta') block.thinking = (block.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta')
          block.signature = (block.signature || '') + d.signature;
      }
      if (event.type === 'message_delta') {
        usage = { ...usage, ...event.usage };
        stopReason = event.delta?.stop_reason || stopReason;
      }
      if (event.type === 'message_stop') stopped = true;
    });
    if (!stopped) throw new Error('Anthropic stream ended before message completion');
    if (stopReason === 'max_tokens') throw new Error('Anthropic reached its output-token limit');
    const content = [...blocks.values()].map(block => {
      if (block.type === 'tool_use' && block.partial !== undefined) {
        block.input = JSON.parse(block.partial || '{}');
        delete block.partial;
      }
      return block;
    });
    this.notify('thread/settingsUpdated', {
      threadId: turn.threadId,
      model: actualModel,
      reasoningEffort: turn.effort,
      serviceTier: 'default',
    });
    return {
      items: [{ role: 'assistant', content }],
      calls: content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, arguments: b.input })),
      usage,
    };
  }
  async chat(turn, round) {
    const calls = new Map();
    let text = '',
      finish = null,
      done = false,
      usage = null,
      actualModel = turn.model;
    const body = {
      model: turn.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 8192,
      messages: [
        { role: 'system', content: turn.thread.developerInstructions || '' },
        ...turn.thread.history,
      ],
      ...(turn.config.toolsEnabled ? { tools: this.tools(turn, 'chat'), tool_choice: 'auto' } : {}),
    };
    await this.streamed(turn, '/chat/completions', body, event => {
      if (event.type === 'done') {
        done = true;
        return;
      }
      if (event.usage) usage = event.usage;
      if (event.model) actualModel = event.model;
      const choice = event.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') {
        text += delta.content;
        this.emitText(turn, `${turn.id}:${round}`, delta.content);
      }
      for (const piece of delta.tool_calls || []) {
        const old = calls.get(piece.index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (piece.id) old.id = piece.id;
        if (piece.function?.name) old.function.name += piece.function.name;
        if (piece.function?.arguments) old.function.arguments += piece.function.arguments;
        calls.set(piece.index, old);
      }
    });
    if (!finish || (!done && finish === 'length'))
      throw new Error('Model server stream ended before completion');
    if (finish === 'length') throw new Error('Model server reached its output-token limit');
    const toolCalls = [...calls.values()],
      message = {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
    this.notify('thread/settingsUpdated', {
      threadId: turn.threadId,
      model: actualModel,
      reasoningEffort: null,
      serviceTier: 'default',
    });
    return {
      items: [message],
      calls: toolCalls.map(call => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      usage,
    };
  }
  async tool(turn, call) {
    if (
      !turn.config.toolsEnabled ||
      !turn.thread.dynamicTools.some(tool => tool.name === call.name)
    )
      return {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'This tool was not advertised or enabled. It was not executed.',
          },
        ],
      };
    let args;
    try {
      args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    } catch {
      return {
        success: false,
        contentItems: [
          { type: 'inputText', text: 'Invalid JSON tool arguments. Nothing was executed.' },
        ],
      };
    }
    if (!call.id || typeof call.id !== 'string' || call.id.length > 300)
      throw new Error('Invalid provider tool call ID');
    const itemId = `${turn.id}:${call.id}`;
    this.notify('item/started', {
      threadId: turn.threadId,
      item: { id: itemId, type: 'dynamicToolCall', tool: call.name },
    });
    const response = await new Promise((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Tool request timed out'));
        }, this.toolTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, turn });
      this.emit('request', {
        id,
        method: 'item/tool/call',
        params: {
          threadId: turn.threadId,
          turnId: turn.id,
          callId: call.id,
          tool: call.name,
          arguments: args,
        },
      });
    });
    this.notify('item/completed', {
      threadId: turn.threadId,
      item: {
        id: itemId,
        type: 'dynamicToolCall',
        tool: call.name,
        status: response.success ? 'completed' : 'failed',
      },
    });
    return response;
  }
  respond(id, result) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result);
  }
  reject(id, message) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error(message));
  }
  rejectTurn(turn) {
    for (const [id, pending] of this.pending)
      if (pending.turn === turn) this.reject(id, 'Task interrupted; the action was not approved.');
  }
  resultContent(turn, response, kind) {
    const result = [];
    for (const item of response.contentItems || []) {
      if (item.type === 'inputText')
        result.push(
          kind === 'anthropic'
            ? { type: 'text', text: item.text }
            : { type: 'input_text', text: item.text },
        );
      else if (item.type === 'inputImage') {
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
          item.imageUrl || '',
        );
        if (turn.config.visionEnabled && match)
          result.push(
            kind === 'anthropic'
              ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
              : { type: 'input_image', image_url: item.imageUrl },
          );
        else
          result.push(
            kind === 'anthropic'
              ? {
                  type: 'text',
                  text: 'Image omitted: enable vision for a compatible model to view screenshots.',
                }
              : {
                  type: 'input_text',
                  text: 'Image omitted: enable vision for a compatible model to view screenshots.',
                },
          );
      }
    }
    return result.length
      ? result
      : [
          kind === 'anthropic'
            ? { type: 'text', text: 'Tool returned no content.' }
            : { type: 'input_text', text: 'Tool returned no content.' },
        ];
  }
  appendResults(turn, results) {
    if (turn.config.protocol === 'responses')
      for (const { call, response } of results)
        turn.thread.history.push({
          type: 'function_call_output',
          call_id: call.id,
          output: this.resultContent(turn, response, 'responses'),
        });
    else if (turn.config.protocol === 'anthropic')
      turn.thread.history.push({
        role: 'user',
        content: results.map(({ call, response }) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: !response.success,
          content: this.resultContent(turn, response, 'anthropic'),
        })),
      });
    else {
      const images = [];
      for (const { call, response } of results) {
        const content = this.resultContent(turn, response, 'responses');
        turn.thread.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: content
            .filter(i => i.type === 'input_text')
            .map(i => i.text)
            .join('\n'),
        });
        for (const item of content)
          if (item.type === 'input_image')
            images.push(
              { type: 'text', text: `Screenshot returned by tool ${call.name} (${call.id}):` },
              { type: 'image_url', image_url: { url: item.image_url } },
            );
      }
      if (images.length) turn.thread.history.push({ role: 'user', content: images });
    }
  }
  async finish(turn, status, error = null) {
    if (turn.closed) return;
    turn.closed = true;
    this.rejectTurn(turn);
    try {
      if (turn.pendingCalls.length) {
        this.appendResults(
          turn,
          turn.pendingCalls.map(call => ({
            call,
            response: call.result || {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: 'This turn was interrupted or failed before a result was confirmed. Do not repeat consequential actions automatically.',
                },
              ],
            },
          })),
        );
        turn.pendingCalls = [];
      }
      delete turn.thread.pendingCalls;
      if (status !== 'completed')
        turn.thread.history.push(
          this.input(
            'The preceding task stopped or failed. Review confirmed tool results before doing anything else; do not repeat consequential actions automatically.',
            turn.config,
          ),
        );
      this.save(turn.thread);
      this.threads.set(turn.threadId, turn.thread);
    } catch (saveError) {
      error = saveError;
      status = 'failed';
    }
    this.turns.delete(turn.threadId);
    this.notify('turn/completed', {
      threadId: turn.threadId,
      turn: {
        id: turn.id,
        status,
        error: error ? { message: this.error(error, turn.config).message } : null,
      },
    });
  }
  async stop() {
    this.ready = false;
    for (const turn of this.turns.values()) {
      turn.cancelled = true;
      turn.controller.abort(new Error('Server stopped'));
      this.rejectTurn(turn);
    }
    await Promise.all([...this.turns.values()].map(turn => this.finish(turn, 'interrupted')));
  }
}
