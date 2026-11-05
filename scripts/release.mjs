// Builds and signs the assets of a release on the owner's PC. It publishes nothing. The private key stays there: never in the repo, on a server or in .work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import {
  MANIFEST,
  MANIFEST_SCHEMA,
  compareVersions,
  keyId,
  parsePinnedKeys,
  signedBytes,
  validVersion,
  verifyManifest,
} from '../src/signed-releases.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Everything the root step packs and pins, by folder, so no single file can be missed. It covers
// SOURCES in host-setup.py. Too wide costs a few minutes; too narrow leaves the host behind.
export const KIT_PATHS = ['src', 'scripts', 'deployment', 'package-lock.json', 'update-keys.json'];
const git = (cwd, args, encoding = 'utf8') =>
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
    cwd,
    encoding,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const inside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
export function assertKeyLocation(file, root = repository) {
  if (inside(root, file) || path.resolve(file).split(path.sep).includes('.work'))
    throw new Error('Keep the private key outside the repository and .work.');
}
export function generateKey({ out, passphrase, root = repository }) {
  assertKeyLocation(out, root);
  if (!passphrase || passphrase.length < 12)
    throw new Error('Use a passphrase of at least 12 characters.');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  // On Windows, mkdir on a drive root such as F:\ fails even though the root exists.
  const folder = path.dirname(path.resolve(out));
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(out, privateKey, { flag: 'wx', mode: 0o600 });
  const encoded = publicKey.toString('base64');
  return { id: keyId(encoded), publicKey: encoded };
}
function loadKey(file, passphrase) {
  const privateKey = createPrivateKey({ key: fs.readFileSync(file), passphrase });
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('The signing key is not Ed25519.');
  return {
    privateKey,
    id: keyId(
      createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64'),
    ),
  };
}
const signature = (bytes, key) =>
  JSON.stringify({
    keyId: key.id,
    signature: sign(null, signedBytes(bytes), key.privateKey).toString('base64'),
  }) + '\n';
const tagFile = (root, tag, file) => git(root, ['show', `${tag}:${file}`]);
// Tags are the record of what is published, newest first.
const versionTags = root =>
  git(root, ['tag', '--list', 'v*'])
    .split('\n')
    .map(tag => tag.trim().slice(1))
    .filter(validVersion)
    .sort((a, b) => compareVersions(b, a));
// Installed hosts compare this with their own, so one that skipped a release still catches up.
function kitVersion(root, tags) {
  for (let i = 0; i + 1 < tags.length; i++)
    if (
      git(root, [
        'diff',
        '--name-only',
        'v' + tags[i + 1],
        'v' + tags[i],
        '--',
        ...KIT_PATHS,
      ]).trim()
    )
      return tags[i];
  return tags.at(-1);
}
export function buildRelease({
  root = repository,
  tag,
  keyFile,
  passphrase,
  out,
  notes,
  now = Date.now(),
}) {
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']).trim())
    throw new Error('The working tree is not clean.');
  const commit = git(root, ['rev-parse', '--verify', `${tag}^{commit}`]).trim(),
    pkg = JSON.parse(tagFile(root, tag, 'package.json')),
    version = pkg.version;
  if (pkg.name !== 'stellarcortex' || !validVersion(version) || tag !== 'v' + version)
    throw new Error(`Tag ${tag} does not match version ${version} in its package.json.`);
  if (!notes?.en || !notes?.he) throw new Error('Release notes are needed in English and Hebrew.');
  const key = loadKey(keyFile, passphrase),
    pinned = parsePinnedKeys(tagFile(root, tag, 'update-keys.json'));
  if (!pinned.some(item => item.id === key.id))
    throw new Error('This key is not pinned in the tag, so the release could not verify itself.');
  const all = versionTags(root),
    tags = all.filter(item => compareVersions(item, version) <= 0),
    previous = tags[1];
  if (all[0] !== version) throw new Error(`Version ${version} is not the newest tag, ${all[0]}.`);
  if (
    previous &&
    !parsePinnedKeys(tagFile(root, 'v' + previous, 'update-keys.json')).some(
      item => item.id === key.id,
    )
  )
    throw new Error(
      'This key is not pinned in the previous release, so installed copies would refuse it.',
    );
  fs.mkdirSync(out, { recursive: true });
  if (fs.existsSync(path.join(out, MANIFEST)))
    throw new Error('This folder already holds a release.');
  const file = `stellarcortex-${version}.tar.gz`,
    archive = git(
      root,
      ['archive', '--format=tar.gz', `--prefix=stellarcortex-${version}/`, tag],
      'buffer',
    );
  const manifest = {
    schema: MANIFEST_SCHEMA,
    version,
    date: new Date(now).toISOString().slice(0, 10),
    notes,
    file,
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.length,
    updateProtocol: JSON.parse(tagFile(root, tag, 'update-protocol.json')).version,
    kitVersion: kitVersion(root, tags),
    commit,
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    detached = signature(bytes, key);
  verifyManifest({ bytes, signature: detached, keys: pinned, version });
  fs.writeFileSync(path.join(out, file), archive);
  fs.writeFileSync(path.join(out, MANIFEST), bytes);
  fs.writeFileSync(path.join(out, MANIFEST + '.sig'), detached);
  const script = tagFile(root, tag, 'scripts/site-install.sh')
    .replace('@@MINIMUM_VERSION@@', () => version)
    .replace('@@PINNED_KEYS@@', () =>
      JSON.stringify(pinned.map(({ id, publicKey }) => ({ id, publicKey }))),
    );
  fs.writeFileSync(path.join(out, 'install.sh'), script);
  return {
    version,
    file,
    sha256: manifest.sha256,
    kitVersion: manifest.kitVersion,
    installSha256: createHash('sha256').update(script).digest('hex'),
  };
}
// From the terminal, unechoed, or from a pipe. Never an argument, which other processes can read.
function askSecret(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    process.stderr.write(question);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = error => {
      input.off('data', read);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      error ? reject(error) : resolve(value);
    };
    const read = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('Stopped.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', read);
    input.once('end', () => done());
  });
}
async function main() {
  const [command, ...rest] = process.argv.slice(2),
    options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined)
      throw new Error('Options are --name value.');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (command === 'keygen') {
    if (!options.out)
      throw new Error('Usage: node scripts/release.mjs keygen --out <file outside the repository>');
    assertKeyLocation(options.out);
    const passphrase = await askSecret('New passphrase: ');
    if (passphrase !== (await askSecret('Again: '))) throw new Error('The two did not match.');
    console.log(
      'Private key: ' +
        path.resolve(options.out) +
        '\nKeep it offline. Add this to the keys list in update-keys.json:\n' +
        JSON.stringify(generateKey({ out: options.out, passphrase }), null, 2),
    );
  } else if (command === 'build') {
    if (!options.tag || !options.key || !options.out)
      throw new Error(
        'Usage: node scripts/release.mjs build --tag v<version> --key <file> --out <empty folder> --notes-en <text> --notes-he <text>',
      );
    const result = buildRelease({
        tag: options.tag,
        keyFile: options.key,
        passphrase: await askSecret('Key passphrase: '),
        out: options.out,
        notes: { en: options['notes-en'], he: options['notes-he'] },
      }),
      folder = path.resolve(options.out);
    console.log(
      `Signed ${result.file}\nSHA-256 ${result.sha256}\ninstall.sh SHA-256 ${result.installSha256}\nNothing is published. To publish, run:\ngh release create ${options.tag} "${folder}/${result.file}" "${folder}/release.json" "${folder}/release.json.sig" --title ${options.tag} --notes-file <notes>\nThen copy "${folder}/install.sh" to the website.`,
    );
  } else throw new Error('Commands: keygen, build.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
