import { loadDesktopIsolation } from './desktop-isolation-config.mjs';
import { DESIGNS } from '../public/themes/design.js';
import { uiJson } from './ui-json.mjs';
import { OwnerSessions } from './owner-sessions.mjs';
import { loadDesktopProvider } from './desktop-provider-config.mjs';
import { DesktopDisplayTickets } from './desktop-display-auth.mjs';
import { DesktopDisplayGateway } from './desktop-display-gateway.mjs';
import { createDesktopProviderRoutes } from './desktop-provider-routes.mjs';
import { prepareGuestSocket as preparePrivateSocket } from './guest-worker.mjs';
import { saveDemonstration, saveReviewedFrame } from './computer-demonstration.mjs';
import http from 'node:http';
import { createKanbanEngineExecutor } from './kanban-engine.mjs';
import { Kanban } from './kanban.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  Store,
  id,
  now,
  required,
  safeFile,
  markRun,
  installationKey,
  ownerAccount,
} from './store.mjs';
import { Codex } from './codex.mjs';
import { Claude } from './claude.mjs';
import { claudeUsageSnapshot } from './claude-usage.mjs';
import { HttpProvider } from './http-provider.mjs';
import { ProviderConnections } from './provider-connections.mjs';
import { createVoiceSession, VOICE_MODEL, VOICE_NAME } from './voice.mjs';
import { McpConnections } from './mcp-connections.mjs';
import { removeGoogleConnection, revokeRemovedGoogle } from './google-removal.mjs';
import { ConnectionHub } from './connection-hub.mjs';
import { createConnectionRoutes } from './connection-routes.mjs';
import { Engine } from './engine.mjs';
import { BrowserWorkspace } from './browser.mjs';
import { DesktopWorkspace } from './desktop.mjs';
import { acquireLock } from './lock.mjs';
import { modelFields, resolveModelSettings } from './models.mjs';
import { permissionSnapshot, setClaudePermission } from './claude-permissions.mjs';
import { computerSnapshot, setComputerMode } from './computer-mode.mjs';
import { SECRET_LIMIT } from './secret-login.mjs';
import { SoftwareUpdates } from './software-updates.mjs';
import { appOrigin, managedUpdateClient, UPDATE_PROTOCOL } from './managed-updates.mjs';
import { ClaudeLogin, claudeLoginCommand } from './claude-login.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// A tailnet address alone is enough: the socket has one possible place, in the data folder.
export const defaultUiSocket = (env, dataDir) =>
  env.STELLARCORTEX_UI_SOCKET ||
  (env.STELLARCORTEX_TAILNET_UI_URL ? path.join(path.resolve(dataDir), 'tailscale-ui.sock') : null);
export const defaultData = () => {
  if (process.env.STELLARCORTEX_DATA_DIR) return process.env.STELLARCORTEX_DATA_DIR;
  const local = path.join(ROOT, 'stellarcortex.local.json');
  if (fs.existsSync(local)) {
    const cfg = JSON.parse(fs.readFileSync(local, 'utf8'));
    if (typeof cfg.dataDir === 'string') return path.resolve(ROOT, cfg.dataDir);
  }
  return path.join(os.homedir(), '.stellarcortex');
};
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const DESIGN_IDS = DESIGNS.map(design => design.id);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};
// Why this install has no virtual computer. The install step writes it, and Settings says it in the owner's language.
function readInstallNote(dir) {
  try {
    const note = JSON.parse(fs.readFileSync(path.join(dir, 'computer-install.json'), 'utf8'));
    return typeof note.code === 'string' ? { code: note.code } : {};
  } catch {
    return {};
  }
}
export async function createApp({
  dataDir = defaultData(),
  port = Number(process.env.PORT || 4317),
  host = process.env.STELLARCORTEX_BIND || '127.0.0.1',
  uiSocket = defaultUiSocket(process.env, dataDir),
  trustedUiOrigin = process.env.STELLARCORTEX_TAILNET_UI_URL || null,
  runtime,
  claudeRuntime = new Claude(),
  httpRuntimes = {},
  desktopRuntime,
  guestExecution = null,
  desktopProvider = null,
  kanbanEngine = false,
  kanbanExecutor = null,
  kanbanResources,
  startEngine = true,
  bootProbe = false,
  voiceSessionFactory = createVoiceSession,
  mcpService,
  googleRevoke,
  softwareUpdates = new SoftwareUpdates({ root: ROOT, manager: managedUpdateClient() }),
} = {}) {
  let guestCodex = null;
  if (!runtime) {
    runtime = new Codex();
    if (guestExecution?.providerIsolation?.codex)
      guestCodex = new Codex({
        guestMode: true,
        executable: guestExecution.codexExecutable || null,
      });
  }
  // The pin is in a root-owned file, so this works for a system or a user service with no setting in either.
  if (guestExecution?.claudeExecutable)
    claudeRuntime.command = { bin: guestExecution.claudeExecutable, prefix: [] };
  const releaseLock = acquireLock(path.resolve(dataDir));
  let store, connections, mcp, server, unixServer;
  try {
    store = new Store(path.resolve(dataDir));
    removeGoogleConnection(store);
    connections = new ProviderConnections(store.dir);
    mcp =
      mcpService ||
      new McpConnections({
        dataDir: store.dir,
        callbackUrl: () =>
          `${process.env.STELLARCORTEX_PUBLIC_URL?.replace(/\/+$/, '') || `http://127.0.0.1:${server?.address()?.port || port}`}/api/mcp/oauth/callback`,
      });
  } catch (e) {
    releaseLock();
    throw e;
  }
  void revokeRemovedGoogle(store.dir, googleRevoke);
  const connectionHub = new ConnectionHub({ mcp });
  const apiProviders = Object.fromEntries(
    connections.ids().map(provider => [
      provider,
      httpRuntimes[provider] ||
        new HttpProvider({
          provider,
          getConfig: () => connections.get(provider),
          dataDir: store.dir,
        }),
    ]),
  );
  const browser = new BrowserWorkspace(store.dir),
    desktop = desktopRuntime || new DesktopWorkspace(store.dir),
    engine = new Engine(store, runtime, browser, desktop, {
      providers: { claude: claudeRuntime, ...apiProviders },
      connections: connectionHub,
      guestExecution,
      guestCodex,
      defaultVm: !!guestExecution && desktopProvider?.environmentPolicy?.defaultAccess !== false,
    });
  const claudeLogin = new ClaudeLogin(() => engine.runtimeFor('claude'));
  const execution =
    kanbanExecutor ||
    (kanbanEngine
      ? createKanbanEngineExecutor({
          engine,
          enabled: true,
          requireReports: true,
          manualOnly: true,
        })
      : null);
  const kanban = new Kanban(store, {
    executor: execution,
    ...(kanbanResources ? { resources: kanbanResources } : {}),
  });
  // Sessions follow the bots by themselves, apart from any turn. A stuck broker holds up only this.
  const syncComputer = () => {
      desktopProvider?.syncSessions?.(bot => engine.computerOf(bot) === 'vm').catch(() => {});
    },
    computerTimer = setInterval(syncComputer, 15000);
  computerTimer.unref();
  const kanbanTimer = setInterval(() => {
    if (!engine.maintenance && !closing) kanban.tick().catch(() => {});
  }, 1000);
  kanbanTimer.unref();
  const accessKey = installationKey(store.dir),
    owner = ownerAccount(store.dir),
    sessions = new OwnerSessions(store.dir, accessKey),
    clients = new Set(),
    attempts = new Map();
  let runtimeError = null,
    closing = false,
    shutdown,
    shutdownPromise,
    updateInProgress = false,
    voiceActiveUntil = 0,
    inFlightOperations = 0;
  engine.maintenance = bootProbe;
  const publish = (event, data) => {
    const frame = `event: ${event}\ndata: ${uiJson(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  let updateTimer;
  store.on('change', () => {
    if (!updateTimer)
      updateTimer = setTimeout(() => {
        updateTimer = null;
        publish('change', {});
      }, 150);
  });
  for (const e of ['delta', 'activity', 'completed', 'runtime', 'account'])
    engine.on(e, d => publish(e, d));
  const json = (res, status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(uiJson(data));
  };
  // No JSON parser and no error text from the body: a password must not reach a string it did not need.
  async function secretBody(req) {
    const value = Buffer.alloc(SECRET_LIMIT);
    let size = 0,
      tooLarge = false;
    for await (const part of req) {
      if (!tooLarge && size + part.length <= SECRET_LIMIT) {
        part.copy(value, size);
        size += part.length;
      } else tooLarge = true;
      part.fill(0);
    }
    if (tooLarge) {
      value.fill(0);
      return null;
    }
    return value.subarray(0, size);
  }
  async function body(req) {
    let size = 0,
      parts = [];
    for await (const p of req) {
      size += p.length;
      if (size > 36 * 1024 * 1024) throw new Error('Request exceeds 36 MB');
      parts.push(p);
    }
    if (!parts.length) return {};
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new Error('Request body must be valid JSON');
    }
  }
  const connectionRoutes = createConnectionRoutes({
    mcp,
    hub: connectionHub,
    json,
    body,
    publish,
  });
  mcp.on?.('change', () => publish('connections', {}));
  const providerNames = {
    codex: 'Codex',
    claude: 'Claude',
    ...Object.fromEntries(
      connections.ids().map(provider => [provider, connections.public(provider).name]),
    ),
  };
  const verifiedConnections = new Map();
  const voiceAttempts = new Map();
  const usageState = () =>
    store.data.providerUsage
      ? {
          ...store.data.providerUsage,
          ...(store.data.providerUsage.claude
            ? { claude: claudeUsageSnapshot(store.data.providerUsage.claude) }
            : {}),
        }
      : {};
  const emptyCatalog = error => ({
    models: [],
    defaultModel: null,
    defaultModelKnown: false,
    defaultModelError: error,
    modelsError: error,
    modelsStale: false,
  });
  async function providerAccount(provider, { catalog = true, refresh = false } = {}) {
    if (!Object.hasOwn(providerNames, provider)) throw new Error('Unknown provider');
    const isHttp = connections.has(provider),
      selected = engine.runtimeFor(provider),
      revision = isHttp ? connections.get(provider).revision : null,
      info = {
        ...(isHttp ? connections.public(provider) : {}),
        id: provider,
        name: providerNames[provider],
        loginInstructions: isHttp
          ? null
          : provider === 'claude'
            ? claudeLoginCommand()
            : 'npx codex login --device-auth',
        loginHost: 'server',
        setupUrl: provider === 'claude' ? 'https://code.claude.com/docs/en/setup' : null,
      };
    try {
      await selected.start();
    } catch (error) {
      return {
        ...info,
        installed: selected.installed === true,
        connected: false,
        account: null,
        error: error.message,
        ...emptyCatalog(error.message),
      };
    }
    if (refresh) engine.catalog(provider).invalidate();
    const [account, models, usage, connectors] = await Promise.allSettled([
      selected.request('account/read', { refreshToken: false }),
      catalog ? engine.catalog(provider).get() : Promise.resolve({}),
      catalog
        ? selected.request('account/rateLimits/read', { force: refresh })
        : Promise.resolve(null),
      catalog && provider === 'codex'
        ? selected.request('mcpServerStatus/list', {}, 15000)
        : Promise.resolve({ data: [] }),
    ]);
    if (isHttp && revision !== connections.get(provider).revision)
      return {
        ...info,
        ...connections.public(provider),
        connected: false,
        account: null,
        error: 'The connection changed during the check. Check it again.',
        ...emptyCatalog('Connection changed'),
      };
    const identity = account.status === 'fulfilled' ? account.value.account : null;
    if (isHttp && catalog) {
      const verified =
        models.status === 'fulfilled' &&
        !models.value.modelsError &&
        models.value.models?.some(
          model => model.catalogSource === 'provider' && model.availability === 'listed',
        );
      verifiedConnections.set(provider, {
        revision,
        connected: !!verified,
        verifiedAt: new Date().toISOString(),
      });
    }
    const verified = verifiedConnections.get(provider);
    const connected = isHttp
      ? !!identity && verified?.revision === revision && verified.connected
      : provider === 'claude'
        ? identity?.type === 'claude'
        : ['chatgpt', 'chatgptAuthTokens'].includes(identity?.type);
    const error =
      account.status === 'rejected' ? account.reason.message : account.value.error || null;
    const usageData =
      usage.status === 'fulfilled'
        ? usage.value
        : provider === 'claude'
          ? claudeUsageSnapshot(store.data.providerUsage?.claude, { error: usage.reason.message })
          : null;
    return {
      ...info,
      installed: true,
      connected: !!connected,
      ...(isHttp
        ? { verifiedAt: verified?.revision === revision ? verified.verifiedAt : null }
        : {}),
      account: identity,
      ...(models.status === 'fulfilled' ? models.value : emptyCatalog(models.reason.message)),
      usage: usageData,
      usageError: usage.status === 'rejected' ? usage.reason.message : null,
      connectors: connectors.status === 'fulfilled' ? connectors.value.data : [],
      error,
    };
  }
  const sessionToken = req =>
    req.headers.cookie
      ?.split(';')
      .map(s => s.trim())
      .find(s => s.startsWith('stellarcortex_session='))
      ?.slice('stellarcortex_session='.length);
  const authenticated = req => {
    const token = sessionToken(req),
      expires = sessions.get(token);
    if (!expires || expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };
  const desktopIdentity = req => {
    if (!authenticated(req)) return null;
    const token = sessionToken(req);
    return {
      accountId: owner,
      sessionId: createHash('sha256').update(token).digest('hex'),
    };
  };
  desktopProvider?.attachStore?.(store);
  if (desktopProvider) desktopProvider.onHandBack = botId => engine.noteHandBack(store.bot(botId));
  const desktopTickets = new DesktopDisplayTickets();
  let desktopGateway = null;
  const desktopRoutes = desktopProvider
    ? createDesktopProviderRoutes({
        provider: desktopProvider,
        authenticate: desktopIdentity,
        tickets: desktopTickets,
        coordinator: desktopProvider.coordinator,
        json,
        body,
      })
    : null;
  server = http.createServer(async (req, res) => {
    const requestPath = req.url?.split('?')[0];
    const trackOperation =
      (requestPath?.startsWith('/api/') || requestPath?.startsWith('/hooks/')) &&
      !['/api/software-update/apply', '/api/events', '/api/state', '/api/software-update'].includes(
        requestPath,
      );
    if (trackOperation) inFlightOperations++;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    );
    try {
      const actualPort = server.address()?.port || port;
      let requestHost = req.headers.host,
        overTailnet = false;
      const hosts = new Set([
        `127.0.0.1:${actualPort}`,
        `localhost:${actualPort}`,
        `[::1]:${actualPort}`,
      ]);
      if (process.env.STELLARCORTEX_PUBLIC_URL)
        hosts.add(new URL(process.env.STELLARCORTEX_PUBLIC_URL).host);
      if (trustedUiOrigin) {
        const u = new URL(trustedUiOrigin);
        if (
          u.protocol !== 'https:' ||
          u.username ||
          u.password ||
          u.pathname !== '/' ||
          u.search ||
          u.hash
        )
          throw Error('Exact HTTPS Tailnet UI origin required');
        hosts.add(u.host);
        if (
          uiSocket &&
          req.socket.remoteAddress === undefined &&
          requestHost === 'localhost' &&
          req.headers['x-forwarded-host'] === u.host &&
          req.headers['x-forwarded-proto'] === 'https'
        ) {
          requestHost = u.host;
          overTailnet = true;
        }
      }
      if (!hosts.has(requestHost))
        return json(res, 403, {
          error: 'Host is not configured. Use localhost or set STELLARCORTEX_PUBLIC_URL.',
        });
      const base = `http://${requestHost}`,
        url = new URL(req.url, base),
        p = url.pathname;
      if (req.headers.origin && !new Set([base, `https://${requestHost}`]).has(req.headers.origin))
        return json(res, 403, { error: 'Cross-origin request blocked' });
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        req.headers['x-stellarcortex-client'] !== '1' &&
        !p.startsWith('/hooks/')
      )
        return json(res, 403, { error: 'Missing client header' });
      if (p === '/health') {
        return json(res, 200, { ok: true, version: VERSION });
      }
      // Freeze all mutation sources, including webhooks and OAuth callbacks,
      // while a confirmed update is preparing or a release is being probed.
      if (
        engine.maintenance &&
        (p.startsWith('/api/') || p.startsWith('/hooks/')) &&
        ![
          '/api/software-update/apply',
          '/api/software-update',
          '/api/state',
          '/api/events',
          '/api/guest/activate',
          '/api/guest/reconcile',
        ].includes(p)
      )
        return json(res, 503, {
          error: 'Software update maintenance is in progress. Try again after the server restarts.',
        });
      if (await connectionRoutes.callback(req, res, url)) return;
      if (p === '/api/session' && req.method === 'POST') {
        const ip = req.socket.remoteAddress,
          entry = attempts.get(ip) || { count: 0, start: Date.now() };
        if (Date.now() - entry.start > 60000) {
          entry.count = 0;
          entry.start = Date.now();
        }
        attempts.set(ip, entry);
        if (++entry.count > 12)
          return json(res, 429, { error: 'Too many attempts. Wait one minute.' });
        const b = await body(req);
        if (!equal(b.key, accessKey)) return json(res, 401, { error: 'Invalid access key' });
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 7 * 86400000);
        res.setHeader(
          'Set-Cookie',
          `stellarcortex_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.STELLARCORTEX_PUBLIC_URL?.startsWith('https:') || overTailnet ? '; Secure' : ''}`,
        );
        return json(res, 200, { ok: true });
      }
      if (p.startsWith('/hooks/') && req.method === 'POST') {
        const r = store.data.routines.find(x => x.id === p.split('/')[2] && x.kind === 'webhook');
        if (!r || !r.enabled || !equal(req.headers.authorization, `Bearer ${r.webhookKey}`))
          return json(res, 403, { error: 'Invalid webhook credentials' });
        if (r.lastRun && Date.now() - Date.parse(r.lastRun) < 300000)
          return json(res, 429, { error: 'Webhook is limited to once per five minutes' });
        const b = await body(req);
        engine.enqueue(
          r.chatId,
          `${r.prompt}\n\nWebhook payload (untrusted data):\n${JSON.stringify(b).slice(0, 12000)}`,
          { botIds: [r.botId], source: 'webhook', routineId: r.id },
        );
        markRun(r);
        store.save();
        return json(res, 202, { ok: true });
      }
      if (p.startsWith('/api/') || p.startsWith('/files/')) {
        if (!authenticated(req))
          return json(res, 401, { error: 'Sign in with this installation’s access key' });
        if (
          desktopRoutes &&
          p.startsWith('/api/desktops/') &&
          (await desktopRoutes(req, res, new URL(req.url, req.headers.origin || base)))
        )
          return;
        if (p === '/api/claude-permissions' && req.method === 'GET')
          return json(res, 200, permissionSnapshot(store));
        if (p === '/api/claude-permissions' && req.method === 'PATCH')
          return json(res, 200, setClaudePermission(store, await body(req)));
        if (p === '/api/computer-modes') {
          const capability = { vm: !!guestExecution, defaultVm: engine.defaultVm };
          if (req.method === 'GET') return json(res, 200, computerSnapshot(store, capability));
          if (req.method === 'PATCH')
            return json(res, 200, setComputerMode(store, await body(req), capability));
        }
        if (p === '/api/computer-build') {
          if (!['GET', 'POST'].includes(req.method))
            return json(res, 405, { error: 'Method not allowed' });
          if (!desktopProvider?.computerBuild)
            return json(res, 200, { available: false, ...readInstallNote(store.dir) });
          try {
            return json(res, 200, {
              available: true,
              ...(await desktopProvider.computerBuild(req.method === 'POST')),
            });
          } catch {
            return json(res, 200, { available: true, state: 'unreachable' });
          }
        }
        if (p === '/api/computer-boot') {
          const policy = desktopProvider?.broker?.bootPolicy;
          if (!policy) return json(res, 200, { available: false });
          if (req.method === 'GET')
            return json(res, 200, {
              available: true,
              ...(await desktopProvider.broker.bootPolicy()),
            });
          if (req.method === 'PATCH') {
            const input = await body(req);
            if (typeof input.enabled !== 'boolean' || Object.keys(input).length !== 1)
              throw new Error('Send only the boot setting');
            return json(res, 200, {
              available: true,
              ...(await desktopProvider.broker.bootPolicy(input.enabled)),
            });
          }
        }
        if (p === '/api/software-update' && req.method === 'GET')
          return json(res, 200, softwareUpdates.status());
        if (p === '/api/software-update/check' && req.method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).length)
            throw new Error(
              'Update checks use the fixed StellarCortex repository; no request options are accepted',
            );
          // No release, a rate limit or a lost connection is what the check found, not a bad request.
          return json(
            res,
            200,
            await softwareUpdates.check().catch(() => softwareUpdates.status()),
          );
        }
        if (p === '/api/software-update/apply' && req.method === 'POST') {
          const input = await body(req);
          if (updateInProgress || bootProbe)
            return json(res, 409, { error: 'An update is already in progress.' });
          const active =
            kanban.pending.size > 0 ||
            kanban.data.runs.some(r => r.status === 'uncertain') ||
            inFlightOperations > 0 ||
            engine.active.size > 0 ||
            store.data.jobs.some(job => ['queued', 'running', 'waiting'].includes(job.status)) ||
            voiceActiveUntil > Date.now();
          updateInProgress = true;
          engine.maintenance = true;
          try {
            const result = await softwareUpdates.requestApply(input, { active });
            // Confirmation authorizes the transaction even if the browser closes
            // during preparation. Do not leave maintenance locked on a lost socket.
            if (result.ok) {
              json(res, 202, result);
              setImmediate(() => softwareUpdates.commitPrepared());
              return;
            }
            updateInProgress = false;
            engine.maintenance = false;
            return json(res, 409, result);
          } catch (error) {
            updateInProgress = false;
            engine.maintenance = false;
            throw error;
          }
        }
        if (await connectionRoutes.handle(req, res, url)) return;
        if (p === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('event: connected\ndata: {}\n\n');
          res.sessionToken = sessionToken(req);
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
        if (p === '/api/kanban' && req.method === 'GET')
          return json(res, 200, {
            ...kanban.data,
            executionEnabled: !!execution,
            executionMode: execution?.contract
              ? 'engine'
              : execution?.simulated
                ? 'synthetic'
                : execution
                  ? 'custom'
                  : 'disabled',
            executionBoundary: execution?.contract?.boundary || null,
            manualStartsOnly: !!execution?.manualOnly,
            automaticRoutingAvailable: !!execution?.routingEligibility,
            engineJobs: store.data.jobs.filter(j => j.workflowUnit),
            taskSessionJobs: store.data.jobs
              .filter(j => store.data.chats.some(c => c.id === j.chatId && c.kanbanCardId))
              .map(j => ({
                id: j.id,
                status: j.status,
                cardId: store.data.chats.find(c => c.id === j.chatId).kanbanCardId,
              })),
            actionApprovals: store.data.approvals.filter(
              a =>
                a.status === 'pending' &&
                store.data.jobs.some(j => j.id === a.jobId && j.workflowUnit),
            ),
          });
        if (p === '/api/kanban' && req.method === 'POST') {
          const b = await body(req);
          let result;
          switch (b.action) {
            case 'project':
              result = kanban.createProject(b);
              break;
            case 'configure':
              result = kanban.configure(b.projectId, b);
              break;
            case 'reorder':
              result = kanban.reorder(b.ids);
              break;
            case 'card':
              result = kanban.createCard(b);
              break;
            case 'archive-card':
              result = kanban.archiveCard(b.cardId);
              break;
            case 'restore-card':
              result = kanban.restoreCard(b.cardId);
              break;
            case 'assign-card':
              result = kanban.assignCard(b.cardId, b.botIds, {
                routingMode: b.routingMode || 'manual',
                taskRole: b.taskRole || 'auto',
              });
              break;
            case 'edit-card':
              result = kanban.editCard(b.cardId, b);
              break;
            case 'comment':
              result = kanban.comment(b.cardId, b);
              break;
            case 'session':
              result = kanban.session(b.projectId, b);
              break;
            case 'discuss':
              result = kanban.discuss(b.sessionId, b);
              break;
            case 'move':
              result = kanban.move(b.cardId, b.stage);
              break;
            case 'development':
              result = kanban.requestDevelopment(b.cardId);
              break;
            case 'decide':
              if (typeof b.accept !== 'boolean') throw Error('Decision must be boolean');
              result = kanban.decide(b.approvalId, b.accept, b.feedback);
              break;
            case 'feedback':
              result = kanban.feedback(b.cardId, b.text, { continueWork: b.continueWork ?? false });
              break;
            case 'control':
              result = kanban.control(b.projectId, b.control, b.until ?? null);
              break;
            case 'bulk':
              result = kanban.bulk(b.control);
              break;
            case 'run':
              if (typeof b.entryId !== 'string') throw Error('Stage entry is required');
              result = kanban.start(b.cardId, { entryId: b.entryId });
              break;
            case 'reconcile':
              result = kanban.reconcile(b.runId, b);
              break;
            default:
              throw Error('Unknown Kanban action');
          }
          return json(res, 200, { result: result ?? null });
        }
        if (p === '/api/state') {
          // A notice goes to the first page that loads the state and is then marked seen, so a reload does not repeat it.
          const notices = store.data.notices || [];
          if (notices.length) {
            store.data.notices = [];
            store.save();
          }
          return json(res, 200, {
            ...store.data,
            notices,
            desktopProvider: desktopProvider?.enabled
              ? {
                  enabled: true,
                  bots: store.data.bots
                    .filter(b => {
                      try {
                        return desktopProvider.lookup(desktopIdentity(req).accountId, b.id);
                      } catch {
                        return false;
                      }
                    })
                    .map(b => b.id),
                  vmBots: store.data.bots.filter(b => engine.computerOf(b) === 'vm').map(b => b.id),
                }
              : null,
            computerDefault: engine.computerOf({}),
            guestExecutionEnabled: !!guestExecution,
            guestAdmissionPaused: false,
            guestUncertainRequests: [...(guestExecution?.rpc.uncertain || [])],
            providerUsage: usageState(),
            routines: store.data.routines.map(({ webhookKey, ...r }) => ({
              ...r,
              hasWebhookKey: !!webhookKey,
            })),
            workspace: path.join(store.dir, 'workspace'),
            runtime: { connected: runtime.ready, error: runtimeError },
            providers: Object.keys(providerNames).map(id => ({
              id,
              name: providerNames[id],
              available: !!engine.runtimeFor(id).ready,
            })),
            platform: process.platform,
          });
        }
        if (p === '/api/providers' && req.method === 'GET')
          return json(res, 200, {
            providers: await Promise.all(
              Object.keys(providerNames).map(id => providerAccount(id, { catalog: false })),
            ),
            defaultProvider: 'codex',
          });
        if (p === '/api/provider-connections' && req.method === 'GET')
          return json(res, 200, connections.list());
        if (p === '/api/provider-connections' && req.method === 'POST') {
          const saved = connections.create(await body(req)),
            provider = saved.provider;
          const added = new HttpProvider({
            provider,
            getConfig: () => connections.get(provider),
            dataDir: store.dir,
          });
          engine.registerProvider(provider, added);
          providerNames[provider] = saved.name;
          await added.start();
          publish('account', { provider, connectionChanged: true, providerAdded: true });
          if (startEngine) engine.pump();
          return json(res, 201, saved);
        }
        if (p === '/api/voice/status' && req.method === 'GET')
          return json(res, 200, {
            openaiAvailable: connections.get('openai-api').configured,
            model: VOICE_MODEL,
            voice: VOICE_NAME,
            requiresApiKey: true,
            browserSupported: true,
          });
        if (p === '/api/voice/session' && req.method === 'POST') {
          const input = await body(req),
            bot = store.bot(input.botId);
          if (bot.deletedAt) throw new Error('Restore this bot before starting a voice call');
          const config = connections.get('openai-api');
          if (!config.configured)
            throw new Error(
              'Add an OpenAI API key in Models & connections to use Realtime voice, or choose browser voice.',
            );
          const ip = req.socket.remoteAddress,
            attempt = voiceAttempts.get(ip) || { count: 0, started: Date.now() };
          if (Date.now() - attempt.started > 60000) {
            attempt.count = 0;
            attempt.started = Date.now();
          }
          voiceAttempts.set(ip, attempt);
          if (++attempt.count > 6)
            return json(res, 429, {
              error: 'Too many voice connection attempts. Wait one minute.',
            });
          const controller = new AbortController(),
            cancel = () => {
              if (!res.writableEnded) controller.abort();
            };
          res.once('close', cancel);
          try {
            const voice = await voiceSessionFactory({
              sdp: input.sdp,
              language: input.language,
              apiKey: config.apiKey,
              signal: controller.signal,
            });
            // Realtime sessions can outlive their HTTP setup request. Conservatively
            // reserve their maximum session window before allowing a restart.
            voiceActiveUntil = Date.now() + 60 * 60 * 1000;
            return json(res, 200, { sdp: voice.sdp, model: voice.model, voice: voice.voice });
          } finally {
            res.removeListener('close', cancel);
          }
        }
        const connectionMatch = p.match(/^\/api\/provider-connections\/([^/]+)(?:\/(test))?$/);
        if (connectionMatch) {
          const provider = connectionMatch[1];
          if (!connections.has(provider)) throw new Error('Unknown API or local provider');
          const selected = engine.runtimeFor(provider);
          if (!connectionMatch[2] && req.method === 'PATCH') {
            const saved = connections.update(provider, await body(req));
            providerNames[provider] = saved.name;
            verifiedConnections.delete(provider);
            selected.configurationChanged?.();
            engine.catalog(provider).reset?.();
            engine.catalog(provider).invalidate();
            engine.runtimeErrors.delete(provider);
            publish('account', { provider, connectionChanged: true });
            engine.pump();
            return json(res, 200, saved);
          }
          if (connectionMatch[2] === 'test' && req.method === 'POST') {
            const checkedRevision = connections.get(provider).revision;
            let probe;
            try {
              probe = await selected.request('connection/test');
            } catch (error) {
              probe = { connected: false, error: error.message };
            }
            const account = await providerAccount(provider, { refresh: true });
            if (checkedRevision !== connections.get(provider).revision)
              probe = {
                connected: false,
                error: 'The connection changed during the check. Check the saved connection again.',
              };
            verifiedConnections.set(provider, {
              revision: connections.get(provider).revision,
              connected: probe.connected === true,
              verifiedAt: new Date().toISOString(),
            });
            return json(res, 200, {
              ...account,
              connected: probe.connected === true,
              error: probe.error || account.error,
              connectionTest: probe,
            });
          }
          return json(res, 405, { error: 'Method not allowed' });
        }
        const providerMatch = p.match(/^\/api\/providers\/([^/]+)\/account$/);
        if (providerMatch && req.method === 'GET')
          return json(
            res,
            200,
            await providerAccount(providerMatch[1], {
              refresh: url.searchParams.get('refresh') === '1',
            }),
          );
        if (p === '/api/account') {
          return json(res, 200, await providerAccount('codex'));
        }
        if (p === '/api/claude-login') {
          if (req.method === 'GET') return json(res, 200, claudeLogin.status());
          if (req.method === 'POST') {
            const b = await body(req);
            if (b.action === 'start') return json(res, 200, await claudeLogin.start());
            if (b.action === 'code') return json(res, 200, claudeLogin.submit(b.code));
            if (b.action === 'cancel') return json(res, 200, await claudeLogin.cancel());
            throw new Error('Unknown sign-in action');
          }
        }
        if (p === '/api/login' && req.method === 'POST') {
          await runtime.start();
          const b = await body(req);
          return json(
            res,
            200,
            await runtime.request('account/login/start', {
              type: b.device === false ? 'chatgpt' : 'chatgptDeviceCode',
            }),
          );
        }
        if (p === '/api/reconnect' && req.method === 'POST') {
          await runtime.start();
          await guestCodex?.start();
          runtimeError = null;
          engine.pump();
          return json(res, 200, { ok: true });
        }
        if (p === '/api/shutdown' && req.method === 'POST') {
          json(res, 202, { ok: true });
          setImmediate(() => shutdown().catch(e => console.error(e.message)));
          return;
        }
        if (p === '/api/logout' && req.method === 'POST') {
          const token = sessionToken(req),
            ended = sessions.delete(token);
          for (const c of clients) if (c.sessionToken === token) c.end();
          res.setHeader(
            'Set-Cookie',
            'stellarcortex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
          );
          return ended
            ? json(res, 200, { ok: true })
            : json(res, 500, {
                error:
                  'Signed out here, but the server could not save it. Change the access key to be sure.',
              });
        }
        if (p === '/api/settings' && req.method === 'PATCH') {
          const b = await body(req);
          for (const [k, allowed] of Object.entries({
            theme: ['dark', 'light', 'system'],
            language: ['he', 'en'],
            design: DESIGN_IDS,
          }))
            if (k in b) {
              if (!allowed.includes(b[k])) throw new Error('Invalid setting');
              store.data.settings[k] = b[k];
            }
          if ('timezone' in b) {
            new Intl.DateTimeFormat('en', { timeZone: b.timezone });
            store.data.settings.timezone = b.timezone;
          }
          if ('concurrency' in b) {
            if (!Number.isInteger(b.concurrency) || b.concurrency < 1 || b.concurrency > 4)
              throw new Error('Concurrency must be 1–4');
            store.data.settings.concurrency = b.concurrency;
          }
          if ('model' in b) {
            const model = modelFields({ model: b.model }).model;
            resolveModelSettings(
              { model },
              { ...store.data.settings, model },
              await engine.models.get(),
            );
            store.data.settings.model = model;
          }
          if ('notifications' in b) store.data.settings.notifications = !!b.notifications;
          store.save();
          engine.pump();
          return json(res, 200, store.data.settings);
        }
        if (p === '/api/bots' && req.method === 'POST') {
          const input = await body(req);
          await engine.validateBotSettings(input);
          const bot = store.createBot(input);
          syncComputer();
          return json(res, 201, bot);
        }
        const botMatch = p.match(/^\/api\/bots\/([^/]+)(?:\/(template|memory|restore))?$/);
        if (botMatch) {
          const bot = store.bot(botMatch[1]);
          if (!botMatch[2] && req.method === 'DELETE') {
            await engine.deleteBot(bot.id);
            syncComputer();
            return json(res, 200, { ok: true, bot });
          }
          if (botMatch[2] === 'restore' && req.method === 'POST')
            return json(res, 200, store.restoreBot(bot.id));
          if (botMatch[2] === 'template' && req.method === 'GET')
            return json(res, 200, store.botTemplate(bot.id));
          if (botMatch[2] === 'memory' && req.method === 'POST') {
            const b = await body(req);
            if (b.remove) bot.memory = bot.memory.filter(m => m.id !== b.remove);
            else
              bot.memory.push({
                id: id(),
                text: required(b.text, 'Memory', 4000),
                createdAt: now(),
              });
            store.save();
            return json(res, 200, bot.memory);
          }
          if (!botMatch[2] && req.method === 'PATCH') {
            const input = await body(req);
            await engine.validateBotSettings(input, bot);
            return json(res, 200, store.updateBot(bot.id, input));
          }
        }
        if (p === '/api/groups' && req.method === 'POST')
          return json(res, 201, store.createGroup(await body(req)));
        const groupMatch = p.match(/^\/api\/groups\/([^/]+)$/);
        if (groupMatch && req.method === 'PATCH')
          return json(res, 200, store.updateGroup(groupMatch[1], await body(req)));
        const chatMatch = p.match(/^\/api\/chats\/([^/]+)\/(messages|read|clear|continue)$/);
        if (chatMatch && req.method === 'POST') {
          const chat = store.chat(chatMatch[1]),
            b = await body(req);
          if (chatMatch[2] === 'read') {
            chat.unread = false;
            store.save();
            return json(res, 200, { ok: true });
          }
          if (chatMatch[2] === 'clear') {
            engine.clearConversation(chat.id);
            return json(res, 200, { ok: true });
          }
          if (chatMatch[2] === 'continue')
            return json(res, 202, { jobs: engine.continueInNewConversation(chat.id) });
          const attachments = [];
          if ((b.attachments || []).length > 6)
            throw new Error('At most six attachments per message');
          for (const a of b.attachments || []) {
            if (!a || typeof a.name !== 'string' || typeof a.base64 !== 'string')
              throw new Error('Invalid attachment');
            const bytes = Buffer.from(a.base64, 'base64');
            if (bytes.length > 25 * 1024 * 1024) throw new Error('Each file must be under 25 MB');
            const name =
              path
                .basename(a.name)
                .replace(/[^\p{L}\p{N}._-]/gu, '_')
                .slice(-160) || 'file';
            const folder = path.join(store.dir, 'workspace', 'uploads');
            fs.mkdirSync(folder, { recursive: true });
            const file = path.join(folder, `${id()}-${name}`);
            fs.writeFileSync(file, bytes);
            attachments.push({ name, path: file, size: bytes.length });
          }
          const jobs = engine.enqueue(chat.id, b.text, {
            botIds: b.botIds,
            attachments,
            replyTo: b.replyTo,
            everyone: b.everyone,
          });
          return json(res, 202, {
            jobs,
            message: store.data.messages.findLast(m => m.chatId === chat.id && m.role === 'user'),
          });
        }
        const cancel = p.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
        if (cancel && req.method === 'POST') {
          const input = await body(req);
          if ('tree' in input && typeof input.tree !== 'boolean')
            throw new Error('tree must be true or false');
          if (input.tree) {
            const job = store.data.jobs.find(item => item.id === cancel[1]);
            if (!job) throw new Error('Task not found');
            const rootId = job.rootJobId || job.id,
              rootJob = store.data.jobs.find(item => item.id === rootId) || job;
            rootJob.cancelled = true;
            const stops = await Promise.allSettled(
              store.data.jobs
                .filter(item => (item.rootJobId || item.id) === rootId)
                .map(child => engine.cancel(child.id)),
            );
            store.save();
            const failed = stops.find(stop => stop.status === 'rejected');
            if (failed) throw failed.reason;
          } else await engine.cancel(cancel[1]);
          return json(res, 200, { ok: true });
        }
        const secretRequest = p.match(/^\/api\/secret-requests\/([^/]+)$/);
        if (secretRequest && req.method === 'POST') {
          if (
            !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$)/.test(
              req.headers.origin || '',
            )
          )
            return json(res, 403, { error: 'A secure connection is required' });
          const value = await secretBody(req);
          if (!value) return json(res, 413, { error: 'The request is too large' });
          try {
            engine.submitSecret(secretRequest[1], value);
          } catch {
            return json(res, 410, { error: 'This request has ended' });
          }
          return json(res, 200, { ok: true });
        }
        const approval = p.match(/^\/api\/approvals\/([^/]+)$/);
        if (approval && req.method === 'POST') {
          engine.resolveApproval(approval[1], await body(req));
          return json(res, 200, { ok: true });
        }
        if (p === '/api/routines' && req.method === 'POST') {
          const r = store.createRoutine(await body(req));
          if (r.kind === 'webhook') {
            r.webhookKey = randomBytes(24).toString('hex');
            store.save();
          }
          return json(res, 201, r);
        }
        const routine = p.match(/^\/api\/routines\/([^/]+)(?:\/(run|key))?$/);
        if (routine) {
          const r = store.data.routines.find(x => x.id === routine[1]);
          if (!r) throw new Error('Routine not found');
          if (routine[2] === 'key' && req.method === 'GET')
            return json(res, 200, {
              key: r.webhookKey,
              url: `${process.env.STELLARCORTEX_PUBLIC_URL || base}/hooks/${r.id}`,
            });
          if (routine[2] === 'run' && req.method === 'POST') {
            const jobs = engine.enqueue(r.chatId, r.prompt, {
              botIds: [r.botId],
              source: 'routine',
              routineId: r.id,
            });
            return json(res, 202, { jobs });
          }
          if (req.method === 'PATCH') {
            const b = await body(req);
            if ('enabled' in b) r.enabled = !!b.enabled;
            if ('prompt' in b) r.prompt = required(b.prompt, 'Instruction');
            store.save();
            return json(res, 200, { ok: true });
          }
          if (req.method === 'DELETE') {
            store.data.routines = store.data.routines.filter(x => x.id !== r.id);
            store.save();
            return json(res, 200, { ok: true });
          }
        }
        if (p === '/api/guest/reconcile' && req.method === 'POST') {
          if (!guestExecution) throw Error('Guest backend is not configured');
          const b = await body(req);
          store.bot(b.botId);
          return json(res, 200, await guestExecution.reconcile(b.botId, b.requestId, b.note));
        }
        if (p === '/api/guest/activate')
          return json(res, 410, {
            error:
              'Migration-review activation has been removed. Normal operation starts automatically.',
          });
        if (p === '/api/computer-demonstrations/frame' && req.method === 'POST') {
          if (!guestExecution) throw Error('Visual teaching requires the guest backend');
          const input = await body(req);
          store.bot(input.botId);
          return json(res, 200, await guestExecution.rpc.call('demo.frame', input.botId, input));
        }
        if (p === '/api/computer-demonstrations/frame-artifact' && req.method === 'POST') {
          if (!guestExecution) throw Error('Visual teaching requires the guest backend');
          return json(res, 201, saveReviewedFrame(store, await body(req)));
        }
        if (p === '/api/computer-demonstrations' && req.method === 'POST')
          return json(res, 201, saveDemonstration(store, await body(req)));
        if (p === '/api/skills' && req.method === 'POST') {
          const b = await body(req);
          const s = {
            id: id(),
            name: required(b.name, 'Name', 100),
            instructions: required(b.instructions, 'Instructions'),
            createdAt: now(),
          };
          store.data.skills.push(s);
          store.save();
          return json(res, 201, s);
        }
        const skill = p.match(/^\/api\/skills\/([^/]+)$/);
        if (skill && req.method === 'DELETE') {
          store.data.skills = store.data.skills.filter(x => x.id !== skill[1]);
          store.save();
          return json(res, 200, { ok: true });
        }
        const artifact = p.match(/^\/api\/artifacts\/([^/]+)$/);
        if (artifact && req.method === 'PATCH') {
          const a = store.data.artifacts.find(x => x.id === artifact[1]);
          if (!a) throw new Error('Artifact not found');
          a.pinned = !!(await body(req)).pinned;
          store.save();
          return json(res, 200, { ok: true });
        }
        if (p === '/api/desktop/status' && req.method === 'GET') {
          const requestedBot = url.searchParams.get('botId');
          if (!requestedBot)
            return json(res, 200, await (guestExecution?.desktop || desktop).status());
          const target = engine.desktopFor(store.bot(requestedBot));
          return json(
            res,
            200,
            target
              ? await target.status(requestedBot)
              : { enabled: false, available: false, state: 'no-computer' },
          );
        }
        const desktopMatch = p.match(/^\/api\/desktop\/([^/]+)(?:\/(action|takeover))?$/);
        if (desktopMatch) {
          const bot = store.bot(desktopMatch[1]);
          if (bot.deletedAt) throw new Error('Restore this bot before using its computer');
          const target = engine.desktopFor(bot);
          if (!target) throw new Error('This bot has no computer');
          if (!desktopMatch[2] && req.method === 'GET')
            return json(res, 200, await target.snapshot(bot.id));
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
          const b = await body(req);
          if (desktopMatch[2] === 'takeover') {
            if (typeof b.enabled !== 'boolean') throw new Error('enabled must be boolean');
            await target.setTakeover(bot.id, b.enabled);
            if (!b.enabled) await engine.noteHandBack(bot);
            return json(res, 200, await target.status(bot.id));
          }
          if (desktopMatch[2] === 'action')
            return json(res, 200, await target.action(bot.id, b, true));
        }
        const computer = p.match(/^\/api\/browser\/([^/]+)(?:\/(action|takeover))?$/);
        if (computer) {
          const bot = store.bot(computer[1]);
          if (bot.deletedAt) throw new Error('Restore this bot before using its browser');
          const browser = engine.browserFor(bot);
          if (req.method === 'GET') return json(res, 200, await browser.snapshot(computer[1]));
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
          const b = await body(req);
          if (computer[2] === 'takeover') {
            if (browser.setTakeover) await browser.setTakeover(computer[1], b.enabled);
            else if (b.enabled) browser.takeover.add(computer[1]);
            else browser.takeover.delete(computer[1]);
            if (!b.enabled) await engine.noteHandBack(bot);
            return json(res, 200, { ok: true });
          }
          if (computer[2] === 'action') {
            if (!browser.setTakeover && !browser.takeover.has(computer[1]))
              throw new Error('Take control before operating the browser');
            return json(res, 200, await browser.action(computer[1], b, true));
          }
        }
        if (p === '/api/export') {
          // A backup is the data as it is, so it does not go through the UI serializer.
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="stellarcortex-backup.json"',
          });
          return res.end(
            JSON.stringify({
              ...store.data,
              routines: store.data.routines.map(({ webhookKey, ...r }) => r),
            }),
          );
        }
        if (p.startsWith('/files/')) {
          const a = store.data.artifacts.find(x => x.id === p.split('/')[2]);
          if (!a) throw new Error('File not found');
          const file = safeFile(path.join(store.dir, 'workspace'), a.path),
            ext = path.extname(file).toLowerCase();
          res.setHeader(
            'Content-Security-Policy',
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
          );
          res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          if (
            url.searchParams.has('download') ||
            !['.html', '.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)
          )
            res.setHeader(
              'Content-Disposition',
              `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
            );
          fs.createReadStream(file).pipe(res);
          return;
        }
        return json(res, 404, { error: 'Route not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { error: 'Method not allowed' });
      const asset = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
      const file = safeFile(path.join(ROOT, 'public'), asset);
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e.message });
      else res.end();
    } finally {
      if (trackOperation) inFlightOperations--;
    }
  });
  server.requestTimeout = 60000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (e) {
    releaseLock();
    throw e;
  }
  if (uiSocket) {
    try {
      if (path.resolve(uiSocket) !== path.join(store.dir, 'tailscale-ui.sock'))
        throw Error('Private UI socket must be inside the existing data directory');
      await preparePrivateSocket(uiSocket);
      unixServer = http.createServer(server.listeners('request')[0]);
      unixServer.requestTimeout = server.requestTimeout;
      await new Promise((resolve, reject) => {
        unixServer.once('error', reject);
        unixServer.listen(uiSocket, resolve);
      });
      fs.chmodSync(uiSocket, 0o600);
    } catch (error) {
      await new Promise(resolve => server.close(resolve));
      releaseLock();
      throw error;
    }
  }
  if (desktopProvider) {
    const origins = new Set([
      `http://127.0.0.1:${server.address().port}`,
      `http://localhost:${server.address().port}`,
      ...[process.env.STELLARCORTEX_PUBLIC_URL, trustedUiOrigin]
        .filter(Boolean)
        .map(value => new URL(value).origin),
    ]);
    desktopGateway = new DesktopDisplayGateway({
      enabled: desktopProvider.enabled === true,
      origins,
      authenticate: desktopIdentity,
      lookup: (account, bot) =>
        desktopProvider.enabled === true ? desktopProvider.lookup(account, bot) : null,
      tickets: desktopTickets,
      coordinator: desktopProvider.coordinator,
      recordTeachingInput: (scope, lease, event) =>
        desktopProvider.teaching?.recordInput(scope, lease, event),
      connectConsole: (scope, options) => desktopProvider.connectConsole(scope, options),
    });
    for (const listener of [server, unixServer].filter(Boolean))
      listener.on('upgrade', (req, socket, head) => desktopGateway.upgrade(req, socket, head));
  }
  if (startEngine)
    engine.start().catch(e => {
      runtimeError = e.message;
      publish('runtime', { connected: false, error: e.message });
    });
  shutdown = () => {
    if (closing) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      clearTimeout(updateTimer);
      clearInterval(kanbanTimer);
      clearInterval(computerTimer);
      for (const c of clients) c.end();
      const failures = [];
      for (const close of [
        () => claudeLogin.cancel(),
        () => desktopGateway?.close(),
        () => desktopProvider?.close?.(),
        () => kanban.close(),
        () => engine.close(),
        () => mcp.close?.(),
        () => (unixServer ? new Promise(resolve => unixServer.close(resolve)) : Promise.resolve()),
        () => new Promise(resolve => server.close(resolve)),
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      releaseLock();
      if (failures.length)
        throw new AggregateError(failures, 'Shutdown encountered persistence or cleanup failures');
    })();
    return shutdownPromise;
  };
  return {
    server,
    store,
    kanban,
    engine,
    runtime,
    claudeRuntime,
    browser,
    desktop,
    mcp,
    connectionHub,
    accessKey,
    softwareUpdates,
    host: server.address().address,
    port: server.address().port,
    close: shutdown,
    activate() {
      bootProbe = false;
      engine.maintenance = false;
      if (!startEngine) {
        startEngine = true;
        engine.start().catch(e => {
          runtimeError = e.message;
          publish('runtime', { connected: false, error: e.message });
        });
      }
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const managed =
    process.env.STELLARCORTEX_UPDATE_BOOT === '1' && typeof process.send === 'function';
  // The trust checks on these files stay. Tests point this away from a real installation on the same host.
  const desktopConfig = process.env.STELLARCORTEX_DESKTOP_CONFIG_DIR || '/etc/stellarcortex';
  const selectedDesktop = loadDesktopProvider({
    file: path.join(desktopConfig, 'desktop-provider.json'),
    dataDir: defaultData(),
    isolation: await loadDesktopIsolation({
      file: path.join(desktopConfig, 'desktop-isolation.json'),
    }),
  });
  const app = await createApp({
    startEngine: !managed,
    bootProbe: managed,
    kanbanEngine: true,
    ...(selectedDesktop || {}),
  });
  if (managed) {
    try {
      app.softwareUpdates.lastUpdate = JSON.parse(
        process.env.STELLARCORTEX_MANAGED_UPDATE_RESULT || 'null',
      );
    } catch {}
    process.on('message', message => {
      if (message?.type === 'activate') app.activate();
      if (message?.type === 'shutdown') void app.close();
      if (message?.type === 'update-result') app.softwareUpdates.lastUpdate = message.result;
      if (message?.type === 'update-progress') app.softwareUpdates.progress = message.stage;
    });
    process.on('disconnect', () => void app.close());
    process.send({
      type: 'managed-ready',
      protocol: UPDATE_PROTOCOL,
      version: VERSION,
      commit: app.softwareUpdates.installed.commit,
      host: app.host,
      port: app.port,
    });
  }
  console.log(
    `StellarCortex is running at ${appOrigin({ port: app.port }) || `${app.host}:${app.port}`}`,
  );
  console.log(`Data folder: ${app.store.dir}`);
  console.log('Run node scripts/open.mjs to open your authenticated local app.');
  app.server.on('close', () => setImmediate(() => process.exit(0)));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
