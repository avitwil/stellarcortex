import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  source = '/usr/share/novnc',
  destination = path.join(root, 'public/vendor/novnc');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
if (pkg.name !== '@novnc/novnc' || pkg.version !== '1.6.0')
  throw Error('Reviewed noVNC 1.6.0 source required');
if (fs.existsSync(destination))
  throw Error('Vendor destination already exists; review rather than silently overwrite');
fs.mkdirSync(destination, { recursive: true });
for (const name of ['core', 'vendor'])
  fs.cpSync(path.join(source, name), path.join(destination, name), {
    recursive: true,
    dereference: false,
  });
fs.copyFileSync('/usr/share/doc/novnc/copyright', path.join(destination, 'COPYRIGHT.txt'));
fs.copyFileSync(
  '/usr/share/common-licenses/MPL-2.0',
  path.join(destination, 'LICENSE.MPL-2.0.txt'),
);
const files = {};
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw Error('Unexpected symlink in vendor source');
    if (e.isDirectory()) walk(p);
    else
      files[path.relative(destination, p)] = createHash('sha256')
        .update(fs.readFileSync(p))
        .digest('hex');
  }
}
walk(destination);
fs.writeFileSync(
  path.join(destination, 'SOURCE.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      source: 'Debian package novnc 1:1.6.0-2',
      upstream: 'https://github.com/novnc/noVNC',
      files,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ vendored: pkg.version, files: Object.keys(files).length, servicesStarted: 0 }),
);
