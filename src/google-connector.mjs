import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { McpSecretStore } from './mcp-secret-store.mjs';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN = 'https://oauth2.googleapis.com/token',
  REVOKE = 'https://oauth2.googleapis.com/revoke';
const scope = name => `https://www.googleapis.com/auth/${name}`;
export const GOOGLE_SERVICES = ['gmail', 'drive', 'docs', 'sheets', 'calendar', 'contacts'];
export const GOOGLE_SCOPES = {
  gmail: {
    read: [scope('gmail.readonly')],
    write: [scope('gmail.readonly'), scope('gmail.compose')],
  },
  drive: { read: [scope('drive.readonly')], write: [scope('drive.readonly'), scope('drive.file')] },
  docs: { read: [scope('documents.readonly')], write: [scope('documents')] },
  sheets: { read: [scope('spreadsheets.readonly')], write: [scope('spreadsheets')] },
  calendar: {
    read: [scope('calendar.readonly')],
    write: [scope('calendar.readonly'), scope('calendar.events')],
  },
  contacts: { read: [scope('contacts.readonly')], write: [scope('contacts')] },
};
const text = (maxLength = 1000) => ({ type: 'string', maxLength }),
  object = { type: 'object', additionalProperties: true },
  array = items => ({ type: 'array', items, maxItems: 100 }),
  page = { pageToken: text(), pageSize: { type: 'integer', minimum: 1, maximum: 100 } },
  enc = value => encodeURIComponent(value);
const def = (name, service, description, properties, required = [], write = false) => ({
  name,
  service,
  write,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: true },
});
const TOOLS = [
  def(
    'gmail_search',
    'gmail',
    'Search messages with Gmail query syntax. Returns IDs and snippets; use gmail_get_message to read one.',
    { query: text(2000), ...page },
  ),
  def(
    'gmail_get_message',
    'gmail',
    'Read one Gmail message, including text parts and attachment metadata.',
    { messageId: text(300) },
    ['messageId'],
  ),
  def(
    'gmail_create_draft',
    'gmail',
    'Create a plain-text email draft. Does not send it.',
    { to: text(2000), cc: text(2000), bcc: text(2000), subject: text(1000), body: text(60000) },
    ['to', 'subject', 'body'],
    true,
  ),
  def(
    'gmail_send_message',
    'gmail',
    'Send a plain-text email from the connected account. Requires explicit approval of recipients and content.',
    { to: text(2000), cc: text(2000), bcc: text(2000), subject: text(1000), body: text(60000) },
    ['to', 'subject', 'body'],
    true,
  ),
  def(
    'drive_list_files',
    'drive',
    'List/search files using Drive query syntax. Pagination is explicit.',
    { query: text(2000), ...page },
  ),
  def(
    'drive_get_file',
    'drive',
    'Get file metadata, including its MIME type and links.',
    { fileId: text(300) },
    ['fileId'],
  ),
  def(
    'drive_read_text',
    'drive',
    'Read a stored UTF-8 text file (up to 256 KiB). For native Google files use Docs/Sheets or drive_export_text.',
    { fileId: text(300) },
    ['fileId'],
  ),
  def(
    'drive_export_text',
    'drive',
    'Export a native Google file as text/plain or text/csv (up to 256 KiB).',
    { fileId: text(300), mimeType: { type: 'string', enum: ['text/plain', 'text/csv'] } },
    ['fileId'],
  ),
  def(
    'drive_create_folder',
    'drive',
    'Create a folder owned by this app. Drive write access is limited to files created by or explicitly shared with this app.',
    { name: text(300), parentId: text(300) },
    ['name'],
    true,
  ),
  def(
    'drive_upload_text',
    'drive',
    'Create a UTF-8 text file in Drive; no binary attachment support.',
    { name: text(300), text: text(60000), parentId: text(300) },
    ['name', 'text'],
    true,
  ),
  def(
    'docs_get_document',
    'docs',
    'Read the native Google Docs document structure.',
    { documentId: text(300) },
    ['documentId'],
  ),
  def(
    'docs_create_document',
    'docs',
    'Create an empty Google document with the supplied title.',
    { title: text(300) },
    ['title'],
    true,
  ),
  def(
    'docs_batch_update',
    'docs',
    'Apply explicit Google Docs batchUpdate requests, such as insertText or formatting. Obtain IDs and indices from the document first.',
    { documentId: text(300), requests: array(object) },
    ['documentId', 'requests'],
    true,
  ),
  def(
    'sheets_get_spreadsheet',
    'sheets',
    'Read spreadsheet and worksheet metadata without downloading all cells.',
    { spreadsheetId: text(300) },
    ['spreadsheetId'],
  ),
  def(
    'sheets_read_range',
    'sheets',
    'Read a specific A1 range of values.',
    { spreadsheetId: text(300), range: text(500) },
    ['spreadsheetId', 'range'],
  ),
  def(
    'sheets_write_range',
    'sheets',
    'Write rows to an explicit A1 range. RAW is the default; choose USER_ENTERED only for intentional formulas or parsed values.',
    {
      spreadsheetId: text(300),
      range: text(500),
      values: array({ type: 'array', items: {}, maxItems: 100 }),
      valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
    },
    ['spreadsheetId', 'range', 'values'],
    true,
  ),
  def(
    'sheets_create_spreadsheet',
    'sheets',
    'Create an empty Google spreadsheet.',
    { title: text(300) },
    ['title'],
    true,
  ),
  def('calendar_list', 'calendar', "List the connected account's calendars.", page),
  def(
    'calendar_list_events',
    'calendar',
    'List events in a calendar, optionally bounded by RFC3339 timestamps or a query.',
    { calendarId: text(300), timeMin: text(100), timeMax: text(100), query: text(1000), ...page },
  ),
  def(
    'calendar_create_event',
    'calendar',
    'Create an event using a Google Calendar event object. sendUpdates defaults to none; invitations require explicit authorization.',
    {
      calendarId: text(300),
      event: object,
      sendUpdates: { type: 'string', enum: ['none', 'all', 'externalOnly'] },
    },
    ['event'],
    true,
  ),
  def(
    'calendar_update_event',
    'calendar',
    'Patch an existing event using its observed ID. sendUpdates defaults to none.',
    {
      calendarId: text(300),
      eventId: text(300),
      event: object,
      sendUpdates: { type: 'string', enum: ['none', 'all', 'externalOnly'] },
    },
    ['eventId', 'event'],
    true,
  ),
  def(
    'contacts_list',
    'contacts',
    'List saved contacts, including names, emails and phone numbers.',
    page,
  ),
  def(
    'contacts_search',
    'contacts',
    'Search saved contacts by prefix.',
    { query: text(1000), pageSize: { type: 'integer', minimum: 1, maximum: 30 } },
    ['query'],
  ),
  def(
    'contacts_create',
    'contacts',
    'Create a saved contact with the supplied name and optional email/phone.',
    { givenName: text(200), familyName: text(200), email: text(500), phone: text(100) },
    ['givenName'],
    true,
  ),
];
const hash = value => createHash('sha256').update(value).digest('hex');
const required = (value, name, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} is required`);
  return value.trim();
};
function validate(schema, value, label = 'Arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be an object`);
    for (const key of schema.required || [])
      if (value[key] === undefined) throw new Error(`${label}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${label}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`Unknown ${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems || 100))
      throw new Error(`${label} must be a bounded array`);
    for (const item of value) validate(schema.items || {}, item, label);
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length > (schema.maxLength || 1000) ||
      value.includes('\0')
    )
      throw new Error(`${label} must be text`);
  } else if (
    schema.type === 'integer' &&
    (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)
  )
    throw new Error(`${label} is out of range`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${label}`);
}
async function readBounded(response, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error('Google response exceeded its size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
function messageText(message) {
  const parts = [];
  const visit = part => {
    if (part.body?.data && ['text/plain', 'text/html'].includes(part.mimeType))
      parts.push({
        mimeType: part.mimeType,
        text: Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 60000),
      });
    if (part.filename)
      parts.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body?.attachmentId,
      });
    for (const child of part.parts || []) visit(child);
  };
  if (message.payload) visit(message.payload);
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    labelIds: message.labelIds,
    headers: message.payload?.headers,
    parts,
  };
}

export class GoogleConnector extends EventEmitter {
  constructor({ dataDir, fetchImpl = fetch, now = () => Date.now() } = {}) {
    super();
    if (!dataDir) throw new Error('Google connector data directory is required');
    this.secretStore = new McpSecretStore(dataDir, 'google-connection');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = new Map();
    this.controllers = new Set();
    this.refreshing = null;
    this.writeQueue = Promise.resolve();
    this.data = {
      version: 1,
      clientId: '',
      clientSecret: '',
      services: [],
      readOnly: true,
      revision: randomUUID(),
      tokens: null,
      email: null,
      ...this.secretStore.data,
    };
    if (
      this.data.version !== 1 ||
      !Array.isArray(this.data.services) ||
      this.data.services.some(s => !GOOGLE_SERVICES.includes(s))
    )
      throw new Error('Invalid saved Google connection');
  }
  scopes() {
    return [
      ...new Set([
        'openid',
        'email',
        ...this.data.services.flatMap(
          service => GOOGLE_SCOPES[service][this.data.readOnly ? 'read' : 'write'],
        ),
      ]),
    ];
  }
  save() {
    this.secretStore.save(this.data);
    this.emit('change', this.status());
  }
  permittedTools() {
    if (!this.data.tokens) return [];
    const granted = new Set(this.data.tokens.scopes || []);
    return TOOLS.filter(
      tool =>
        this.data.services.includes(tool.service) &&
        (!tool.write || !this.data.readOnly) &&
        this.toolScopes(tool).some(scope => granted.has(scope)),
    );
  }
  toolScopes(tool) {
    const read = GOOGLE_SCOPES[tool.service].read,
      write = GOOGLE_SCOPES[tool.service].write;
    return tool.write
      ? write.filter(value => !read.includes(value))
      : [
          ...new Set([
            ...read,
            ...write.filter(
              value =>
                !['drive.file', 'gmail.compose', 'calendar.events'].some(
                  suffix => value === scope(suffix),
                ),
            ),
          ]),
        ];
  }
  status() {
    return {
      id: 'google',
      name: 'Google',
      kind: 'google',
      configured: !!(this.data.clientId && this.data.clientSecret && this.data.services.length),
      connected: !!this.data.tokens,
      status: this.data.tokens ? 'connected' : 'disconnected',
      clientId: this.data.clientId,
      hasClientSecret: !!this.data.clientSecret,
      services: [...this.data.services],
      readOnly: this.data.readOnly,
      email: this.data.email,
      revision: this.data.revision,
      scopes: this.scopes(),
      grantedScopes: this.data.tokens?.scopes || [],
      toolCount: this.permittedTools().length,
      availableServices: [...GOOGLE_SERVICES],
    };
  }
  invalidate() {
    for (const controller of this.controllers)
      controller.abort(new Error('Google connection changed'));
    this.pending.clear();
    this.refreshing = null;
    this.data.revision = randomUUID();
    this.data.tokens = null;
    this.data.email = null;
  }
  configure(input = {}) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        key => !['clientId', 'clientSecret', 'services', 'readOnly'].includes(key),
      )
    )
      throw new Error('Unsupported Google setting');
    const next = { ...this.data };
    if (input.clientId !== undefined) {
      next.clientId = required(input.clientId, 'OAuth client ID', 500);
      if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(next.clientId))
        throw new Error('Use the Google Web application OAuth client ID');
      if (this.data.clientId && next.clientId !== this.data.clientId && !input.clientSecret)
        throw new Error('Supply the matching client secret when changing client ID');
    }
    if (input.clientSecret !== undefined) {
      if (
        typeof input.clientSecret !== 'string' ||
        input.clientSecret.length > 4096 ||
        /[\u0000-\u0020\u007f]/.test(input.clientSecret)
      )
        throw new Error('Invalid OAuth client secret');
      if (input.clientSecret) next.clientSecret = input.clientSecret;
    }
    if (input.services !== undefined) {
      if (!Array.isArray(input.services) || input.services.some(s => !GOOGLE_SERVICES.includes(s)))
        throw new Error('Choose supported Google services');
      next.services = [...new Set(input.services)].sort();
    }
    if (input.readOnly !== undefined) {
      if (typeof input.readOnly !== 'boolean') throw new Error('readOnly must be true or false');
      next.readOnly = input.readOnly;
    }
    if (
      ['clientId', 'clientSecret', 'readOnly'].some(key => next[key] !== this.data[key]) ||
      JSON.stringify(next.services) !== JSON.stringify(this.data.services)
    ) {
      this.invalidate();
      this.data = { ...next, revision: this.data.revision, tokens: null, email: null };
      this.save();
    }
    return this.status();
  }
  startAuth({ redirectUri, owner } = {}) {
    if (!this.status().configured)
      throw new Error('Configure a Google OAuth client and select services first');
    required(owner, 'Sign-in browser owner', 1000);
    let redirect;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw new Error('Invalid Google callback URL');
    }
    if (
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      (redirect.protocol !== 'https:' &&
        !(
          redirect.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
        ))
    )
      throw new Error(
        'Google callback requires HTTPS or localhost and no credentials/query/fragment',
      );
    for (const [state, record] of this.pending)
      if (record.expires < this.now()) this.pending.delete(state);
    if (this.pending.size >= 20) throw new Error('Too many pending Google sign-ins');
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(48).toString('base64url'),
      scopes = this.scopes();
    this.pending.set(state, {
      owner: hash(owner),
      redirectUri: redirect.href,
      verifier,
      scopes,
      revision: this.data.revision,
      expires: this.now() + 600000,
    });
    const url = new URL(AUTH);
    for (const [key, value] of Object.entries({
      client_id: this.data.clientId,
      redirect_uri: redirect.href,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    return { authorizationUrl: url.href };
  }
  async completeAuth({ state, code, error, iss } = {}, { owner } = {}) {
    const record = this.pending.get(state);
    if (
      !record ||
      record.expires < this.now() ||
      record.revision !== this.data.revision ||
      typeof owner !== 'string' ||
      !timingSafeEqual(Buffer.from(record.owner), Buffer.from(hash(owner)))
    )
      throw new Error('Google sign-in expired or was not started in this browser');
    this.pending.delete(state);
    if (error) throw new Error('Google sign-in was declined');
    if (iss && !['https://accounts.google.com', 'accounts.google.com'].includes(iss))
      throw new Error('Unexpected Google authorization issuer');
    required(code, 'Authorization code', 8000);
    const revision = this.data.revision,
      tokens = await this.request(TOKEN, {
        form: {
          code,
          client_id: this.data.clientId,
          client_secret: this.data.clientSecret,
          redirect_uri: record.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: record.verifier,
        },
        secrets: [code, record.verifier],
      });
    if (revision !== this.data.revision) throw new Error('Google settings changed during sign-in');
    if (
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token ||
      tokens.token_type?.toLowerCase() !== 'bearer'
    )
      throw new Error('Google returned invalid authorization credentials');
    const granted =
      typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : record.scopes;
    let email = null;
    try {
      const user = await this.request('https://openidconnect.googleapis.com/v1/userinfo', {
        accessToken: tokens.access_token,
      });
      if (user.email_verified !== false && typeof user.email === 'string')
        email = user.email.slice(0, 320);
    } catch {}
    if (revision !== this.data.revision) throw new Error('Google settings changed during sign-in');
    this.invalidate();
    this.data.tokens = {
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
      expiresAt: this.now() + Math.max(1, Number(tokens.expires_in) || 3600) * 1000,
      scopes: granted,
    };
    this.data.email = email;
    this.save();
    return this.status();
  }
  async request(
    url,
    {
      method = 'GET',
      json,
      form,
      raw,
      contentType,
      accessToken,
      signal,
      textResponse = false,
      secrets = [],
    } = {},
  ) {
    const secretValues = [
      this.data.clientSecret,
      this.data.tokens?.accessToken,
      this.data.tokens?.refreshToken,
      accessToken,
      ...secrets,
      ...['client_secret', 'refresh_token', 'token', 'code', 'code_verifier'].map(
        key => form?.[key],
      ),
    ].filter(value => typeof value === 'string' && value);
    const parsed = new URL(url),
      hosts = [
        'oauth2.googleapis.com',
        'openidconnect.googleapis.com',
        'gmail.googleapis.com',
        'www.googleapis.com',
        'docs.googleapis.com',
        'sheets.googleapis.com',
        'people.googleapis.com',
      ];
    if (
      parsed.protocol !== 'https:' ||
      !hosts.includes(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new Error('Google request must use an official API endpoint');
    const controller = new AbortController(),
      abort = () => controller.abort(signal?.reason || new Error('Google request cancelled'));
    this.controllers.add(controller);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Google request timed out')),
      30000,
    );
    timeout.unref();
    const headers = { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };
    let body;
    if (form) {
      method = 'POST';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      headers['Content-Type'] = contentType;
      body = raw;
    }
    try {
      const response = await this.fetchImpl(parsed.href, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'error',
        }),
        text = await readBounded(
          response,
          response.ok ? (textResponse ? 256 * 1024 : 2 * 1024 * 1024) : 8192,
        );
      if (!response.ok) {
        let reason;
        try {
          const value = JSON.parse(text);
          reason = typeof value.error === 'string' ? value.error : value.error?.message;
        } catch {}
        throw new Error(`Google HTTP ${response.status}: ${reason || 'Request failed'}`);
      }
      if (textResponse) return text;
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Google returned invalid JSON');
      }
    } catch (error) {
      let message = String(error.message || error);
      for (const secret of secretValues)
        for (const value of [secret, encodeURIComponent(secret)])
          message = message.split(value).join('[redacted]');
      throw new Error(message.slice(0, 1000));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }
  async accessToken() {
    const tokens = this.data.tokens;
    if (!tokens) throw new Error('Connect your Google account in Settings');
    if (tokens.expiresAt > this.now() + 60000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new Error('Google access expired. Connect again in Settings');
    if (this.refreshing) return this.refreshing;
    const revision = this.data.revision;
    const pending = (async () => {
      try {
        const result = await this.request(TOKEN, {
          form: {
            client_id: this.data.clientId,
            client_secret: this.data.clientSecret,
            refresh_token: tokens.refreshToken,
            grant_type: 'refresh_token',
          },
        });
        if (revision !== this.data.revision)
          throw new Error('Google connection changed during token refresh');
        if (typeof result.access_token !== 'string' || !result.access_token)
          throw new Error('Google returned an invalid refreshed token');
        const scopes = typeof result.scope === 'string' ? result.scope.split(/\s+/) : tokens.scopes;
        if (JSON.stringify([...scopes].sort()) !== JSON.stringify([...tokens.scopes].sort()))
          this.data.revision = randomUUID();
        this.data.tokens = {
          ...tokens,
          accessToken: result.access_token,
          refreshToken: result.refresh_token || tokens.refreshToken,
          expiresAt: this.now() + Math.max(1, Number(result.expires_in) || 3600) * 1000,
          scopes,
        };
        this.save();
        return result.access_token;
      } catch (error) {
        if (revision === this.data.revision && /invalid_grant/.test(error.message)) {
          this.invalidate();
          this.save();
        }
        throw error;
      }
    })();
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
  }
  async disconnect() {
    const token = this.data.tokens?.refreshToken || this.data.tokens?.accessToken;
    this.invalidate();
    this.save();
    let warning;
    if (token)
      try {
        await this.request(REVOKE, { form: { token }, secrets: [token] });
      } catch {
        warning =
          'Disconnected locally; Google token revocation could not be confirmed. You can remove access in your Google account.';
      }
    return { ...this.status(), ...(warning ? { warning } : {}) };
  }
  async listTools() {
    return {
      tools: this.permittedTools().map(({ service, write, ...tool }) => tool),
      revision: this.data.revision,
    };
  }
  async callTool(name, args = {}, options = {}) {
    const selected = this.permittedTools().find(tool => tool.name === name);
    if (!selected)
      throw new Error(
        'This Google tool is unavailable for the selected services, access mode or granted scopes',
      );
    validate(selected.inputSchema, args);
    if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024)
      throw new Error('Google tool arguments exceed 64 KiB');
    const revision = options.expectedRevision ?? this.data.revision;
    const execute = async () => {
      if (options.signal?.aborted) throw new Error('Google tool call cancelled');
      if (revision !== this.data.revision)
        throw new Error('Google connection changed after approval');
      const token = await this.accessToken();
      if (revision !== this.data.revision)
        throw new Error('Google connection or permissions changed after approval');
      const call = (url, input = {}) => {
        if (options.signal?.aborted) throw new Error('Google tool call cancelled');
        if (revision !== this.data.revision)
          throw new Error('Google connection changed after approval');
        return this.request(url, { ...input, accessToken: token, signal: options.signal });
      };
      const secrets = [token, this.data.clientSecret, this.data.tokens?.refreshToken].filter(
          Boolean,
        ),
        result = await this.execute(name, args, call);
      if (options.signal?.aborted || revision !== this.data.revision)
        throw new Error('Google connection changed or the tool call was cancelled');
      let text = typeof result === 'string' ? result : JSON.stringify(result);
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      return { content: [{ type: 'text', text }] };
    };
    if (!selected.write) return execute();
    const result = this.writeQueue.then(execute, execute);
    this.writeQueue = result.catch(() => {});
    return result;
  }
  async execute(name, a, call) {
    const query = (base, values) => {
      const url = new URL(base);
      for (const [key, value] of Object.entries(values))
        if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
      return url.href;
    };
    const drive = 'https://www.googleapis.com/drive/v3/files',
      docs = 'https://docs.googleapis.com/v1/documents',
      sheets = 'https://sheets.googleapis.com/v4/spreadsheets',
      calendar = 'https://www.googleapis.com/calendar/v3',
      people = 'https://people.googleapis.com/v1';
    if (name === 'gmail_search')
      return call(
        query('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
          q: a.query,
          maxResults: a.pageSize || 50,
          pageToken: a.pageToken,
        }),
      );
    if (name === 'gmail_get_message')
      return messageText(
        await call(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${enc(a.messageId)}?format=full`,
        ),
      );
    if (name === 'gmail_create_draft' || name === 'gmail_send_message') {
      for (const key of ['to', 'cc', 'bcc', 'subject'])
        if (/[\r\n]/.test(a[key] || ''))
          throw new Error('Email header fields cannot contain newlines');
      const profile = this.data.email
        ? { emailAddress: this.data.email }
        : await call('https://gmail.googleapis.com/gmail/v1/users/me/profile');
      const from = required(profile.emailAddress, 'Connected account email', 320);
      if (/[\r\n]/.test(from)) throw new Error('Invalid connected email');
      const headers = [
        `From: ${from}`,
        `To: ${a.to}`,
        ...(a.cc ? [`Cc: ${a.cc}`] : []),
        ...(a.bcc ? [`Bcc: ${a.bcc}`] : []),
        `Subject: =?UTF-8?B?${Buffer.from(a.subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
      ];
      const encodedBody = (
          Buffer.from(a.body)
            .toString('base64')
            .match(/.{1,76}/g) || []
        ).join('\r\n'),
        raw = Buffer.from(headers.join('\r\n') + '\r\n\r\n' + encodedBody).toString('base64url');
      return call(
        `https://gmail.googleapis.com/gmail/v1/users/me/${name === 'gmail_create_draft' ? 'drafts' : 'messages/send'}`,
        { method: 'POST', json: name === 'gmail_create_draft' ? { message: { raw } } : { raw } },
      );
    }
    if (name === 'drive_list_files')
      return call(
        query(drive, {
          q: a.query,
          pageSize: a.pageSize || 50,
          pageToken: a.pageToken,
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)',
        }),
      );
    if (name === 'drive_get_file')
      return call(
        `${drive}/${enc(a.fileId)}?fields=id,name,mimeType,size,modifiedTime,webViewLink,parents,description`,
      );
    if (name === 'drive_read_text')
      return call(`${drive}/${enc(a.fileId)}?alt=media`, { textResponse: true });
    if (name === 'drive_export_text')
      return call(
        query(`${drive}/${enc(a.fileId)}/export`, { mimeType: a.mimeType || 'text/plain' }),
        { textResponse: true },
      );
    if (name === 'drive_create_folder')
      return call(drive, {
        method: 'POST',
        json: {
          name: a.name,
          mimeType: 'application/vnd.google-apps.folder',
          ...(a.parentId ? { parents: [a.parentId] } : {}),
        },
      });
    if (name === 'drive_upload_text') {
      const boundary = 'stellarcortex_' + randomBytes(16).toString('hex'),
        metadata = {
          name: a.name,
          mimeType: 'text/plain',
          ...(a.parentId ? { parents: [a.parentId] } : {}),
        };
      const raw = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.text}\r\n--${boundary}--`;
      return call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        raw,
        contentType: `multipart/related; boundary=${boundary}`,
      });
    }
    if (name === 'docs_get_document') return call(`${docs}/${enc(a.documentId)}`);
    if (name === 'docs_create_document')
      return call(docs, { method: 'POST', json: { title: a.title } });
    if (name === 'docs_batch_update')
      return call(`${docs}/${enc(a.documentId)}:batchUpdate`, {
        method: 'POST',
        json: { requests: a.requests },
      });
    if (name === 'sheets_get_spreadsheet')
      return call(
        `${sheets}/${enc(a.spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties,sheets.properties`,
      );
    if (name === 'sheets_read_range')
      return call(`${sheets}/${enc(a.spreadsheetId)}/values/${enc(a.range)}`);
    if (name === 'sheets_write_range')
      return call(
        query(`${sheets}/${enc(a.spreadsheetId)}/values/${enc(a.range)}`, {
          valueInputOption: a.valueInputOption || 'RAW',
        }),
        { method: 'PUT', json: { range: a.range, majorDimension: 'ROWS', values: a.values } },
      );
    if (name === 'sheets_create_spreadsheet')
      return call(sheets, { method: 'POST', json: { properties: { title: a.title } } });
    if (name === 'calendar_list')
      return call(
        query(`${calendar}/users/me/calendarList`, {
          maxResults: a.pageSize || 50,
          pageToken: a.pageToken,
        }),
      );
    const events = `${calendar}/calendars/${enc(a.calendarId || 'primary')}/events`;
    if (name === 'calendar_list_events')
      return call(
        query(events, {
          q: a.query,
          timeMin: a.timeMin,
          timeMax: a.timeMax,
          maxResults: a.pageSize || 50,
          pageToken: a.pageToken,
          singleEvents: true,
          orderBy: 'startTime',
        }),
      );
    if (name === 'calendar_create_event' || name === 'calendar_update_event')
      return call(
        query(events + (name === 'calendar_update_event' ? `/${enc(a.eventId)}` : ''), {
          sendUpdates: a.sendUpdates || 'none',
        }),
        { method: name === 'calendar_create_event' ? 'POST' : 'PATCH', json: a.event },
      );
    if (name === 'contacts_list')
      return call(
        query(`${people}/people/me/connections`, {
          personFields: 'names,emailAddresses,phoneNumbers',
          pageSize: a.pageSize || 50,
          pageToken: a.pageToken,
        }),
      );
    if (name === 'contacts_search')
      return call(
        query(`${people}/people:searchContacts`, {
          query: a.query,
          readMask: 'names,emailAddresses,phoneNumbers',
          pageSize: a.pageSize || 30,
        }),
      );
    if (name === 'contacts_create')
      return call(`${people}/people:createContact`, {
        method: 'POST',
        json: {
          names: [
            { givenName: a.givenName, ...(a.familyName ? { familyName: a.familyName } : {}) },
          ],
          ...(a.email ? { emailAddresses: [{ value: a.email }] } : {}),
          ...(a.phone ? { phoneNumbers: [{ value: a.phone }] } : {}),
        },
      });
    throw new Error('Unknown Google tool');
  }
  async close() {
    for (const controller of this.controllers) controller.abort(new Error('Server stopped'));
    this.pending.clear();
  }
}
