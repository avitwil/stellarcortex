import fs from 'node:fs';
import path from 'node:path';
import { McpSecretStore } from './mcp-secret-store.mjs';
import { defaultManagerDir } from './managed-updates.mjs';

const FILES = ['google-connection.enc', 'google-connection.key'];
// Only the token waiting for revocation, encrypted like the rest, until Google confirms.
const PENDING = 'google-revoke-pending';

// A file that cannot go must not stop the server. The message names no path content or secret.
function remove(file) {
  try {
    fs.lstatSync(file);
  } catch {
    return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    console.warn(
      `An old Google connection file could not be deleted (${error.code || 'error'}). The next start tries again.`,
    );
  }
}

// Best effort with a short limit. Google answers 400 for a token that is already revoked or expired,
// which needs no retry either.
export async function revokeGoogleToken(token, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  try {
    const response = await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}

// The built-in Google connector was removed. Its saved client secret and tokens are deleted from the
// data folder and from update backups (the key sits next to the file, so a copy is as good as plain
// text; a rollback then simply has no Google setup). The token alone is kept for revocation, and the
// owner sees one notice. Both are saved before the files go.
export function removeGoogleConnection(
  store,
  { managerDirs = [process.env.STELLARCORTEX_MANAGER_DIR, defaultManagerDir(store.dir)] } = {},
) {
  const files = FILES.map(name => path.join(store.dir, 'private', name));
  if (files.some(file => fs.existsSync(file))) {
    try {
      const tokens = new McpSecretStore(store.dir, 'google-connection').data.tokens,
        token = tokens?.refreshToken || tokens?.accessToken;
      if (typeof token === 'string' && token)
        new McpSecretStore(store.dir, PENDING).save({ token });
    } catch {
      // Unreadable files are still deleted; the notice tells the owner to check at Google.
    }
    if (!store.data.notices?.includes('google-removed')) {
      store.data.notices = [...(store.data.notices || []), 'google-removed'];
      store.save();
    }
    for (const file of files) remove(file);
  }
  for (const managerDir of new Set(managerDirs.filter(Boolean))) {
    const backups = path.join(managerDir, 'backups');
    let names = [];
    try {
      names = fs.readdirSync(backups);
    } catch {
      continue;
    }
    for (const name of names)
      for (const file of [...FILES, `${PENDING}.enc`, `${PENDING}.key`])
        remove(path.join(backups, name, 'private', file));
  }
}

// Runs in the background so startup never waits on Google. A failure keeps the token for the next start.
export async function revokeRemovedGoogle(dir, revoke = revokeGoogleToken) {
  if (!fs.existsSync(path.join(dir, 'private', `${PENDING}.enc`))) return;
  let token;
  try {
    token = new McpSecretStore(dir, PENDING).data.token;
  } catch {
    token = null;
  }
  const revoked =
    typeof token === 'string' && token
      ? await (async () => revoke(token))().catch(() => false)
      : true;
  if (revoked)
    for (const ext of ['enc', 'key']) remove(path.join(dir, 'private', `${PENDING}.${ext}`));
  else
    console.warn(
      'The old Google access could not be revoked yet; the next start tries again. You can remove StellarCortex at myaccount.google.com/permissions.',
    );
}
