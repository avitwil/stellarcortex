import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localizeDefaultBots } from '../public/default-bot.js';
import { usageErrorText } from '../public/usage-errors.js';
import { providerText } from '../public/provider-text.js';
import { compact } from './helpers/source-text.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'),
  he = a => a,
  en = (_a, b) => b;
test('the first bot title follows the language, in both directions, and an own title stays', () => {
  const bots = () => [{ title: 'Your chief of staff' }, { title: 'Sales lead' }];
  assert.deepEqual(localizeDefaultBots(bots(), he), [
    { title: 'ראש המטה שלך' },
    { title: 'Sales lead' },
  ]);
  const saved = [{ title: 'ראש המטה שלך' }];
  assert.equal(localizeDefaultBots(saved, en)[0].title, 'Your chief of staff');
  assert.match(
    compact(read('public/app.js')),
    /state=await api\('\/api\/state'\);localizeDefaultBots\(state\.bots,tr\)/,
  );
});
test('a Hebrew screen leaves out what a provider wrote in English', () => {
  const he = a => a,
    en = (_, b) => b,
    line = 'Latest workhorse model for coding and everyday work.';
  assert.equal(providerText(line, he), '');
  assert.equal(providerText(line, en), line);
  assert.equal(providerText('מודל לעבודה יומיומית', he), 'מודל לעבודה יומיומית');
  assert.equal(providerText(undefined, en), '');
  const app = compact(read('public/app.js'));
  for (const shown of [
    'description:providerText(item.description,tr)',
    'providerText(context.model.description,tr)',
    'providerText(context.tiers.find',
  ])
    assert.ok(app.includes(shown), shown);
});
test('a Kanban stage is translated wherever a screen names it', () => {
  const kanban = read('public/kanban.js');
  assert.doesNotMatch(kanban.replace(/labels\[stage\] \|\| stage,/, ''), /labels\[/);
  assert.match(kanban, /'Move manually: '\) \+ this\.stageLabel\(stage\)/);
});
test('a task or a bot is never shown as its raw id', () => {
  assert.doesNotMatch(read('public/kanban.js'), /escape\(c\.id\)/);
  assert.doesNotMatch(read('public/themes/mission.js'), /\|\|\s*job\.id\)/);
  assert.doesNotMatch(read('public/kanban.js'), /\?\.name \|\| j\.botId/);
  assert.match(read('public/themes/mission.js'), /job\.text/);
});
test('the account name fallback is translated', () => {
  assert.doesNotMatch(compact(read('public/app.js')), /\|\|\s*'My workspace'/);
});
test('a usage error is a clear line in the owner language, and the raw text stays out', () => {
  const raw = 'codex account authentication required to read rate limits';
  assert.equal(usageErrorText(raw, en), 'Sign in to this provider to see its usage.');
  assert.match(usageErrorText(raw, he), /היכנסו לחשבון/);
  assert.equal(
    usageErrorText('socket hang up', en),
    'Could not read the usage data. Try refreshing.',
  );
  const app = compact(read('public/app.js'));
  assert.doesNotMatch(app, /notice error">'\+esc\(error\)\+'<\/p>':''\)\+[^]{0,400}usage/);
  assert.equal(app.split('esc(usageErrorText(error,tr))').length, 3);
});
test('the notices say only what is known about the browser downloads', () => {
  const text = read('THIRD_PARTY_NOTICES.md');
  assert.doesNotMatch(text, /see the license files in the download/);
  assert.match(text, /Chrome for Testing[^\n]*Not confirmed[^\n]*Widevine/);
});
