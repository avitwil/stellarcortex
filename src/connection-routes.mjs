import { createHash, randomBytes } from 'node:crypto';

const cookieValue = (req, name) =>
  req.headers.cookie
    ?.split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(name + '='))
    ?.slice(name.length + 1);
const ownerFor = value =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? createHash('sha256').update(value).digest('hex')
    : null;
export function createConnectionRoutes({ mcp, google, hub, json, body, publish }) {
  const callbackPath = kind =>
    kind === 'google' ? '/api/google/oauth/callback' : '/api/mcp/oauth/callback';
  const ownerCookiePath = kind => (kind === 'google' ? '/api/google' : '/api/mcp');
  const cookieName = kind => `stellarcortex_${kind}_oauth`;
  function callbackUrl(req, kind) {
    const origin = process.env.STELLARCORTEX_PUBLIC_URL
      ? new URL(process.env.STELLARCORTEX_PUBLIC_URL).origin
      : `http://${req.headers.host}`;
    return origin + callbackPath(kind);
  }
  function startOwner(req, res, kind) {
    const name = cookieName(kind),
      existing = cookieValue(req, name),
      nonce = ownerFor(existing) ? existing : randomBytes(32).toString('hex');
    const secure = callbackUrl(req, kind).startsWith('https:') ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `${name}=${nonce}; HttpOnly; SameSite=Lax; Path=${ownerCookiePath(kind)}; Max-Age=600${secure}`,
      // Expire the old, more specific cookie so it cannot shadow the new owner
      // on callbacks during the first ten minutes after upgrading.
      `${name}=; HttpOnly; SameSite=Lax; Path=${callbackPath(kind)}; Max-Age=0${secure}`,
    ]);
    return ownerFor(nonce);
  }
  function checkAuthorization(result) {
    if (!result?.authorizationUrl) return result;
    const url = new URL(result.authorizationUrl);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Authorization requires HTTPS or a loopback URL');
    if (url.username || url.password) throw new Error('Invalid authorization URL');
    return result;
  }
  const changed = () => publish('connections', {});
  return {
    // OAuth redirects are cross-site top-level GETs. The ordinary session cookie
    // is SameSite=Strict, so the short-lived Lax cookie binds the SDK state to the
    // initiating browser without relaxing the application's main session policy.
    async callback(req, res, url) {
      const kind =
        url.pathname === callbackPath('google')
          ? 'google'
          : url.pathname === callbackPath('mcp')
            ? 'mcp'
            : null;
      if (!kind) return false;
      if (req.method !== 'GET') {
        json(res, 405, { error: 'Method not allowed' });
        return true;
      }
      const owner = ownerFor(cookieValue(req, cookieName(kind)));
      if (!owner) {
        json(res, 400, {
          error:
            'This sign-in was not started in this browser, or its connection cookie has expired. Start Connect again.',
        });
        return true;
      }
      let result = 'connected';
      try {
        const input = Object.fromEntries(
          ['state', 'code', 'iss', 'error'].map(key => [
            key,
            url.searchParams.get(key) || undefined,
          ]),
        );
        if (kind === 'google') await google.completeAuth(input, { owner });
        else await mcp.completeAuth(input, { owner });
      } catch {
        result = 'error';
      }
      changed();
      res.writeHead(303, {
        Location: `/?connections=${kind}&result=${result}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      return true;
    },
    async handle(req, res, url) {
      const p = url.pathname;
      if (p === '/api/connections' && req.method === 'GET') {
        json(res, 200, { connections: hub.list() });
        return true;
      }
      if (p === '/api/mcp/connections') {
        if (req.method === 'GET')
          json(res, 200, { ...mcp.list(), redirectUri: callbackUrl(req, 'mcp') });
        else if (req.method === 'POST') {
          const created = await mcp.create(await body(req));
          changed();
          json(res, 201, created);
        } else json(res, 405, { error: 'Method not allowed' });
        return true;
      }
      const match = p.match(/^\/api\/mcp\/connections\/([^/]+)(?:\/(connect|disconnect|tools))?$/);
      if (match) {
        const id = match[1],
          action = match[2];
        mcp.getPublic(id);
        if (!action && req.method === 'PATCH') {
          const result = await mcp.update(id, await body(req));
          changed();
          json(res, 200, result);
        } else if (!action && req.method === 'DELETE') {
          await mcp.remove(id);
          changed();
          json(res, 200, { ok: true });
        } else if (action === 'connect' && req.method === 'POST') {
          const owner = startOwner(req, res, 'mcp');
          const result = checkAuthorization(
            await mcp.connect(id, { owner, redirectUri: callbackUrl(req, 'mcp') }),
          );
          changed();
          json(res, 200, result);
        } else if (action === 'disconnect' && req.method === 'POST') {
          const result = await mcp.disconnect(id);
          changed();
          json(res, 200, result || { ok: true });
        } else if (action === 'tools' && req.method === 'GET')
          json(res, 200, await mcp.listTools(id));
        else json(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (p === '/api/google/status' && req.method === 'GET') {
        json(res, 200, { ...google.status(), redirectUri: callbackUrl(req, 'google') });
        return true;
      }
      if (p === '/api/google/config' && req.method === 'PATCH') {
        const result = await google.configure(await body(req));
        changed();
        json(res, 200, { ...result, redirectUri: callbackUrl(req, 'google') });
        return true;
      }
      if (p === '/api/google/connect' && req.method === 'POST') {
        const owner = startOwner(req, res, 'google');
        json(
          res,
          200,
          checkAuthorization(
            await google.startAuth({ owner, redirectUri: callbackUrl(req, 'google') }),
          ),
        );
        return true;
      }
      if (p === '/api/google/disconnect' && req.method === 'POST') {
        const result = await google.disconnect();
        changed();
        json(res, 200, result || { ok: true });
        return true;
      }
      if (p === '/api/google/tools' && req.method === 'GET') {
        json(res, 200, await google.listTools());
        return true;
      }
      return false;
    },
  };
}
