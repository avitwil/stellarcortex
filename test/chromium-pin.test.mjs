import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'),
  json = file => JSON.parse(read(file)),
  pin = json('deployment/ubuntu-desktop/guest/chromium-pin.json');
test('the Chromium pin matches the Playwright the app uses, so an update cannot drift from it', () => {
  const lock = json('package-lock.json').packages,
    build = json('node_modules/playwright-core/browsers.json').browsers.find(
      browser => browser.name === 'chromium',
    ),
    update =
      'Playwright changed: put the new build in chromium-pin.json, with the SHA-256 and size of a real download.';
  for (const name of ['playwright', 'playwright-core'])
    assert.equal(lock['node_modules/' + name].version, pin.playwright, update);
  assert.equal(json('package.json').dependencies.playwright, pin.playwright, update);
  assert.equal(build.revision, pin.revision, update);
  assert.equal(build.browserVersion, pin.browserVersion, update);
  assert.equal(
    pin.url,
    `https://cdn.playwright.dev/builds/cft/${pin.browserVersion}/linux64/chrome-linux64.zip`,
  );
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(pin.bytes) && pin.bytes > 1e8);
  const firstBoot = read('deployment/ubuntu-desktop/guest/firstboot.sh');
  assert.match(firstBoot, /fetch-chromium\.sh/);
  assert.doesNotMatch(
    firstBoot,
    /playwright\/cli\.js install/,
    "Playwright's own download checks no hash",
  );
});
function fetcher(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = dir.replaceAll('\\', '/'),
    bin = path.join(dir, 'bin'),
    pinDir = path.join(dir, 'deployment/ubuntu-desktop/guest');
  fs.mkdirSync(bin);
  fs.mkdirSync(pinDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(
    path.join(pinDir, 'chromium-pin.json'),
    JSON.stringify(
      { ...pin, sha256: createHash('sha256').update('good build\n').digest('hex'), bytes: 11 },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'fetch.sh'),
    read('deployment/ubuntu-desktop/guest/fetch-chromium.sh')
      .replaceAll('/opt/stellarcortex-browsers', at + '/browsers')
      .replaceAll('/var/lib/stellarcortex-firstboot', at + '/state'),
  );
  const stub = (name, text) =>
    fs.writeFileSync(
      path.join(bin, name),
      '#!/bin/sh\necho "' + name + ' $*" >> "' + at + '/calls"\n' + text + '\n',
      { mode: 0o755 },
    );
  stub('curl', body);
  stub('unzip', 'mkdir -p "$4/chrome-linux64"; touch "$4/chrome-linux64/chrome"');
  const zip = path.join(dir, 'state', 'chrome-linux64.zip');
  return {
    dir,
    zip,
    run: () =>
      spawnSync('bash', ['-c', 'PATH="$PWD/bin:$PATH" sh fetch.sh'], {
        cwd: dir,
        encoding: 'utf8',
      }),
    calls: () =>
      fs.existsSync(path.join(dir, 'calls'))
        ? fs.readFileSync(path.join(dir, 'calls'), 'utf8')
        : '',
    chrome: path.join(dir, 'browsers', 'chromium-' + pin.revision, 'chrome-linux64', 'chrome'),
  };
}
const save = text =>
  `while [ "$#" -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done; printf '${text}\\n' >> "$out"`;
test('a build that does not match its pin is refused before anything unpacks it', t => {
  const f = fetcher(t, save('tampered')),
    run = f.run();
  assert.equal(run.status, 1);
  assert.match(run.stdout, /does not match its pinned SHA-256/);
  assert.doesNotMatch(f.calls(), /unzip/);
  assert.equal(fs.existsSync(f.zip), false, 'the next try starts clean');
  assert.equal(fs.existsSync(f.chrome), false);
});
test('a good build is unpacked where each bot finds it, and a try that ran out of time goes on', t => {
  const f = fetcher(t, save('build'));
  fs.writeFileSync(f.zip, 'good ');
  const run = f.run();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(f.calls(), /curl -fsSL --retry 3 -C - -o /);
  assert.ok(fs.existsSync(f.chrome));
  assert.equal(fs.existsSync(f.zip), false);
});
test('a whole file that failed is fetched again, not resumed', t => {
  const f = fetcher(t, save('good build'));
  fs.writeFileSync(f.zip, 'tampered build here');
  assert.equal(f.run().status, 0);
  assert.ok(fs.existsSync(f.chrome));
});
