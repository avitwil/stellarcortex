import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { providerTermsNote } from '../public/provider-terms.js';
import { compact } from './helpers/source-text.mjs';
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const tr = language => (he, en) => (language === 'he' ? he : en);

test('the note beside a sign-in sends the owner to the provider terms, in both languages', () => {
  const en = providerTermsNote(tr('en')),
    he = providerTermsNote(tr('he'));
  assert.match(en, /check the provider’s current terms of use/);
  assert.match(en, /Terms can change/);
  assert.match(en, /not affiliated with any provider/);
  assert.match(en, /href="https:\/\/github\.com\/avitwil\/stellarcortex#provider-terms"/);
  assert.match(he, /תנאי השימוש העדכניים של הספק/);
  assert.match(he, /תנאים יכולים להשתנות/);
  assert.match(he, /README\.he\.md#provider-terms"/);
});
test('every sign-in in Settings shows the note', () => {
  const app = compact(read('public/app.js'));
  assert.equal(app.match(/providerTermsNote\(tr\)/g).length, 3);
  for (const place of [
    /Codex allowance\.'\)\}<\/p>\$\{providerTermsNote\(tr\)\}/,
    /Claude account allowance\.'\)\+'<\/p>'\+providerTermsNote\(tr\)/,
    /are in General\.'\)\+'<\/p>'\+providerTermsNote\(tr\)/,
  ])
    assert.match(app, place);
});
test('the terms section is where the note links, and it promises nothing', () => {
  for (const file of ['README.md', 'README.he.md', 'THIRD_PARTY_NOTICES.md'])
    assert.match(read(file), /<a id="provider-terms"><\/a>/);
  for (const file of ['README.md', 'THIRD_PARTY_NOTICES.md']) {
    const text = read(file);
    assert.match(text, /check that provider's current terms of use yourself/);
    assert.match(text, /Terms can change at any time/);
    assert.match(text, /not affiliated with or endorsed by/);
    assert.match(text, /"as is"/);
  }
  const he = read('README.he.md');
  assert.match(he, /תנאי השימוש העדכניים של אותו ספק/);
  assert.match(he, /תנאים יכולים להשתנות בכל עת/);
  assert.match(he, /"כפי שהיא"/);
  for (const file of ['CONNECTIONS', 'CLAUDE', 'API-LOCAL']) {
    assert.match(read(`docs/${file}.md`), /README\.md#provider-terms/);
    assert.match(read(`docs/${file}.he.md`), /README\.he\.md#provider-terms/);
  }
});
test('the images the READMEs show exist, and the license stays MIT', () => {
  for (const file of ['README.md', 'README.he.md']) {
    const images = [...read(file).matchAll(/\]\((docs\/images\/[^)]+)\)/g)].map(match => match[1]);
    assert.ok(images.length >= 10);
    for (const image of images)
      assert.ok(fs.existsSync(new URL('../' + image, import.meta.url)), image);
  }
  assert.match(read('LICENSE'), /^MIT License/);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
});
test('the ways to run name what the install really reads', () => {
  for (const file of ['README.md', 'README.he.md']) {
    const text = read(file);
    for (const value of [
      'id="ways-to-run"',
      'id="run-local"',
      'id="run-vps"',
      'id="run-lan"',
      'id="computer-check"',
      'install.sh | bash',
      'install.sh | STELLARCORTEX_TAILNET_UI_URL=https://your-machine.your-tailnet.ts.net/ bash',
      'install.sh | STELLARCORTEX_BIND=192.168.1.50 STELLARCORTEX_PUBLIC_URL=http://192.168.1.50:4317 bash',
      'sudo tailscale serve --bg --https=443 unix:/home/stellar/.stellarcortex/tailscale-ui.sock',
      'systemctl --user restart stellarcortex',
    ])
      assert.ok(text.includes(value), file + ': ' + value);
  }
  const needs = compact(read('scripts/install-computer.mjs')).match(
    /NEEDS=\{memoryMiB:(\d+)\+(\d+),diskGiB:(\d+)\}/,
  );
  assert.equal(Number(needs[1]) + Number(needs[2]), 10240);
  assert.equal(needs[3], '90');
  for (const file of ['README.md', 'README.he.md']) {
    const text = read(file);
    assert.ok(text.includes('10240 or more'));
    assert.ok(text.includes('90G or more'));
  }
  assert.match(
    compact(read('scripts/first-link.mjs')),
    /sudo tailscale serve --bg --https=443 unix:\$\{socket\}/,
  );
});
