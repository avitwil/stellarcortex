import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
test('the image keeps the loopback default and only Compose opts in to wider binding', () => {
  assert.doesNotMatch(read('Dockerfile'), /STELLARCORTEX_BIND/);
  const compose = read('compose.yaml');
  assert.match(compose, /^\s+- STELLARCORTEX_BIND=0\.0\.0\.0$/m);
  assert.match(compose, /^\s+- "127\.0\.0\.1:4317:4317"$/m);
});
test('the image and the WSL launcher are server-only, with no desktop', () => {
  const image = read('Dockerfile');
  assert.doesNotMatch(image, /xvfb|xdotool|openbox|DESKTOP_/i);
  assert.match(image, /^ENTRYPOINT \["\/usr\/bin\/tini","--","node","src\/server\.mjs"\]$/m);
  assert.doesNotMatch(read('scripts/launch.mjs'), /DESKTOP_/);
});
