// Keep secret values in their form fields. This helper copies only explicitly
// permitted, non-secret values into a temporary UI draft.
export function nonSecretFields(source = {}, allowed = []) {
  const result = {};
  for (const key of allowed) {
    if (/secret|token|password|authorization|api.?key/i.test(key)) continue;
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
      result[key] = value;
    else if (Array.isArray(value) && value.every(item => typeof item === 'string'))
      result[key] = [...value];
  }
  return result;
}

export function commandArguments(value = '') {
  if (Array.isArray(value)) {
    if (value.some(item => typeof item !== 'string')) throw new Error('arguments-array');
    return [...value];
  }
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('arguments-json');
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string'))
      throw new Error('arguments-array');
    return parsed;
  }
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

export function oauthAuthorizationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return url.href;
  return null;
}

export const MCP_TRANSPORTS = ['streamable-http', 'sse', 'stdio'];
export const MCP_AUTH_TYPES = ['none', 'bearer', 'header', 'oauth'];
export function mcpConnectionDraft(record = {}) {
  const safe = nonSecretFields(record, [
    'id',
    'name',
    'url',
    'command',
    'args',
    'cwd',
    'headerName',
    'oauthClientId',
    'oauthScope',
  ]);
  return {
    name: '',
    url: '',
    command: '',
    args: [],
    cwd: '',
    headerName: '',
    oauthClientId: '',
    oauthScope: '',
    ...safe,
    transport: MCP_TRANSPORTS.includes(record.transport) ? record.transport : 'streamable-http',
    authType: MCP_AUTH_TYPES.includes(record.authType) ? record.authType : 'none',
  };
}
export function environmentValues(value = '') {
  if (!String(value).trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('environment-json');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some(item => typeof item !== 'string')
  )
    throw new Error('environment-object');
  return parsed;
}
export function mcpConnectionPayload(draft, secrets = {}) {
  const safe = mcpConnectionDraft(draft),
    payload = {
      name: safe.name.trim(),
      transport: safe.transport,
      authType: safe.transport === 'stdio' ? 'none' : safe.authType,
    };
  if (safe.transport === 'stdio') {
    Object.assign(payload, {
      command: safe.command.trim(),
      args: commandArguments(safe.args),
      cwd: safe.cwd.trim(),
    });
    const env = environmentValues(secrets.env);
    if (env !== undefined) payload.env = env;
  } else {
    payload.url = safe.url.trim();
    if (['bearer', 'header'].includes(safe.authType) && String(secrets.token || '').trim())
      payload.token = String(secrets.token).trim();
    if (safe.authType === 'header') payload.headerName = safe.headerName.trim();
    if (safe.authType === 'oauth') {
      Object.assign(payload, {
        oauthClientId: safe.oauthClientId.trim(),
        oauthScope: safe.oauthScope.trim(),
      });
      if (String(secrets.oauthClientSecret || '').trim())
        payload.oauthClientSecret = String(secrets.oauthClientSecret).trim();
    }
  }
  if (secrets.removeToken === true) payload.removeToken = true;
  if (secrets.removeClientSecret === true) payload.removeClientSecret = true;
  return payload;
}

export function safeMcpConnection(record = {}) {
  return {
    ...mcpConnectionDraft(record),
    ...nonSecretFields(record, [
      'id',
      'envKeys',
      'status',
      'error',
      'toolCount',
      'revision',
      'enabled',
    ]),
    hasToken: record.hasToken === true,
    hasClientSecret: record.hasClientSecret === true,
  };
}
