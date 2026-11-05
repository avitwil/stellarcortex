import { desktopScope, STOPPED_COMPUTER } from './desktop-provider-session.mjs';
export function createDesktopProviderRoutes({
  provider,
  authenticate,
  tickets,
  coordinator,
  json,
  body,
}) {
  return async (req, res, url) => {
    const match =
      /^\/api\/desktops\/([A-Za-z0-9_-]{1,128})(?:\/(control|heartbeat|ticket|start|shutdown|teaching|operations|cancel|review|setup|access))?$/.exec(
        url.pathname,
      );
    if (!match) return false;
    const identity = authenticate(req);
    if (!identity) {
      json(res, 401, { error: 'Authenticated desktop session required' });
      return true;
    }
    if (!provider.enabled) {
      json(res, 503, { error: 'New desktop provider is not enabled' });
      return true;
    }
    const botId = match[1],
      operation = match[2] || 'status';
    if (operation === 'setup' && ['GET', 'POST'].includes(req.method)) {
      json(res, 200, await provider.onboarding(identity.accountId, botId, req.method === 'POST'));
      return true;
    }
    if (provider.refresh) await provider.refresh(identity.accountId, botId);
    const record = provider.lookup(identity.accountId, botId);
    if (!record) {
      json(res, 404, { error: 'Desktop not registered' });
      return true;
    }
    const scope = desktopScope({ ...record, accountId: identity.accountId, botId });
    if (operation === 'operations' && req.method === 'GET') {
      json(res, 200, await provider.broker.operations(scope));
      return true;
    }
    if (operation === 'status' && req.method === 'GET') {
      json(res, 200, { ...scope, state: record.state, control: coordinator.observation(scope) });
      return true;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const input = await body(req);
    let result;
    if (operation === 'review')
      result = await provider.broker.review({
        scope,
        targetRequestId: input.targetRequestId,
        expectedDigest: input.expectedDigest,
        note: input.note,
        confirm: input.confirm,
      });
    else if (operation === 'cancel') result = await provider.cancel(scope, input.targetRequestId);
    else if (['start', 'shutdown'].includes(operation))
      result = await provider.lifecycle.change(identity.accountId, botId, operation, input);
    else {
      if (record.state !== 'running') throw Error(STOPPED_COMPUTER);
      if (operation === 'teaching') {
        if (!provider.teaching) throw Error('Teaching is unavailable');
        const lease = { ...input.lease, sessionId: identity.sessionId },
          t = provider.teaching;
        if (input.action === 'start') result = t.start(scope, lease, input.objective);
        else if (input.action === 'status') result = t.status(input.id, scope, lease);
        else if (input.action === 'review-text')
          result = t.reviewText(input.id, scope, lease, input);
        else if (input.action === 'stop') result = t.stop(input.id, scope, lease);
        else if (input.action === 'resume') result = t.resume(input.id, scope, lease, input);
        else if (input.action === 'capture') result = await t.captureFrame(input.id, scope, lease);
        else if (input.action === 'preview')
          result = await t.preview(input.id, scope, lease, input);
        else if (input.action === 'review') {
          t.review(input.id, scope, lease, input);
          result = { reviewed: true };
        } else if (input.action === 'save') result = await t.save(input.id, scope, lease, input);
        else if (input.action === 'discard') {
          t.discard(input.id, scope, lease);
          result = { discarded: true };
        } else throw Error('Unsupported teaching action');
      } else if (operation === 'control') {
        if (input.enabled === true) result = await coordinator.claim(scope, identity.sessionId);
        else if (input.enabled === false)
          result = {
            released: await coordinator.release(scope, {
              ...input.lease,
              sessionId: identity.sessionId,
            }),
          };
        else throw Error('Explicit control state required');
      } else if (operation === 'heartbeat') {
        coordinator.heartbeat(scope, { ...input.lease, sessionId: identity.sessionId });
        result = { ok: true };
      } else if (operation === 'ticket') {
        const lease =
          input.mode === 'control' ? { ...input.lease, sessionId: identity.sessionId } : null;
        if (lease && !coordinator.canWrite(scope, lease))
          throw Error('Current control lease required');
        result = tickets.issue({
          scope,
          sessionId: identity.sessionId,
          origin: url.origin,
          mode: input.mode || 'view',
          lease,
        });
      } else {
        json(res, 404, { error: 'Unknown desktop operation' });
        return true;
      }
    }
    json(res, 200, result);
    return true;
  };
}
