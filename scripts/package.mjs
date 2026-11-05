import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
// Explicit allowlist: never package sessions, secrets, user data, logs, or node_modules.
const include = [
  'update-protocol.json',
  'update-keys.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'README.he.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'install.sh',
  'start.sh',
  'claude-login.sh',
  'Dockerfile',
  'compose.yaml',
  '.dockerignore',
  '.gitignore',
  'src',
  'public',
  'scripts',
  'docs',
  'test',
  'deployment/ubuntu-desktop',
];
for (const item of include)
  if (!fs.existsSync(path.join(root, item))) throw new Error(`Missing package input: ${item}`);
// Fail closed if local state or credential artifacts accidentally enter a source folder.
const privateNames = new Set([
  '.git',
  '.codex',
  '.claude',
  '.aws',
  '.ssh',
  '.data',
  '.runtime',
  '.test-data',
  '.protocol',
  'node_modules',
  '.sdk',
  '.tools',
  'build',
  '__pycache__',
  'private',
  'workspace',
  'uploads',
  'browser',
  'desktop-browsers',
  'desktop-sessions',
  'auth.json',
  'credentials.json',
  'token.json',
  'tokens.json',
  'state.json',
  'access-key',
  'sessions.json',
  'stellarcortex.local.json',
  'server.lock',
  'browser-pages.json',
  '.npmrc',
  '.netrc',
  '.bash_history',
  '.zsh_history',
  '.python_history',
]);
function checkSource(file) {
  const name = path.basename(file).toLowerCase(),
    stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    privateNames.has(name) ||
    (/^\.env(?:\.|$)/.test(name) && name !== '.env.example') ||
    /^state\.json\./.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(name) ||
    /\.(?:enc|key|pem|pfx|p12|log|jks|keystore|pyc)$/i.test(name)
  )
    throw new Error(`Private or linked package input refused: ${path.relative(root, file)}`);
  if (stat.isDirectory())
    for (const child of fs.readdirSync(file)) checkSource(path.join(file, child));
}
for (const item of include) checkSource(path.join(root, item));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(dist, `stellarcortex-${version}.tar.gz`);
const r = spawnSync('tar', ['-czf', out, '-C', root, ...include], {
  stdio: 'inherit',
  windowsHide: true,
});
if (r.status !== 0) throw new Error('tar failed');
console.log(out);
const outputs = [out];
fs.writeFileSync(
  path.join(dist, 'SHA256SUMS.txt'),
  outputs
    .map(
      file =>
        `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`,
    )
    .join('\n') + '\n',
);
