import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleConnector, GOOGLE_SERVICES, GOOGLE_SCOPES } from '../src/google-connector.mjs';

const clientId = '123-test.apps.googleusercontent.com',
  secret = 'google-client-secret',
  owner = 'browser-owner';
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcortex-google-test-')),
    calls = [];
  let clock = 1000,
    handler = null,
    granted = null,
    connector;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    calls.push({ url, options });
    if (handler) {
      const result = await handler(url, options);
      if (result) return result;
    }
    if (url === 'https://oauth2.googleapis.com/token')
      return json({
        token_type: 'Bearer',
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
        scope: (granted || connector.scopes()).join(' '),
      });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
      return json({ email: 'owner@example.com', email_verified: true });
    if (url === 'https://oauth2.googleapis.com/revoke') return json({});
    return json({ ok: true });
  };
  connector = new GoogleConnector({ dataDir: dir, fetchImpl, now: () => clock });
  t.after(async () => {
    await connector.close();
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith('stellarcortex-google-test-')
    )
      throw new Error('Unsafe test cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const auth = async (config = {}) => {
    connector.configure({ clientId, clientSecret: secret, services: GOOGLE_SERVICES, ...config });
    const result = connector.startAuth({
      redirectUri: 'http://localhost:4317/api/google/oauth/callback',
      owner,
    });
    await connector.completeAuth(
      { state: new URL(result.authorizationUrl).searchParams.get('state'), code: 'auth-code' },
      { owner },
    );
    return connector.status();
  };
  return {
    dir,
    calls,
    connector,
    auth,
    fetchImpl,
    setHandler: value => (handler = value),
    setGranted: value => (granted = value),
    advance: value => (clock += value),
  };
}

test('Google OAuth requests only selected scopes, binds state to browser and PKCE, and encrypts credentials outside the workspace', async t => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0);
  f.connector.configure({ clientId, clientSecret: secret, services: ['gmail', 'docs'] });
  const initial = f.connector.status();
  assert.equal(initial.readOnly, true);
  assert.equal(initial.hasClientSecret, true);
  assert.ok(initial.scopes.includes(GOOGLE_SCOPES.gmail.read[0]));
  assert.equal(initial.scopes.includes(GOOGLE_SCOPES.drive.read[0]), false);
  const auth = f.connector.startAuth({
      redirectUri: 'http://localhost:4317/api/google/oauth/callback',
      owner,
    }),
    url = new URL(auth.authorizationUrl),
    state = url.searchParams.get('state');
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  await assert.rejects(
    f.connector.completeAuth({ state, code: 'auth-code' }, { owner: 'other-browser' }),
    /not started/,
  );
  assert.equal(f.calls.length, 0);
  await f.connector.completeAuth({ state, code: 'auth-code' }, { owner });
  assert.equal(f.connector.status().email, 'owner@example.com');
  assert.equal(f.connector.status().connected, true);
  const body = new URLSearchParams(f.calls[0].options.body);
  assert.equal(body.get('client_secret'), secret);
  assert.ok(body.get('code_verifier'));
  await assert.rejects(f.connector.completeAuth({ state, code: 'replay' }, { owner }), /expired/);
  const safe = JSON.stringify(f.connector.status());
  for (const value of [secret, 'access-secret', 'refresh-secret'])
    assert.equal(safe.includes(value), false);
  const encrypted = fs.readFileSync(path.join(f.dir, 'private', 'google-connection.enc'), 'utf8');
  for (const value of [secret, 'access-secret', 'refresh-secret'])
    assert.equal(encrypted.includes(value), false);
  const before = f.calls.length,
    reloaded = new GoogleConnector({ dataDir: f.dir, fetchImpl: f.fetchImpl });
  assert.equal(reloaded.status().connected, true);
  assert.equal(f.calls.length, before);
  await reloaded.close();
});

test('OAuth rejects unsafe redirects, expired or changed-state flows, and preserves credentials on partial configuration', async t => {
  const f = fixture(t);
  f.connector.configure({ clientId, clientSecret: secret, services: ['docs'] });
  const revision = f.connector.status().revision;
  f.connector.configure({ clientSecret: '', services: ['docs'], readOnly: true });
  assert.equal(f.connector.status().revision, revision);
  for (const redirectUri of [
    'http://remote.example/callback',
    'https://user:secret@example.com/callback',
    'https://example.com/callback?token=x',
  ])
    assert.throws(() => f.connector.startAuth({ redirectUri, owner }), /callback/);
  let auth = f.connector.startAuth({ redirectUri: 'https://example.com/callback', owner });
  f.advance(600001);
  await assert.rejects(
    f.connector.completeAuth(
      { state: new URL(auth.authorizationUrl).searchParams.get('state'), code: 'expired' },
      { owner },
    ),
    /expired/,
  );
  auth = f.connector.startAuth({ redirectUri: 'https://example.com/callback', owner });
  f.connector.configure({ readOnly: false });
  await assert.rejects(
    f.connector.completeAuth(
      { state: new URL(auth.authorizationUrl).searchParams.get('state'), code: 'old' },
      { owner },
    ),
    /expired/,
  );
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => f.connector.configure({ clientId: 'other.apps.googleusercontent.com' }),
    /matching client secret/,
  );
  assert.equal(f.connector.status().clientId, clientId);
});

test('Google tool catalog enforces selected services, read-only mode and partial grants rather than trusting model arguments', async t => {
  const f = fixture(t);
  await f.auth();
  let tools = await f.connector.listTools();
  assert.equal(tools.tools.length, 13);
  assert.ok(tools.tools.every(tool => tool.annotations.readOnlyHint));
  await assert.rejects(
    f.connector.callTool('gmail_send_message', { to: 'a@example.com', subject: 'No', body: 'No' }),
    /unavailable/,
  );
  f.connector.configure({ readOnly: false });
  assert.equal(f.connector.status().connected, false);
  assert.equal((await f.connector.listTools()).tools.length, 0);
  await f.auth({ readOnly: false });
  tools = await f.connector.listTools();
  assert.equal(tools.tools.length, 24);
  assert.equal(
    tools.tools.find(tool => tool.name === 'gmail_send_message').annotations.readOnlyHint,
    false,
  );
  f.setGranted(GOOGLE_SCOPES.docs.read);
  await f.auth({ readOnly: false });
  assert.deepEqual(
    (await f.connector.listTools()).tools.map(tool => tool.name),
    ['docs_get_document'],
  );
  await assert.rejects(
    f.connector.callTool('docs_create_document', { title: 'Not granted' }),
    /unavailable/,
  );
});

test('Google typed tools use fixed REST endpoints and safe payloads for Gmail, Drive, Docs, Sheets, Calendar and Contacts', async t => {
  const f = fixture(t);
  await f.auth({ readOnly: false });
  const revision = f.connector.status().revision,
    call = (name, args) => f.connector.callTool(name, args, { expectedRevision: revision });
  await call('gmail_create_draft', { to: 'friend@example.com', subject: 'שלום', body: '' });
  let request = f.calls.at(-1);
  assert.match(request.url, /\/drafts$/);
  let mime = Buffer.from(JSON.parse(request.options.body).message.raw, 'base64url').toString();
  assert.ok(mime.endsWith('\r\n\r\n'));
  assert.equal(mime.includes('undefined'), false);
  assert.match(mime, /From: owner@example.com/);
  await call('gmail_send_message', {
    to: 'friend@example.com',
    subject: 'Hi',
    body: 'Approved body',
  });
  request = f.calls.at(-1);
  assert.match(request.url, /messages\/send$/);
  mime = Buffer.from(JSON.parse(request.options.body).raw, 'base64url').toString();
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), 'Approved body');
  const count = f.calls.length;
  await assert.rejects(
    call('gmail_send_message', {
      to: 'friend@example.com\r\nBcc: attacker@example.com',
      subject: 'Hi',
      body: 'No',
    }),
    /newlines/,
  );
  assert.equal(f.calls.length, count);
  await call('drive_upload_text', { name: 'sample.txt', text: 'UTF-8 שלום' });
  request = f.calls.at(-1);
  assert.match(request.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.match(request.options.headers['Content-Type'], /multipart\/related/);
  assert.match(request.options.body, /UTF-8 שלום/);
  await call('docs_batch_update', {
    documentId: 'doc-id',
    requests: [{ insertText: { location: { index: 1 }, text: 'Approved' } }],
  });
  assert.match(f.calls.at(-1).url, /documents\/doc-id:batchUpdate$/);
  await call('sheets_write_range', {
    spreadsheetId: 'sheet-id',
    range: "'Data'!A1:B2",
    values: [['one', 1]],
  });
  request = f.calls.at(-1);
  assert.equal(request.options.method, 'PUT');
  assert.match(request.url, /valueInputOption=RAW/);
  await call('calendar_create_event', {
    event: {
      summary: 'Approved meeting',
      start: { date: '2026-11-01' },
      end: { date: '2026-11-02' },
    },
  });
  assert.match(f.calls.at(-1).url, /sendUpdates=none/);
  await call('contacts_create', { givenName: 'Stellar', email: 'stellar@example.com' });
  request = f.calls.at(-1);
  assert.equal(request.url, 'https://people.googleapis.com/v1/people:createContact');
  assert.deepEqual(JSON.parse(request.options.body).emailAddresses, [
    { value: 'stellar@example.com' },
  ]);
  for (const item of f.calls.filter(
    item => !item.url.includes('oauth2.googleapis.com') && !item.url.includes('userinfo'),
  ))
    assert.equal(item.options.headers.Authorization, 'Bearer access-secret');
  await assert.rejects(
    call('docs_get_document', { documentId: 'doc', url: 'https://attacker.example' }),
    /Unknown/,
  );
});

test('Google token refresh is coalesced, preserves revision for identical scopes and never repeats a failed write', async t => {
  const f = fixture(t);
  await f.auth({ readOnly: false });
  const revision = f.connector.status().revision;
  f.advance(3600001);
  await Promise.all([
    f.connector.callTool('docs_get_document', { documentId: 'a' }, { expectedRevision: revision }),
    f.connector.callTool('docs_get_document', { documentId: 'b' }, { expectedRevision: revision }),
  ]);
  assert.equal(
    f.calls.filter(call => call.url === 'https://oauth2.googleapis.com/token').length,
    2,
  );
  assert.equal(f.connector.status().revision, revision);
  f.setHandler(async url =>
    url.includes('/messages/send') ? json({ error: { message: 'Rate limited' } }, 429) : null,
  );
  const before = f.calls.length;
  await assert.rejects(
    f.connector.callTool('gmail_send_message', {
      to: 'friend@example.com',
      subject: 'Hi',
      body: 'Once',
    }),
    /429/,
  );
  assert.equal(f.calls.length, before + 1);
});

test('configuration changes invalidate old approvals and disconnect aborts calls, revokes tokens and prevents reuse', async t => {
  const f = fixture(t);
  await f.auth();
  const revision = f.connector.status().revision;
  f.connector.configure({ services: ['docs'] });
  await assert.rejects(
    f.connector.callTool('docs_get_document', { documentId: 'x' }, { expectedRevision: revision }),
    /unavailable/,
  );
  await f.auth({ services: ['docs'] });
  let started;
  const waiting = new Promise(resolve => (started = resolve));
  f.setHandler(async (url, options) => {
    if (url.includes('docs.googleapis.com')) {
      started();
      return new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('Transport aborted')), {
          once: true,
        }),
      );
    }
    return null;
  });
  const pending = f.connector.callTool('docs_get_document', { documentId: 'slow' }),
    rejected = assert.rejects(pending, /aborted/);
  await waiting;
  const result = await f.connector.disconnect();
  await rejected;
  assert.equal(result.connected, false);
  assert.equal(f.calls.at(-1).url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(new URLSearchParams(f.calls.at(-1).options.body).get('token'), 'refresh-secret');
  await assert.rejects(
    f.connector.callTool('docs_get_document', { documentId: 'x' }),
    /unavailable/,
  );
});

test('Google transport rejects redirection targets and oversized output while redacting credential errors', async t => {
  const f = fixture(t);
  await f.auth();
  const before = f.calls.length;
  await assert.rejects(
    f.connector.request('https://attacker.example/read', { accessToken: 'access-secret' }),
    /official API/,
  );
  assert.equal(f.calls.length, before);
  f.setHandler(async url =>
    url.includes('docs.googleapis.com')
      ? json({ error: { message: `Bad access-secret and ${secret}` } }, 403)
      : null,
  );
  await assert.rejects(
    f.connector.callTool('docs_get_document', { documentId: 'x' }),
    error =>
      !error.message.includes('access-secret') &&
      !error.message.includes(secret) &&
      error.message.includes('[redacted]'),
  );
  f.setHandler(async url =>
    url.includes('drive/v3/files') ? new Response('x'.repeat(256 * 1024 + 1)) : null,
  );
  await assert.rejects(f.connector.callTool('drive_read_text', { fileId: 'large' }), /size limit/);
});

test('credentials from an old in-flight request remain redacted after configuration replaces them', async t => {
  const f = fixture(t);
  await f.auth();
  f.advance(3600001);
  let started;
  const entered = new Promise(resolve => (started = resolve));
  f.setHandler(async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      started();
      return new Promise((resolve, reject) =>
        options.signal.addEventListener(
          'abort',
          () => reject(new Error(`Old form echoed ${secret} and refresh-secret`)),
          { once: true },
        ),
      );
    }
    return null;
  });
  const pending = f.connector.accessToken(),
    rejected = assert.rejects(
      pending,
      error =>
        !error.message.includes(secret) &&
        !error.message.includes('refresh-secret') &&
        error.message.includes('[redacted]'),
    );
  await entered;
  f.connector.configure({ clientSecret: 'replacement-secret' });
  await rejected;
  assert.equal(f.connector.status().connected, false);
});
