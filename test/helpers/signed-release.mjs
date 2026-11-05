// A throwaway release key and a fake GitHub, for tests only.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DOWNLOAD_URL, LATEST_URL, keyId, signedBytes } from '../../src/signed-releases.mjs';

export function releaseKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'),
    encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, pinned: { id: keyId(encoded), publicKey: encoded } };
}
export const signManifest = (bytes, key) =>
  JSON.stringify({
    keyId: key.pinned.id,
    signature: sign(null, signedBytes(bytes), key.privateKey).toString('base64'),
  });
export const releaseManifest = (
  version = '0.2.0',
  archive = Buffer.from('archive'),
  overrides = {},
) => ({
  schema: 1,
  version,
  date: '2026-11-05',
  notes: { en: 'Notes', he: 'הערות' },
  file: `stellarcortex-${version}.tar.gz`,
  sha256: createHash('sha256').update(archive).digest('hex'),
  size: archive.length,
  updateProtocol: 1,
  kitVersion: version,
  commit: 'c'.repeat(40),
  ...overrides,
});
// Each file is a Buffer or a string, and "latest" answers the API. A name that is absent answers 404, and a download must name the release's tag.
export function fakeSite(files, requests = []) {
  const tag = () => {
    try {
      return JSON.parse(files.latest).tag_name;
    } catch {
      return null;
    }
  };
  return async (url, options) => {
    requests.push({ url, options });
    const name =
      url === LATEST_URL
        ? 'latest'
        : url.startsWith(`${DOWNLOAD_URL}${tag()}/`)
          ? url.split('/').pop()
          : null;
    return name !== null && files[name] !== undefined
      ? new Response(files[name])
      : new Response('missing', { status: 404 });
  };
}
export function signedSite(key, manifest = releaseManifest(), extra = {}) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return {
    latest: JSON.stringify({ tag_name: 'v' + manifest.version }),
    'release.json': bytes,
    'release.json.sig': signManifest(bytes, key),
    ...extra,
  };
}
