import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { McpSecretStore } from './mcp-secret-store.mjs';
import { connectionUrl, metadataHost } from './browser.mjs';

const transports = new Set(['streamable-http', 'sse', 'stdio']),
  authTypes = new Set(['none', 'bearer', 'header', 'oauth']);
const clone = value => structuredClone(value),
  hash = value => createHash('sha256').update(value).digest('hex'),
  stamp = () => new Date().toISOString();
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const MAX_RESULT = 16 * 1024 * 1024,
  MAX_TOOLS = 1000;
function text(value, label, max = 2000) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
function safeUrl(value, { oauth = false } = {}) {
  text(String(value), 'MCP URL', 4000);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid MCP server URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('MCP URLs must use HTTP(S), without embedded credentials or fragments');
  if (metadataHost(url.hostname)) throw new Error('Cloud metadata endpoints cannot be MCP servers');
  if (
    oauth &&
    url.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('OAuth requires HTTPS or a loopback address');
  return url;
}
class NeedsAuthorization extends Error {}

export class McpConnections extends EventEmitter {
  constructor({
    dataDir,
    callbackUrl,
    fetchImpl = fetch,
    requestTimeoutMs = 60000,
    connectTimeoutMs = 20000,
  } = {}) {
    super();
    if (!dataDir) throw new Error('MCP data directory is required');
    this.vault = new McpSecretStore(dataDir);
    this.records = this.vault.data;
    this.callbackUrl = callbackUrl;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.sessions = new Map();
    this.flows = new Map();
    this.closed = false;
  }
  record(id) {
    if (typeof id !== 'string' || !Object.hasOwn(this.records, id))
      throw new Error('Unknown MCP connection');
    return this.records[id];
  }
  secrets(record) {
    return [
      record.token,
      record.oauthClientSecret,
      ...Object.values(record.env || {}),
      ...Object.values(record.oauth?.clients || {}).map(info => info.client_secret),
      ...Object.values(record.oauth?.tokensByIssuer || {}).flatMap(tokens => [
        tokens.access_token,
        tokens.refresh_token,
      ]),
      record.oauth?.tokens?.access_token,
      record.oauth?.tokens?.refresh_token,
    ].filter(value => typeof value === 'string' && value);
  }
  redact(record, value) {
    let output = String(value || 'MCP connection failed');
    for (const secret of this.secrets(record).sort((a, b) => b.length - a.length))
      output = output.split(secret).join('[redacted]');
    return output
      .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
      .slice(0, 700);
  }
  sanitize(record, value) {
    const secrets = this.secrets(record).sort((a, b) => b.length - a.length);
    const visit = item => {
      if (typeof item === 'string') {
        for (const secret of secrets) item = item.split(secret).join('[redacted]');
        return item;
      }
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === 'object')
        return Object.fromEntries(Object.entries(item).map(([key, part]) => [key, visit(part)]));
      return item;
    };
    return visit(value);
  }
  getPublic(id) {
    const r = this.record(id),
      s = this.sessions.get(id);
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      url: r.url || '',
      command: r.command || '',
      args: (r.args || []).map(value => this.redact(r, value)),
      cwd: r.cwd || '',
      envKeys: Object.keys(r.env || {}),
      authType: r.authType,
      hasToken: !!(r.token || r.oauth?.tokens),
      headerName: r.headerName || '',
      oauthClientId: r.oauthClientId || '',
      hasClientSecret: !!r.oauthClientSecret,
      oauthScope: r.oauthScope || '',
      enabled: !!r.enabled,
      status: s?.status || 'disconnected',
      connected: s?.status === 'connected',
      error: s?.error || null,
      toolCount: s?.tools?.length || 0,
      revision: r.revision,
    };
  }
  describe(id) {
    return this.getPublic(id);
  }
  list() {
    return { connections: Object.keys(this.records).map(id => this.getPublic(id)) };
  }
  changed(id) {
    const value = this.getPublic(id);
    this.emit('change', value);
    return value;
  }
  persist() {
    this.vault.save(this.records);
  }
  validate(input, current = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('MCP settings must be an object');
    const allowed = new Set([
      'name',
      'transport',
      'url',
      'command',
      'args',
      'cwd',
      'env',
      'authType',
      'token',
      'removeToken',
      'headerName',
      'oauthClientId',
      'oauthClientSecret',
      'removeClientSecret',
      'oauthScope',
    ]);
    if (Object.keys(input).some(key => !allowed.has(key)))
      throw new Error('Unsupported MCP setting');
    const next = {
      name: '',
      transport: 'streamable-http',
      url: '',
      command: '',
      args: [],
      cwd: '',
      env: {},
      authType: 'none',
      token: '',
      headerName: 'X-API-Key',
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauth: {},
      ...clone(current),
    };
    for (const field of [
      'name',
      'transport',
      'url',
      'command',
      'cwd',
      'authType',
      'headerName',
      'oauthClientId',
      'oauthScope',
    ])
      if (field in input)
        next[field] = text(input[field], field, field === 'url' ? 4000 : 2000).trim();
    if (!next.name || next.name.length > 80)
      throw new Error('Connection name must contain 1–80 characters');
    if (!transports.has(next.transport) || !authTypes.has(next.authType))
      throw new Error('Choose a supported MCP transport and authentication method');
    for (const field of ['token', 'oauthClientSecret'])
      if (field in input) {
        const value = text(input[field], field, 8192);
        if (value) next[field] = value;
      }
    for (const field of ['removeToken', 'removeClientSecret'])
      if (field in input && typeof input[field] !== 'boolean')
        throw new Error(`${field} must be true or false`);
    if (input.removeToken) {
      if (input.token) throw new Error('Cannot replace and remove a token together');
      next.token = '';
    }
    if (input.removeClientSecret) {
      if (input.oauthClientSecret)
        throw new Error('Cannot replace and remove a client secret together');
      next.oauthClientSecret = '';
    }
    if ('args' in input) {
      if (!Array.isArray(input.args) || input.args.length > 100)
        throw new Error('MCP arguments must be an array of up to 100 strings');
      next.args = input.args.map(value => text(value, 'command argument', 4000));
    }
    if ('env' in input) {
      if (
        !input.env ||
        typeof input.env !== 'object' ||
        Array.isArray(input.env) ||
        Object.keys(input.env).length > 100
      )
        throw new Error('MCP environment must be an object');
      next.env = {};
      for (const [key, value] of Object.entries(input.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          throw new Error('Invalid environment variable name');
        next.env[key] = text(value, 'environment value', 16000);
      }
    }
    if (next.transport === 'stdio') {
      if (!next.command || /[\r\n\0]/.test(next.command))
        throw new Error('Enter an installed MCP server executable');
      const executable = path
        .basename(next.command)
        .toLowerCase()
        .replace(/\.(cmd|exe|bat)$/, '');
      if (executable === 'npx' && !next.args.includes('--no-install'))
        throw new Error(
          'Use an installed executable, or npx with --no-install; StellarCortex does not install MCP packages',
        );
      if (['npm', 'pnpm', 'yarn', 'uvx'].includes(executable))
        throw new Error(
          'Use an installed MCP executable directly; package installation commands are not supported',
        );
      if (next.cwd && !path.isAbsolute(next.cwd))
        throw new Error('MCP working directory must be an absolute path');
      if (next.authType !== 'none')
        throw new Error(
          'Stdio servers use their explicit environment variables for authentication',
        );
      next.url = '';
    } else {
      const url = safeUrl(next.url);
      if (url.search)
        throw new Error('Put MCP credentials in authentication settings, not URL query parameters');
      next.url = url.href;
      if (next.authType === 'oauth') safeUrl(next.url, { oauth: true });
      if (
        ['bearer', 'header'].includes(next.authType) &&
        (!next.token || /[\r\n\0]/.test(next.token))
      )
        throw new Error('Enter a valid MCP authentication token');
      if (
        next.authType === 'header' &&
        (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(next.headerName) ||
          /^(host|cookie|connection|content-length|transfer-encoding|content-type|accept|origin|referer|mcp-.+)$/i.test(
            next.headerName,
          ))
      )
        throw new Error('Choose a valid authentication header such as X-API-Key');
      if (
        current.url &&
        current.url !== next.url &&
        current.token &&
        !input.token &&
        !input.removeToken
      )
        throw new Error('Re-enter or remove the token when changing the MCP server URL');
      if (
        current.url &&
        current.url !== next.url &&
        current.oauthClientSecret &&
        !input.oauthClientSecret &&
        !input.removeClientSecret
      )
        throw new Error('Re-enter or remove the OAuth client secret when changing servers');
    }
    const identity = r =>
      JSON.stringify([
        r.transport,
        r.url,
        r.command,
        r.args,
        r.cwd,
        r.env,
        r.authType,
        r.token,
        r.headerName,
        r.oauthClientId,
        r.oauthClientSecret,
        r.oauthScope,
      ]);
    if (identity(next) !== identity(current)) next.oauth = {};
    next.revision = randomUUID();
    return next;
  }
  create(input) {
    if (Object.keys(this.records).length >= 50)
      throw new Error('At most 50 MCP connections are supported');
    const r = { ...this.validate(input), id: `mcp-${randomUUID()}`, enabled: false };
    this.records = { ...this.records, [r.id]: r };
    this.persist();
    return this.changed(r.id);
  }
  async update(id, input) {
    const r = this.validate(input, this.record(id));
    await this.disconnect(id, { save: false });
    this.records[id] = r;
    this.persist();
    return this.changed(id);
  }
  async remove(id) {
    this.record(id);
    await this.disconnect(id, { save: false });
    delete this.records[id];
    this.persist();
    this.emit('change', { id, removed: true });
    return { ok: true };
  }
  invalidateFlows(id) {
    for (const [state, flow] of this.flows)
      if (flow.id === id || flow.expires < Date.now()) this.flows.delete(state);
  }
  current(session) {
    return (
      !this.closed &&
      this.sessions.get(session.id) === session &&
      this.records[session.id]?.revision === session.revision &&
      !session.controller.signal.aborted
    );
  }
  async disconnect(id, { save = true } = {}) {
    const r = this.record(id),
      s = this.sessions.get(id);
    this.sessions.delete(id);
    this.invalidateFlows(id);
    if (save) {
      r.enabled = false;
      r.revision = randomUUID();
      this.persist();
    }
    if (s) {
      s.controller.abort();
      try {
        await s.client?.close();
      } catch {}
      try {
        await s.transport?.close();
      } catch {}
    }
    return this.changed(id);
  }
  async close() {
    this.closed = true;
    for (const id of [...this.sessions.keys()]) await this.disconnect(id, { save: false });
    this.flows.clear();
  }
  async restore() {
    return Promise.allSettled(
      Object.values(this.records)
        .filter(r => r.enabled)
        .map(r => this.connect(r.id)),
    );
  }
  oauthProvider(session, owner) {
    const manager = this,
      r = this.record(session.id),
      callback = safeUrl(
        session.redirectUri ||
          (typeof this.callbackUrl === 'function' ? this.callbackUrl() : this.callbackUrl),
        { oauth: true },
      ).href;
    const read = () => {
      if (!manager.current(session)) throw new Error('MCP connection changed');
      return manager.record(session.id);
    };
    const write = fn => {
      const value = read();
      value.oauth ||= {};
      fn(value.oauth);
      manager.persist();
    };
    return {
      redirectUrl: callback,
      clientMetadata: {
        client_name: 'StellarCortex',
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: r.oauthClientSecret ? 'client_secret_post' : 'none',
        ...(r.oauthScope ? { scope: r.oauthScope } : {}),
      },
      clientInformation(ctx) {
        const value = read();
        if (value.oauthClientId) {
          const bound = value.oauth?.manualIssuer;
          if (bound && ctx?.issuer && bound !== ctx.issuer)
            throw new Error(
              'OAuth issuer changed; reconnect with the intended client configuration',
            );
          if (ctx?.issuer && !bound) write(o => (o.manualIssuer = ctx.issuer));
          return {
            client_id: value.oauthClientId,
            ...(ctx?.issuer || bound ? { issuer: ctx?.issuer || bound } : {}),
            ...(value.oauthClientSecret ? { client_secret: value.oauthClientSecret } : {}),
          };
        }
        return ctx?.issuer ? value.oauth?.clients?.[ctx.issuer] : undefined;
      },
      saveClientInformation(info, ctx) {
        if (!ctx?.issuer) throw new Error('OAuth client registration has no issuer');
        write(o => {
          o.clients ||= {};
          o.clients[ctx.issuer] = info;
        });
      },
      tokens(ctx) {
        const o = read().oauth;
        return ctx?.issuer ? o?.tokensByIssuer?.[ctx.issuer] : o?.tokens;
      },
      saveTokens(tokens, ctx) {
        write(o => {
          o.tokens = tokens;
          const issuer = ctx?.issuer || tokens.issuer;
          if (issuer) {
            o.tokensByIssuer ||= {};
            o.tokensByIssuer[issuer] = tokens;
          }
        });
      },
      state() {
        if (!owner) throw new NeedsAuthorization('Sign in from the MCP connection settings');
        manager.invalidateFlows(session.id);
        const nonce = randomBytes(24).toString('base64url'),
          mac = createHmac('sha256', manager.vault.key)
            .update(JSON.stringify([nonce, session.id, session.revision, owner]))
            .digest('base64url'),
          state = `${nonce}.${mac}`;
        const flow = {
          id: session.id,
          revision: session.revision,
          owner,
          state,
          expires: Date.now() + 600000,
          provider: this,
        };
        manager.flows.set(state, flow);
        session.authState = state;
        return state;
      },
      saveCodeVerifier(verifier) {
        session.verifier = verifier;
      },
      codeVerifier() {
        if (!session.verifier) throw new Error('OAuth sign-in expired; start again');
        return session.verifier;
      },
      saveDiscoveryState(discovery) {
        write(o => (o.discovery = discovery));
      },
      discoveryState() {
        return read().oauth?.discovery;
      },
      redirectToAuthorization(url) {
        safeUrl(url, { oauth: true });
        if (!session.authState || !equal(url.searchParams.get('state'), session.authState))
          throw new Error('Invalid OAuth authorization state');
        const flow = manager.flows.get(session.authState);
        flow.authorizationUrl = url.href;
        session.authorizationUrl = url.href;
      },
      invalidateCredentials(scope) {
        write(o => {
          if (scope === 'all') {
            for (const key of Object.keys(o)) delete o[key];
          } else if (scope === 'tokens') {
            delete o.tokens;
            delete o.tokensByIssuer;
          } else if (scope === 'client') {
            delete o.clients;
            delete o.manualIssuer;
          } else if (scope === 'discovery') delete o.discovery;
        });
        if (scope === 'verifier' || scope === 'all') delete session.verifier;
      },
    };
  }
  async network(session, input, options = {}) {
    if (!this.current(session)) throw new Error('MCP connection changed');
    const r = this.record(session.id),
      url = safeUrl(typeof input === 'string' || input instanceof URL ? input : input.url, {
        oauth: r.authType === 'oauth',
      }),
      origin = new URL(r.url).origin,
      headers = new Headers(
        options.headers || (input instanceof Request ? input.headers : undefined),
      );
    if (
      url.origin !== origin &&
      (r.authType !== 'oauth' || /^Bearer\s/i.test(headers.get('authorization') || ''))
    )
      throw new Error('Refusing MCP credentials for a different server origin');
    await connectionUrl(url.href);
    const timeout = new AbortController(),
      timer = setTimeout(() => timeout.abort(), this.connectTimeoutMs);
    const signal = AbortSignal.any([
      session.controller.signal,
      timeout.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const response = await this.fetchImpl(input, {
        ...options,
        headers,
        redirect: 'error',
        signal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new Error('MCP HTTP redirects are not allowed');
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_RESULT) {
        await response.body?.cancel();
        throw new Error('MCP response exceeds the size limit');
      }
      if (!response.body) return response;
      const reader = response.body.getReader(),
        isSse = response.headers.get('content-type')?.includes('text/event-stream'),
        bodyTimeout = this.connectTimeoutMs;
      let size = 0,
        lastByte = 0,
        closed = false;
      const finish = () => {
        closed = true;
        session.controller.signal.removeEventListener('abort', cancel);
      };
      const stream = new ReadableStream({
        async pull(controller) {
          let timer;
          try {
            const reading = reader.read(),
              { done, value } = isSse
                ? await reading
                : await Promise.race([
                    reading,
                    new Promise((_, reject) => {
                      timer = setTimeout(
                        () => reject(new Error('MCP response timed out')),
                        bodyTimeout,
                      );
                    }),
                  ]);
            if (done) {
              finish();
              controller.close();
              return;
            }
            if (isSse) {
              for (const byte of value) {
                size++;
                if (byte === 10 && lastByte === 10) size = 0;
                if (byte !== 13) lastByte = byte;
                if (size > MAX_RESULT) throw new Error('MCP event exceeds the size limit');
              }
            } else {
              size += value.byteLength;
              if (size > MAX_RESULT) throw new Error('MCP response exceeds the size limit');
            }
            controller.enqueue(value);
          } catch (error) {
            finish();
            reader.cancel().catch(() => {});
            controller.error(error);
          } finally {
            clearTimeout(timer);
          }
        },
        cancel(reason) {
          finish();
          return reader.cancel(reason);
        },
      });
      const cancel = () => {
        if (!closed) reader.cancel().catch(() => {});
      };
      session.controller.signal.addEventListener('abort', cancel, { once: true });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  makeTransport(session, owner) {
    const r = this.record(session.id);
    if (r.transport === 'stdio')
      return new StdioClientTransport({
        command: r.command,
        args: r.args,
        cwd: r.cwd || undefined,
        env: { ...getDefaultEnvironment(), ...r.env },
        stderr: 'ignore',
        maxBufferSize: MAX_RESULT,
      });
    const options = {
      fetch: (input, init) => this.network(session, input, init),
      requestInit: { redirect: 'error' },
      redirectPolicy: 'follow',
      onInsufficientScope: 'throw',
    };
    if (r.authType === 'oauth')
      options.authProvider = session.oauthProvider ||= this.oauthProvider(session, owner);
    else if (r.authType === 'bearer')
      options.requestInit.headers = { Authorization: `Bearer ${r.token}` };
    else if (r.authType === 'header') options.requestInit.headers = { [r.headerName]: r.token };
    return r.transport === 'sse'
      ? new SSEClientTransport(new URL(r.url), options)
      : new StreamableHTTPClientTransport(new URL(r.url), options);
  }
  async connect(id, { owner, redirectUri } = {}) {
    this.record(id);
    if (this.closed) throw new Error('MCP manager is closed');
    const existing = this.sessions.get(id);
    if (existing?.status === 'connected') return { connection: this.getPublic(id) };
    if (existing?.pending)
      return existing.pending.then(result => ({
        ...result,
        ...(existing.owner === owner ? {} : { authorizationUrl: undefined, state: undefined }),
      }));
    await this.disconnect(id, { save: false });
    const raced = this.sessions.get(id);
    if (raced?.pending)
      return raced.pending.then(result => ({
        ...result,
        ...(raced.owner === owner ? {} : { authorizationUrl: undefined, state: undefined }),
      }));
    const r = this.record(id);
    r.enabled = true;
    r.revision = randomUUID();
    this.persist();
    const session = {
      id,
      revision: r.revision,
      owner,
      redirectUri: redirectUri ? safeUrl(redirectUri, { oauth: true }).href : undefined,
      controller: new AbortController(),
      status: 'connecting',
      error: null,
      tools: [],
    };
    this.sessions.set(id, session);
    this.changed(id);
    if (r.authType === 'oauth' && !r.oauth?.tokens && !owner) {
      session.status = 'authorization-required';
      return { connection: this.changed(id) };
    }
    const operation = this.open(session, owner);
    session.pending = operation;
    try {
      return await operation;
    } finally {
      if (session.pending === operation) delete session.pending;
    }
  }
  async open(session, owner) {
    const r = this.record(session.id);
    let timer;
    try {
      const client = (session.client = new Client(
        { name: 'stellarcortex', version: '0.1.4' },
        {
          capabilities: {},
          versionNegotiation: {
            mode: r.transport === 'stdio' ? 'legacy' : 'auto',
            probe: { timeoutMs: this.connectTimeoutMs, maxRetries: 0 },
          },
          inputRequired: { autoFulfill: false },
          listMaxPages: 20,
        },
      ));
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        if (!this.current(session)) return;
        const value = this.record(session.id);
        value.revision = session.revision = randomUUID();
        session.tools = [];
        session.toolsHash = null;
        this.persist();
        this.changed(session.id);
        this.emit('toolsChanged', { id: session.id, revision: value.revision });
      });
      client.onclose = () => {
        if (this.current(session) && session.status === 'connected') {
          session.status = 'disconnected';
          session.tools = [];
          this.changed(session.id);
        }
      };
      client.onerror = error => {
        if (this.current(session)) session.error = this.redact(r, error.message);
      };
      session.transport = this.makeTransport(session, owner);
      timer = setTimeout(
        () => session.controller.abort(new Error('MCP connection timed out')),
        this.connectTimeoutMs,
      );
      await client.connect(session.transport, {
        timeout: this.connectTimeoutMs,
        signal: session.controller.signal,
      });
      if (!this.current(session)) throw new Error('MCP connection changed');
      session.status = 'connected';
      await this.listTools(session.id, { refresh: true });
      return { connection: this.changed(session.id) };
    } catch (error) {
      if (this.sessions.get(session.id) !== session) {
        try {
          await session.client?.close();
        } catch {}
        throw new Error('MCP connection changed');
      }
      const authorization =
        error instanceof UnauthorizedError || error instanceof NeedsAuthorization;
      session.status = authorization ? 'authorization-required' : 'error';
      session.error = authorization ? null : this.redact(r, error.message);
      try {
        await session.client?.close();
      } catch {}
      const result = { connection: this.changed(session.id) };
      if (authorization && session.authorizationUrl && session.owner === owner)
        return {
          ...result,
          authorizationUrl: session.authorizationUrl,
          state: session.authState,
          connectionId: session.id,
        };
      if (authorization) return result;
      throw new Error(session.error);
    } finally {
      clearTimeout(timer);
    }
  }
  async getAuthStart(id, { owner, redirectUri } = {}) {
    if (!owner) throw new Error('An authenticated browser session is required');
    if (this.record(id).authType !== 'oauth') throw new Error('This connection does not use OAuth');
    await this.disconnect(id, { save: false });
    const r = this.record(id);
    delete r.oauth?.tokens;
    delete r.oauth?.tokensByIssuer;
    this.persist();
    return this.connect(id, { owner, redirectUri });
  }
  async completeAuth(params, { owner } = {}) {
    const query =
      params instanceof URLSearchParams
        ? params
        : new URLSearchParams(
            Object.entries(params || {}).filter(([, value]) => typeof value === 'string'),
          );
    const state = query.get('state'),
      flow = this.flows.get(state);
    if (!flow || !owner || !equal(owner, flow.owner) || flow.expires < Date.now())
      throw new Error('Invalid or expired MCP OAuth state');
    this.flows.delete(state);
    const r = this.record(flow.id),
      session = this.sessions.get(flow.id);
    if (!session || r.revision !== flow.revision || session.authState !== state)
      throw new Error('MCP connection changed during sign-in');
    if (query.has('error')) {
      session.status = 'error';
      session.error = 'OAuth authorization was declined or failed';
      this.changed(flow.id);
      throw new Error(session.error);
    }
    if (!query.get('code') || query.get('code').length > 8192)
      throw new Error('Missing or invalid OAuth authorization code');
    try {
      // Fresh transport, with the exact issuer/discovery and verifier retained by
      // the SDK provider from the first leg. Full params retain RFC 9207 iss.
      const transport = this.makeTransport(session, owner);
      await transport.finishAuth(query);
      await transport.close();
      delete session.verifier;
      session.authorizationUrl = null;
      session.authState = null;
      return (await this.open(session, owner)).connection;
    } catch (error) {
      session.status = 'error';
      session.error = this.redact(r, error.message);
      this.changed(flow.id);
      throw new Error(session.error);
    }
  }
  connected(id) {
    const r = this.record(id),
      s = this.sessions.get(id);
    if (!s || s.status !== 'connected' || !this.current(s))
      throw new Error('Connect this MCP server before using its tools');
    return { r, s };
  }
  async listTools(id, { refresh = false, signal } = {}) {
    const { r, s } = this.connected(id);
    if (!refresh && s.toolsHash) return { tools: clone(s.tools), revision: r.revision };
    let result;
    try {
      result = await s.client.listTools(undefined, {
        timeout: this.requestTimeoutMs,
        signal: signal ? AbortSignal.any([s.controller.signal, signal]) : s.controller.signal,
        cache: 'reload',
      });
    } catch (error) {
      throw new Error(this.redact(r, error.message));
    }
    if (!this.current(s)) throw new Error('MCP connection changed');
    if (
      !Array.isArray(result.tools) ||
      result.tools.length > MAX_TOOLS ||
      Buffer.byteLength(JSON.stringify(result.tools)) > 2 * 1024 * 1024
    )
      throw new Error('MCP tool catalog exceeds the size limit');
    const signature = hash(JSON.stringify(result.tools));
    if (s.toolsHash && s.toolsHash !== signature) {
      r.revision = s.revision = randomUUID();
      this.persist();
    }
    s.tools = this.sanitize(r, result.tools);
    s.toolsHash = signature;
    return { tools: clone(s.tools), revision: r.revision };
  }
  tools(id, options) {
    return this.listTools(id, options);
  }
  async callTool(id, name, args = {}, options = {}) {
    const { r, s } = this.connected(id),
      expected = options.expectedRevision;
    if (expected && expected !== r.revision)
      throw new Error('MCP tools changed after approval; review the tool again');
    if (
      typeof name !== 'string' ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024
    )
      throw new Error('Invalid MCP tool arguments');
    const catalog = await this.listTools(id, { refresh: !!expected, signal: options.signal });
    if (!catalog.tools.some(tool => tool.name === name)) throw new Error('Unknown MCP tool');
    if (expected && expected !== r.revision)
      throw new Error('MCP tools changed after approval; review the tool again');
    try {
      const result = await s.client.callTool(
        { name, arguments: args },
        {
          timeout: this.requestTimeoutMs,
          maxTotalTimeout: this.requestTimeoutMs,
          signal: options.signal
            ? AbortSignal.any([s.controller.signal, options.signal])
            : s.controller.signal,
        },
      );
      if (!this.current(s)) throw new Error('MCP connection changed');
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT)
        throw new Error('MCP tool result exceeds the size limit');
      return this.sanitize(r, result);
    } catch (error) {
      throw new Error(this.redact(r, error.message));
    }
  }
  call(id, name, args, options) {
    return this.callTool(id, name, args, options);
  }
  async listResources(id) {
    const { s } = this.connected(id);
    return s.client.listResources(undefined, {
      timeout: this.requestTimeoutMs,
      signal: s.controller.signal,
    });
  }
  async readResource(id, uri, { signal } = {}) {
    const { s } = this.connected(id);
    return s.client.readResource(
      { uri },
      {
        timeout: this.requestTimeoutMs,
        signal: signal ? AbortSignal.any([s.controller.signal, signal]) : s.controller.signal,
      },
    );
  }
  async listPrompts(id) {
    const { s } = this.connected(id);
    return s.client.listPrompts(undefined, {
      timeout: this.requestTimeoutMs,
      signal: s.controller.signal,
    });
  }
  async getPrompt(id, name, args = {}) {
    const { s } = this.connected(id);
    return s.client.getPrompt(
      { name, arguments: args },
      { timeout: this.requestTimeoutMs, signal: s.controller.signal },
    );
  }
}
