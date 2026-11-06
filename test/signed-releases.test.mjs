import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sudoGuard } from './helpers/no-sudo.mjs';
import {
  LATEST_URL,
  compareVersions,
  downloadRelease,
  fetchRelease,
  latestVersion,
  parsePinnedKeys,
  readPinnedKeys,
  verifyManifest,
} from '../src/signed-releases.mjs';
import { defaultManagerDir, stageRelease } from '../src/managed-updates.mjs';
import { KIT_PATHS, assertKeyLocation, buildRelease, generateKey } from '../scripts/release.mjs';
import {
  fakeSite,
  releaseKey,
  releaseManifest,
  signManifest,
  signedSite,
} from './helpers/signed-release.mjs';

const key = releaseKey(),
  keys = [key.pinned],
  now = Date.parse('2026-11-05T00:00:00Z');
const temp = (t, name = 'scx-release-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const check = (manifest, { signer = key, trusted = keys, version = '0.2.0' } = {}) => {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return verifyManifest({ bytes, signature: signManifest(bytes, signer), keys: trusted, version });
};
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );

test('a signed manifest passes, and versions order as releases do', () => {
  assert.equal(check(releaseManifest()).version, '0.2.0');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});
test('a tampered manifest or an unreadable signature is refused', () => {
  const bytes = Buffer.from(JSON.stringify(releaseManifest())),
    signature = signManifest(bytes, key),
    version = '0.2.0';
  const changed = Buffer.from(bytes.toString().replace('0.2.0', '9.9.9'));
  assert.throws(
    () => verifyManifest({ bytes: changed, signature, keys, version }),
    /signature is not valid/,
  );
  assert.throws(
    () => verifyManifest({ bytes, signature: 'not json', keys, version }),
    /not readable/,
  );
  assert.throws(
    () =>
      verifyManifest({
        bytes,
        signature: JSON.stringify({
          keyId: key.pinned.id,
          signature: Buffer.alloc(64).toString('base64'),
        }),
        keys,
        version,
      }),
    /signature is not valid/,
  );
});
test('only a pinned key is trusted, and no key trusts nothing', () => {
  const other = releaseKey();
  assert.throws(() => check(releaseManifest(), { signer: other }), /does not trust/);
  const forged = { privateKey: other.privateKey, pinned: key.pinned };
  assert.throws(() => check(releaseManifest(), { signer: forged }), /signature is not valid/);
  assert.throws(() => check(releaseManifest(), { trusted: [] }), /no pinned release key/);
});
test('a real manifest under another tag, and a bad one, are refused', () => {
  assert.throws(() => check(releaseManifest('0.1.0'), { version: '0.2.0' }), /another version/);
  for (const change of [
    { schema: 2 },
    { file: '../evil.tar.gz' },
    { sha256: 'x' },
    { size: 0 },
    { updateProtocol: '1' },
    { kitVersion: 'soon' },
  ])
    assert.throws(() => check({ ...releaseManifest(), ...change }), /newer updater|not valid/);
});
test('the latest version comes from the fixed API with no credentials, and only signed bytes are believed', async () => {
  const requests = [],
    site = fakeSite(signedSite(key), requests);
  assert.equal(await latestVersion({ fetchImpl: site }), '0.2.0');
  assert.equal((await fetchRelease({ version: '0.2.0', fetchImpl: site, keys })).sha256.length, 64);
  assert.equal(requests[0].url, LATEST_URL);
  assert.ok(
    requests.every(
      ({ url, options }) =>
        /^https:\/\/(api\.)?github\.com\/(repos\/)?avitwil\/stellarcortex\//.test(url) &&
        !options.headers.Authorization &&
        options.signal,
    ),
  );
  await assert.rejects(
    fetchRelease({ version: '../x', fetchImpl: site, keys }),
    /Invalid update version/,
  );
  await assert.rejects(
    fetchRelease({
      version: '0.2.0',
      fetchImpl: fakeSite({ latest: '{"tag_name":"v0.2.0"}' }),
      keys,
    }),
    /no signed manifest/,
  );
});
test('the rate limit, no release, no network and a bad tag each give their own reason', async () => {
  const answer =
    (status, headers = {}, body = '') =>
    async () =>
      new Response(body, { status, headers });
  await assert.rejects(
    latestVersion({
      fetchImpl: answer(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now / 1000 + 600),
      }),
      now,
    }),
    /rate limit.*10 minutes/,
  );
  await assert.rejects(
    latestVersion({ fetchImpl: answer(429, { 'retry-after': '120' }), now }),
    /rate limit.*2 minutes/,
  );
  await assert.rejects(latestVersion({ fetchImpl: answer(403), now }), /HTTP 403/);
  await assert.rejects(latestVersion({ fetchImpl: answer(404), now }), /No release is published/);
  await assert.rejects(
    latestVersion({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      now,
    }),
    /Could not reach the update server/,
  );
  for (const body of ['{"tag_name":"main"}', '{}', 'not json'])
    await assert.rejects(
      latestVersion({ fetchImpl: answer(200, {}, body), now }),
      /no valid version/,
    );
});
test('a download is checked against its signed hash and size, and leaves nothing behind', async t => {
  const archive = Buffer.from('the real archive'),
    entry = releaseManifest('0.2.0', archive),
    file = path.join(temp(t), 'release.tgz'),
    site = files => fakeSite({ latest: '{"tag_name":"v0.2.0"}', ...files });
  await assert.rejects(
    downloadRelease({
      entry,
      file,
      fetchImpl: site({ [entry.file]: Buffer.from('the fake archive') }),
    }),
    /signed hash/,
  );
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(
    downloadRelease({
      entry,
      file,
      fetchImpl: site({ [entry.file]: Buffer.concat([archive, Buffer.from('x')]) }),
    }),
    /signed size/,
  );
  await downloadRelease({ entry, file, fetchImpl: site({ [entry.file]: archive }) });
  assert.deepEqual(fs.readFileSync(file), archive);
});

function archiveOf(t, files) {
  const dir = temp(t),
    top = path.join(dir, 'stellarcortex-0.2.0');
  fs.mkdirSync(top);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(top, name), text);
  execFileSync('tar', ['-czf', 'out.tgz', 'stellarcortex-0.2.0'], { cwd: dir });
  return fs.readFileSync(path.join(dir, 'out.tgz'));
}
const goodFiles = () => ({
  'package.json': JSON.stringify({ name: 'stellarcortex', version: '0.2.0' }),
  'update-protocol.json': '{"version":1}',
  'update-keys.json': JSON.stringify({ keys }),
});
async function stage(
  t,
  files = goodFiles(),
  {
    version = '0.2.0',
    current = { version: '0.1.0' },
    mutate = archive => archive,
    trusted = keys,
    signer = key,
  } = {},
) {
  const archive = archiveOf(t, files),
    managerDir = temp(t),
    ran = [],
    entry = releaseManifest('0.2.0', archive);
  const site = signedSite(signer, entry, { [entry.file]: mutate(archive) });
  const real = (bin, args, cwd) => {
    ran.push(args.join(' '));
    if (bin === 'tar') execFileSync(bin, args, { cwd });
  };
  const result = await stageRelease(managerDir, {
    version,
    current,
    keys: trusted,
    fetchImpl: fakeSite(site),
    exec: real,
  }).catch(error => error);
  return {
    result,
    ran,
    managerDir,
    leftovers: fs.existsSync(path.join(managerDir, 'releases'))
      ? fs.readdirSync(path.join(managerDir, 'releases'))
      : [],
  };
}
test('staging verifies before it runs anything from the release', async t => {
  const { result, ran, leftovers } = await stage(t);
  assert.equal(result.version, '0.2.0');
  assert.equal(result.commit, null);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(result.root, 'package.json'))).version,
    '0.2.0',
  );
  assert.deepEqual(leftovers, [path.basename(result.root)]);
  assert.match(ran[0], /^-xzf /);
  assert.match(ran[1], / ci --ignore-scripts/);
  assert.match(ran[2], /codex\.js --version/);
  assert.match(ran[3], /playwright.*install chromium/);
});
test('a key can go in a folder that mkdir refuses, such as a drive root', t => {
  const folder = temp(t),
    mkdir = fs.mkdirSync;
  fs.mkdirSync = () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  };
  t.after(() => {
    fs.mkdirSync = mkdir;
  });
  const pinned = generateKey({
    out: path.join(folder, 'k.pem'),
    passphrase: 'a long enough passphrase',
    root: folder + '-repository',
  });
  assert.equal(pinned.id.length, 16);
  assert.ok(fs.existsSync(path.join(folder, 'k.pem')));
});
test('the repository pins exactly the two release keys', () => {
  const keys = parsePinnedKeys(
    fs.readFileSync(new URL('../update-keys.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(keys.map(key => key.id).sort(), ['38b31a3848ca3b52', 'ab5947aab7863be0']);
});
test('staging refuses a tampered tarball before extracting it', async t => {
  const { result, ran, leftovers } = await stage(t, goodFiles(), {
    mutate: archive => {
      const copy = Buffer.from(archive);
      copy[copy.length - 9] ^= 1;
      return copy;
    },
  });
  assert.match(result.message, /signed hash/);
  assert.deepEqual(ran, []);
  assert.deepEqual(leftovers, []);
});
test('staging refuses a wrong key and an old or same version, and fetches nothing for those', async t => {
  assert.match(
    (await stage(t, goodFiles(), { signer: releaseKey() })).result.message,
    /does not trust/,
  );
  for (const installed of ['0.2.0', '0.3.0']) {
    const { result, ran } = await stage(t, goodFiles(), { current: { version: installed } });
    assert.match(result.message, /not newer/);
    assert.deepEqual(ran, []);
  }
});
test('staging refuses a tarball that holds another version, or pins no key', async t => {
  const wrong = await stage(t, {
    ...goodFiles(),
    'package.json': JSON.stringify({ name: 'stellarcortex', version: '0.0.1' }),
  });
  assert.match(wrong.result.message, /version it was signed for/);
  assert.deepEqual(wrong.leftovers, []);
  assert.equal(wrong.ran.length, 1);
  assert.match(
    (await stage(t, { ...goodFiles(), 'update-keys.json': '{"keys":[]}' })).result.message,
    /pins no key/,
  );
});
test('the repository pins well-formed keys, and the manager folder sits beside the data', () => {
  assert.ok(
    Array.isArray(
      readPinnedKeys(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    ),
  );
  assert.equal(
    path.basename(defaultManagerDir('/home/a/.stellarcortex')),
    '.stellarcortex-updates',
  );
});

function repo(t, version = '0.2.0', pinned = keys) {
  const root = temp(t);
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(
    new URL('../scripts/site-install.sh', import.meta.url),
    path.join(root, 'scripts/site-install.sh'),
  );
  const write = (ver, list) => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'stellarcortex', version: ver }),
    );
    fs.writeFileSync(path.join(root, 'update-protocol.json'), '{"version":1}');
    fs.writeFileSync(path.join(root, 'update-keys.json'), JSON.stringify({ keys: list }));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', ver);
    git(root, 'tag', 'v' + ver);
  };
  write(version, pinned);
  return { root, write };
}
const notes = { en: 'Notes', he: 'הערות' };
function ownerKey(t) {
  const folder = temp(t),
    keyFile = path.join(folder, 'release.pem'),
    passphrase = 'a long test passphrase',
    pinned = generateKey({ out: keyFile, passphrase, root: temp(t) });
  return { keyFile, passphrase, pinned };
}
test('the key tool writes an encrypted key, outside the repository and .work, and never overwrites one', t => {
  const { keyFile, passphrase } = ownerKey(t);
  assert.match(fs.readFileSync(keyFile, 'utf8'), /ENCRYPTED PRIVATE KEY/);
  assert.throws(() => generateKey({ out: keyFile, passphrase, root: temp(t) }), /EEXIST/);
  assert.throws(() => assertKeyLocation('scripts/key.pem'), /outside the repository/);
  assert.throws(
    () => assertKeyLocation(path.join(os.tmpdir(), '.work', 'key.pem')),
    /outside the repository/,
  );
  assert.throws(
    () => generateKey({ out: path.join(temp(t), 'k.pem'), passphrase: 'short', root: temp(t) }),
    /at least 12/,
  );
});
test('the release tool signs a clean tag, and its assets verify with the pinned keys', t => {
  const owner = ownerKey(t),
    { root, write } = repo(t, '0.2.0', [owner.pinned]),
    out = temp(t),
    build = (tag, folder) =>
      buildRelease({
        root,
        tag,
        keyFile: owner.keyFile,
        passphrase: owner.passphrase,
        out: folder,
        notes,
        now,
      });
  const read = (folder, version) =>
    verifyManifest({
      bytes: fs.readFileSync(path.join(folder, 'release.json')),
      signature: fs.readFileSync(path.join(folder, 'release.json.sig'), 'utf8'),
      keys: [owner.pinned],
      version,
    });
  const first = build('v0.2.0', out),
    manifest = read(out, '0.2.0');
  assert.equal(manifest.sha256, first.sha256);
  assert.equal(manifest.kitVersion, '0.2.0');
  assert.equal(fs.readFileSync(path.join(out, first.file)).length, manifest.size);
  const script = fs.readFileSync(path.join(out, 'install.sh'), 'utf8');
  assert.ok(script.includes(owner.pinned.publicKey));
  assert.doesNotMatch(script, /@@PINNED/);
  assert.throws(() => build('v0.2.0', out), /already holds/, 'a folder never mixes two builds');
  write('0.3.0', [owner.pinned]);
  const later = temp(t);
  assert.equal(build('v0.3.0', later).version, '0.3.0');
  assert.equal(read(later, '0.3.0').kitVersion, '0.2.0', 'no root part changed');
  assert.throws(() => build('v0.2.0', temp(t)), /not the newest tag/);
});
test('kitVersion names the last release that changed the root parts, so a host that skipped it catches up', t => {
  const owner = ownerKey(t),
    { root, write } = repo(t, '0.2.0', [owner.pinned]),
    build = tag => {
      const out = temp(t);
      buildRelease({
        root,
        tag,
        keyFile: owner.keyFile,
        passphrase: owner.passphrase,
        out,
        notes,
        now,
      });
      return JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    };
  fs.mkdirSync(path.join(root, 'deployment'));
  fs.writeFileSync(path.join(root, 'deployment/unit'), 'new');
  write('0.3.0', [owner.pinned]);
  assert.equal(build('v0.3.0').kitVersion, '0.3.0');
  write('0.4.0', [owner.pinned]);
  assert.equal(build('v0.4.0').kitVersion, '0.3.0');
});
test('the release tool refuses a dirty tree, a wrong tag, a wrong passphrase and an unpinned key', t => {
  const owner = ownerKey(t),
    { root } = repo(t, '0.2.0', [owner.pinned]),
    out = temp(t),
    input = {
      root,
      tag: 'v0.2.0',
      keyFile: owner.keyFile,
      passphrase: owner.passphrase,
      out,
      notes,
      now,
    };
  assert.throws(() => buildRelease({ ...input, passphrase: 'the wrong passphrase' }));
  const other = ownerKey(t);
  assert.throws(
    () => buildRelease({ ...input, keyFile: other.keyFile, passphrase: other.passphrase }),
    /not pinned in the tag/,
  );
  git(root, 'tag', 'v9.9.9');
  assert.throws(() => buildRelease({ ...input, tag: 'v9.9.9' }), /does not match/);
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  assert.throws(() => buildRelease(input), /not clean/);
  assert.equal(fs.existsSync(path.join(out, 'release.json')), false);
});
test('a rotation cannot strand installed copies: the new key must already be pinned in the previous release', t => {
  const first = ownerKey(t),
    second = ownerKey(t),
    { root, write } = repo(t, '0.2.0', [first.pinned]),
    build = (tag, key) =>
      buildRelease({
        root,
        tag,
        keyFile: key.keyFile,
        passphrase: key.passphrase,
        out: temp(t),
        notes,
        now,
      });
  build('v0.2.0', first);
  write('0.3.0', [first.pinned, second.pinned]);
  assert.throws(() => build('v0.3.0', second), /installed copies would refuse/);
  build('v0.3.0', first);
  write('0.4.0', [second.pinned]);
  assert.equal(build('v0.4.0', second).version, '0.4.0');
});

// The whole bootstrap, with a fake curl, uname and install.sh inside the fake release.
function bootstrap(
  t,
  {
    keysJson = JSON.stringify(keys),
    tamperManifest = false,
    tamperArchive = false,
    system = 'Linux',
    tag = 'v0.2.0',
    minimum = '0.2.0',
    existing = null,
  } = {},
) {
  const dir = temp(t, 'scx boot-'),
    bin = path.join(dir, 'bin'),
    site = path.join(dir, 'site'),
    home = path.join(dir, 'home');
  for (const folder of [bin, site, home]) fs.mkdirSync(folder);
  if (existing) {
    fs.mkdirSync(path.join(home, 'stellarcortex'));
    fs.writeFileSync(path.join(home, 'stellarcortex', existing), 'keep');
  }
  const archive = archiveOf(t, {
      ...goodFiles(),
      'install.sh': 'echo "ran install $1 bind=$STELLARCORTEX_BIND" > "$HOME/ran.txt"\n',
    }),
    entry = releaseManifest('0.2.0', archive);
  const files = {
    ...signedSite(key, entry, { [entry.file]: archive }),
    latest: JSON.stringify({ tag_name: tag }),
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(site, name), value);
  if (tamperManifest) fs.appendFileSync(path.join(site, 'release.json'), ' ');
  if (tamperArchive) fs.appendFileSync(path.join(site, entry.file), 'x');
  fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${system}\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac; done\ncp "$SITE/\${url##*/}" "$out"\n`,
    { mode: 0o755 },
  );
  const script = fs
    .readFileSync(new URL('../scripts/site-install.sh', import.meta.url), 'utf8')
    .replace('@@MINIMUM_VERSION@@', () => minimum)
    .replace('@@PINNED_KEYS@@', () => keysJson);
  const run = spawnSync('bash', ['-s'], {
    input: script,
    encoding: 'utf8',
    cwd: dir,
    timeout: 60000,
    env: {
      ...process.env,
      ...sudoGuard(bin),
      HOME: home,
      SITE: site,
      STELLARCORTEX_BIND: '192.0.2.7',
    },
  });
  return {
    run,
    home,
    ran: path.join(home, 'ran.txt'),
    installed: path.join(home, 'stellarcortex/package.json'),
  };
}
test('the one-line install verifies the release, then runs the existing install with the same settings', t => {
  const { run, ran, installed } = bootstrap(t);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(ran, 'utf8').trim(), 'ran install --service bind=192.0.2.7');
  assert.ok(fs.existsSync(installed));
});
test('the one-line install stops on a tampered manifest or tarball, a wrong key or a tag that does not match, and installs nothing', t => {
  for (const [options, message] of [
    [{ tamperManifest: true }, /signature is not valid/],
    [{ tamperArchive: true }, /signed hash/],
    [{ keysJson: JSON.stringify([releaseKey().pinned]) }, /does not trust/],
    [{ tag: 'v0.1.0' }, /manifest is not valid/],
    [{ tag: 'main' }, /no valid version/],
  ]) {
    const { run, ran, installed } = bootstrap(t, options);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, message);
    assert.equal(fs.existsSync(ran), false);
    assert.equal(fs.existsSync(installed), false);
  }
});
test('the one-line install fails clearly on another platform, and when it has no key', t => {
  const other = bootstrap(t, { system: 'Darwin' });
  assert.notEqual(other.run.status, 0);
  assert.match(other.run.stderr, /Linux only.*Darwin/);
  const empty = bootstrap(t, { keysJson: '@@PINNED_KEYS@@' });
  assert.notEqual(empty.run.status, 0);
  assert.match(empty.run.stderr, /no release key/);
  const text = fs.readFileSync(new URL('../scripts/site-install.sh', import.meta.url), 'utf8');
  assert.match(text, /^main\(\)\{$/m);
  assert.match(text.trim(), /\nmain "\$@"$/);
  assert.match(text, /'run this as your regular user/);
});

test('the install says the signature was verified, and only after every check', t => {
  const good = bootstrap(t);
  assert.equal(good.run.status, 0, good.run.stderr);
  assert.match(good.run.stdout, /Signature verified: this is the signed StellarCortex \S+\./);
  for (const refused of [{ minimum: '0.3.0' }, { tamperArchive: true }]) {
    const { run } = bootstrap(t, refused);
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.stdout, /Signature verified/);
  }
  const text = fs.readFileSync(new URL('../scripts/site-install.sh', import.meta.url), 'utf8');
  assert.ok(text.indexOf('Signature verified') > text.indexOf('createHash("sha256")'));
  assert.ok(text.indexOf('Signature verified') < text.indexOf('tar -xzf'));
});
test('the install refuses a release older than its floor, and the release tool sets that floor', t => {
  const { run, ran } = bootstrap(t, { minimum: '0.3.0' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /older than this script allows/);
  assert.equal(fs.existsSync(ran), false);
  assert.equal(bootstrap(t, { minimum: '0.1.9' }).run.status, 0);
  const owner = ownerKey(t),
    { root } = repo(t, '0.2.0', [owner.pinned]),
    out = temp(t);
  buildRelease({
    root,
    tag: 'v0.2.0',
    keyFile: owner.keyFile,
    passphrase: owner.passphrase,
    out,
    notes,
    now,
  });
  const script = fs.readFileSync(path.join(out, 'install.sh'), 'utf8');
  assert.match(script, /local minimum='0\.2\.0'/);
});
test('the install never moves into a folder that holds something, and leaves no staged copy', t => {
  const { run, home } = bootstrap(t, { existing: 'notes.txt' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /already exists and is not empty/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'stellarcortex')), ['notes.txt']);
  assert.deepEqual(fs.readdirSync(home), ['stellarcortex']);
});
test('what the kit packs and pins is covered, so a host always learns that it is behind', t => {
  const text = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
  const covered = file => KIT_PATHS.some(item => file === item || file.startsWith(item + '/'));
  const sources = text('deployment/ubuntu-desktop/host-setup.py').match(/^SOURCES = (\[.*\])$/m)[1];
  for (const item of JSON.parse(sources.replaceAll("'", '"'))) assert.ok(covered(item), item);
  const kit = ['host-setup.py', 'guest/install-sessions.py', 'host-install.sh']
    .map(name => text('deployment/ubuntu-desktop/' + name))
    .join()
    .replaceAll("' / '", '/');
  const read = kit.match(/\b(?:src|scripts)\/[\w.-]+\.m?js\b/g);
  assert.ok(read.includes('src/codex-guest-policy.mjs'));
  for (const file of read) assert.ok(covered(file), file);
  const owner = ownerKey(t),
    { root, write } = repo(t, '0.2.0', [owner.pinned]),
    build = tag => {
      const out = temp(t);
      buildRelease({
        root,
        tag,
        keyFile: owner.keyFile,
        passphrase: owner.passphrase,
        out,
        notes,
        now,
      });
      return JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    };
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/codex-guest-policy.mjs'), 'new');
  write('0.3.0', [owner.pinned]);
  assert.equal(build('v0.3.0').kitVersion, '0.3.0');
});
