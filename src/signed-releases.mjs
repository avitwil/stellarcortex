// Signed releases, published on GitHub. Trust comes only from update-keys.json: GitHub and HTTPS are transport.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const LATEST_URL = 'https://api.github.com/repos/avitwil/stellarcortex/releases/latest';
export const DOWNLOAD_URL = 'https://github.com/avitwil/stellarcortex/releases/download/';
export const MANIFEST = 'release.json';
export const SIGNATURE_CONTEXT = 'stellarcortex-release-v1\n';
export const MANIFEST_SCHEMA = 1;
const MANIFEST_LIMIT = 1024 * 1024,
  ARCHIVE_LIMIT = 256 * 1024 * 1024,
  VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/,
  SHA256 = /^[a-f0-9]{64}$/;
export const validVersion = value =>
  typeof value === 'string' && value.length <= 64 && VERSION.test(value);
const prerelease = (a, b) => {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const left = a.split('.'),
    right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    if (left[i] === right[i]) continue;
    const numbers = /^\d+$/.test(left[i]) && /^\d+$/.test(right[i]);
    return (numbers ? Number(left[i]) - Number(right[i]) : left[i] < right[i] ? -1 : 1) < 0
      ? -1
      : 1;
  }
  return 0;
};
export function compareVersions(a, b) {
  const left = a.match(VERSION),
    right = b.match(VERSION);
  for (let i = 1; i <= 3; i++)
    if (Number(left[i]) !== Number(right[i])) return Number(left[i]) < Number(right[i]) ? -1 : 1;
  return prerelease(left[4], right[4]);
}
export const keyId = publicKey =>
  createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
const publicKeyObject = value =>
  createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
export function parsePinnedKeys(text) {
  const keys = JSON.parse(text).keys;
  if (!Array.isArray(keys)) throw new Error('update-keys.json has no key list');
  for (const key of keys)
    if (
      typeof key?.publicKey !== 'string' ||
      key.id !== keyId(key.publicKey) ||
      publicKeyObject(key.publicKey).asymmetricKeyType !== 'ed25519'
    )
      throw new Error('update-keys.json holds an invalid key');
  return keys;
}
export const readPinnedKeys = root =>
  parsePinnedKeys(fs.readFileSync(path.join(root, 'update-keys.json'), 'utf8'));
export const signedBytes = bytes => Buffer.concat([Buffer.from(SIGNATURE_CONTEXT), bytes]);
const manifestValid = item =>
  validVersion(item?.version) &&
  item.file === `stellarcortex-${item.version}.tar.gz` &&
  SHA256.test(item.sha256 || '') &&
  Number.isSafeInteger(item.size) &&
  item.size > 0 &&
  item.size <= ARCHIVE_LIMIT &&
  Number.isSafeInteger(item.updateProtocol) &&
  validVersion(item.kitVersion);
// The signature is checked on the raw bytes before anything in them is believed.
export function verifyManifest({ bytes, signature, keys, version }) {
  if (!keys?.length)
    throw new Error('This installation has no pinned release key, so it trusts no update.');
  let detached;
  try {
    detached = JSON.parse(signature);
  } catch {
    throw new Error('The release signature is not readable.');
  }
  const key = keys.find(item => item.id === detached?.keyId);
  if (!key) throw new Error('The release is signed by a key this installation does not trust.');
  if (
    typeof detached.signature !== 'string' ||
    !verify(
      null,
      signedBytes(bytes),
      publicKeyObject(key.publicKey),
      Buffer.from(detached.signature, 'base64'),
    )
  )
    throw new Error('The release signature is not valid.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA)
    throw new Error('This release needs a newer updater. Update by hand.');
  if (!manifestValid(manifest)) throw new Error('The release manifest is not valid.');
  if (manifest.version !== version)
    throw new Error('The release manifest was signed for another version, so it was refused.');
  return manifest;
}
async function get(fetchImpl, url, { headers = {}, timeout = 15000 } = {}) {
  try {
    return await fetchImpl(url, {
      headers: { 'User-Agent': 'StellarCortex-updater', ...headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error('Could not reach the update server. Check the connection and try again.');
  }
}
async function readLimited(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('The update response exceeded the size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
// Anonymous API calls are limited per address, and GitHub says when the limit resets.
function rateLimit(response, now) {
  const retry = Number(response.headers.get('retry-after')),
    reset = Number(response.headers.get('x-ratelimit-reset'));
  if (
    response.status !== 429 &&
    !(response.status === 403 && (retry || response.headers.get('x-ratelimit-remaining') === '0'))
  )
    return null;
  const minutes = Math.max(
    1,
    Math.ceil((retry ? retry * 1000 : reset ? reset * 1000 - now : 60000) / 60000),
  );
  return new Error(`Too many update checks for now (rate limit). Try again in ${minutes} minutes.`);
}
// The answer only says what to fetch next: nothing is believed until the signed manifest confirms it.
export async function latestVersion({ fetchImpl = fetch, now = Date.now() } = {}) {
  const response = await get(fetchImpl, LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    }),
    limited = rateLimit(response, now);
  if (limited) throw limited;
  if (response.status === 404) throw new Error('No release is published yet.');
  if (!response.ok)
    throw new Error(`The update check failed (HTTP ${response.status}). Try again later.`);
  const body = await readLimited(response, MANIFEST_LIMIT);
  let tag = null;
  try {
    tag = JSON.parse(body.toString('utf8')).tag_name;
  } catch {
    /* Refused below, with every other bad tag. */
  }
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : null;
  if (!validVersion(version)) throw new Error('The latest release has no valid version.');
  return version;
}
export async function fetchRelease({ version, fetchImpl = fetch, keys }) {
  if (!validVersion(version)) throw new Error('Invalid update version');
  const read = async (name, limit) => {
    const response = await get(fetchImpl, `${DOWNLOAD_URL}v${version}/${name}`);
    if (response.status === 404)
      throw new Error('This release has no signed manifest, so it was refused.');
    if (!response.ok)
      throw new Error(`The update check failed (HTTP ${response.status}). Try again later.`);
    return readLimited(response, limit);
  };
  const [bytes, signature] = await Promise.all([
    read(MANIFEST, MANIFEST_LIMIT),
    read(MANIFEST + '.sig', 4096),
  ]);
  return verifyManifest({ bytes, signature: signature.toString('utf8'), keys, version });
}
// The name comes from a verified manifest and the base is fixed, so the manifest cannot point anywhere else.
export async function downloadRelease({ entry, file, fetchImpl = fetch }) {
  const response = await get(fetchImpl, `${DOWNLOAD_URL}v${entry.version}/${entry.file}`, {
    timeout: 600000,
  });
  if (!response.ok)
    throw new Error(
      `The release download failed (HTTP ${response.status}). The current release is unchanged.`,
    );
  const hash = createHash('sha256'),
    out = fs.openSync(file, 'wx', 0o600);
  let size = 0;
  try {
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > entry.size) throw new Error('The release file is larger than its signed size.');
        hash.update(chunk);
        fs.writeSync(out, chunk);
      }
    } finally {
      fs.closeSync(out);
    }
    if (size !== entry.size || hash.digest('hex') !== entry.sha256)
      throw new Error('The release file does not match its signed hash, so it was refused.');
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}
