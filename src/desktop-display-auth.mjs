import { randomBytes, createHash } from 'node:crypto';
import { desktopScope, scopeKey, STOPPED_COMPUTER } from './desktop-provider-session.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
// Tickets are short-lived, single-use and carried as a WebSocket subprotocol,
// never in URLs/logs. They do not replace the authenticated session cookie.
export class DesktopDisplayTickets {
  constructor({ clock = () => Date.now(), ttlMs = 15000, maxTickets = 256 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxTickets = maxTickets;
    this.tickets = new Map();
  }
  prune() {
    for (const [k, v] of this.tickets) if (v.expiresAt <= this.clock()) this.tickets.delete(k);
  }
  issue({ scope, sessionId, origin, mode = 'view', lease = null }) {
    desktopScope(scope);
    if (!sessionId || !['view', 'control'].includes(mode))
      throw Error('Authenticated display request required');
    const u = new URL(origin);
    if (u.origin !== origin || !['https:', 'http:'].includes(u.protocol))
      throw Error('Exact configured UI origin required');
    if (mode === 'control' && (!lease || lease.sessionId !== sessionId))
      throw Error('Current control lease required');
    this.prune();
    if (this.tickets.size >= this.maxTickets) throw Error('Too many pending display connections');
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(digest(token), {
      scope: desktopScope(scope),
      sessionId,
      origin,
      mode,
      lease: lease ? structuredClone(lease) : null,
      expiresAt: this.clock() + this.ttlMs,
    });
    return { protocol: 'scx-display.' + token, expiresInMs: this.ttlMs };
  }
  consume({ protocol, scope, sessionId, origin }) {
    this.prune();
    if (!/^scx-display\.[A-Za-z0-9_-]{43}$/.test(protocol || ''))
      throw Error('Display ticket required');
    const key = digest(protocol.slice(12)),
      ticket = this.tickets.get(key);
    if (
      !ticket ||
      ticket.sessionId !== sessionId ||
      ticket.origin !== origin ||
      scopeKey(ticket.scope) !== scopeKey(scope)
    )
      throw Error('Display ticket does not match this session, bot or generation');
    this.tickets.delete(key);
    return ticket;
  }
  revokeSession(sessionId) {
    for (const [key, value] of this.tickets)
      if (value.sessionId === sessionId) this.tickets.delete(key);
  }
}
export function authorizeDisplayUpgrade(req, { origins, authenticate, lookup, tickets }) {
  if (req.method !== 'GET' || !origins.has(req.headers.origin))
    throw Error('Untrusted display origin');
  const identity = authenticate(req);
  if (!identity?.accountId || !identity.sessionId)
    throw Error('Authenticated display session required');
  const url = new URL(req.url, req.headers.origin);
  const match = /^\/api\/desktops\/([A-Za-z0-9_-]{1,128})\/display$/.exec(url.pathname);
  if (!match || url.search || url.hash) throw Error('Exact desktop display route required');
  const record = lookup(identity.accountId, match[1]);
  if (!record || record.state !== 'running') throw Error(STOPPED_COMPUTER);
  const scope = desktopScope({ ...record, accountId: identity.accountId, botId: match[1] });
  const ticket = tickets.consume({
    protocol: req.headers['sec-websocket-protocol'],
    scope,
    sessionId: identity.sessionId,
    origin: req.headers.origin,
  });
  return { scope, ticket };
}
