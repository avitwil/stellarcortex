import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ProviderConnections,
  LOCAL_ENGINES,
  normalizeBaseUrl,
} from '../src/provider-connections.mjs';

function fixture(t) {
  const base = path.resolve('.test-data');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'connections-'));
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== base) throw new Error('Invalid test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, connections: new ProviderConnections(dir) };
}
test('connections persist encrypted outside workspace and public metadata never includes keys', t => {
  const { dir, connections } = fixture(t),
    secret = 'test-secret-do-not-use-123456';
  assert.equal(connections.public('openai-api').configured, false);
  const saved = connections.update('openai-api', { apiKey: secret, defaultModel: 'gpt-test' });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.configured, true);
  assert.equal('apiKey' in saved, false);
  assert.equal(JSON.stringify(connections.list()).includes(secret), false);
  assert.equal(
    fs.readFileSync(path.join(dir, 'private', 'provider-connections.enc'), 'utf8').includes(secret),
    false,
  );
  assert.equal(fs.existsSync(path.join(dir, 'workspace')), false);
  const restored = new ProviderConnections(dir);
  assert.equal(restored.get('openai-api').apiKey, secret);
  assert.equal(restored.public('openai-api').revision, saved.revision);
  const empty = connections.update('openai-api', { apiKey: '', defaultModel: 'gpt-other' });
  assert.equal(empty.hasApiKey, true);
  assert.notEqual(empty.revision, saved.revision);
  connections.update('openai-api', { removeApiKey: true });
  assert.equal(new ProviderConnections(dir).public('openai-api').configured, false);
});
test('cloud endpoints cannot redirect an API key and invalid updates are atomic', t => {
  const { connections } = fixture(t);
  connections.update('anthropic-api', { apiKey: 'secret-a' });
  const revision = connections.get('anthropic-api').revision;
  assert.throws(
    () =>
      connections.update('anthropic-api', {
        apiKey: 'secret-b',
        baseUrl: 'https://other.example/v1',
      }),
    /official/,
  );
  assert.equal(connections.get('anthropic-api').apiKey, 'secret-a');
  assert.equal(connections.get('anthropic-api').revision, revision);
  assert.throws(
    () => connections.update('local', { apiKey: 'key\r\nInjected: header' }),
    /whitespace/,
  );
  assert.throws(() => connections.update('codex', { apiKey: 'key' }), /Unknown/);
  assert.throws(() => connections.update('local', { unexpected: 'setting' }), /Unsupported/);
  assert.throws(
    () => connections.update('local', { apiKey: 'replace', removeApiKey: true }),
    /together/,
  );
});
test('all four local engines have editable presets with optional authentication', t => {
  const { connections } = fixture(t);
  assert.equal(connections.get('local').configured, false);
  for (const engine of LOCAL_ENGINES) {
    connections.update('local', { engine: engine.id });
    assert.equal(connections.get('local').engine, engine.id);
    assert.equal(connections.get('local').baseUrl, engine.defaultBaseUrl);
  }
  const config = connections.update('local', {
    engine: 'vllm',
    baseUrl: 'http://192.168.1.15:8000/v1/',
    defaultModel: 'org/model-v1',
    toolsEnabled: false,
    visionEnabled: true,
  });
  assert.equal(config.configured, true);
  assert.equal(config.hasApiKey, false);
  assert.equal(config.baseUrl, 'http://192.168.1.15:8000/v1');
  assert.equal(config.toolsEnabled, false);
  assert.equal(normalizeBaseUrl('http://[::1]:1234'), 'http://[::1]:1234/v1');
  for (const url of [
    'file:///etc/passwd',
    'http://user:pass@localhost/v1',
    'https://host/v1?api_key=secret',
    'https://host/v1#secret',
    'http://169.254.169.254/v1',
    'http://localhost:11434/v1/chat/completions',
  ])
    assert.throws(() => normalizeBaseUrl(url));
});
test('tampered encrypted connections fail closed without echoing ciphertext or credentials', t => {
  const { dir, connections } = fixture(t);
  connections.update('local', { apiKey: 'secret' });
  const file = path.join(dir, 'private', 'provider-connections.enc'),
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.throws(() => new ProviderConnections(dir), /could not be decrypted/);
});

test('multiple custom API providers persist independently without a required model ID', t => {
  const { dir, connections } = fixture(t);
  const first = connections.create({
    name: 'NVIDIA account',
    apiKey: 'nvidia-test-key',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    protocol: 'chat-completions',
  });
  const second = connections.create({
    name: 'OpenCode account',
    apiKey: 'opencode-test-key',
    baseUrl: 'https://opencode.ai/zen/v1',
    protocol: 'responses',
  });
  assert.match(first.provider, /^custom-/);
  assert.notEqual(first.provider, second.provider);
  assert.equal(first.defaultModel, '');
  assert.equal(first.configured, true);
  assert.equal(first.name, 'NVIDIA account');
  const restored = new ProviderConnections(dir);
  assert.equal(restored.get(first.provider).apiKey, 'nvidia-test-key');
  assert.equal(restored.get(second.provider).protocol, 'responses');
  assert.equal(restored.list().connections.length, 5);
  assert.equal(JSON.stringify(restored.list()).includes('test-key'), false);
  restored.update(first.provider, { name: 'NVIDIA work' });
  assert.equal(restored.public(second.provider).name, 'OpenCode account');
  assert.throws(
    () => connections.create({ name: 'Missing key', baseUrl: 'https://example.com/v1' }),
    /API key/,
  );
  assert.throws(
    () =>
      connections.create({
        name: 'Bad format',
        apiKey: 'key',
        baseUrl: 'https://example.com/v1',
        protocol: 'unknown',
      }),
    /Choose/,
  );
  assert.throws(() => connections.update('custom-unknown', { name: 'No connection' }), /Unknown/);
});

test('custom endpoint changes require explicit key entry and preserve the old connection on error', t => {
  const { connections } = fixture(t);
  const old = connections.create({
    name: 'Gateway',
    apiKey: 'old-key',
    baseUrl: 'https://one.example/gateway/v1',
    protocol: 'anthropic',
  });
  assert.throws(
    () => connections.update(old.provider, { baseUrl: 'https://two.example/v1' }),
    /Re-enter/,
  );
  assert.equal(connections.get(old.provider).baseUrl, old.baseUrl);
  assert.equal(connections.get(old.provider).apiKey, 'old-key');
  const changed = connections.update(old.provider, {
    baseUrl: 'https://two.example/v1',
    apiKey: 'new-key',
    protocol: 'chat-completions',
  });
  assert.notEqual(changed.revision, old.revision);
  assert.equal(changed.protocol, 'chat-completions');
  assert.equal(connections.get(old.provider).apiKey, 'new-key');
  connections.update(old.provider, { removeApiKey: true });
  assert.equal(connections.get(old.provider).configured, false);
});

test('custom catalogs can use a different path but cannot send a key to another origin', t => {
  const { connections } = fixture(t);
  const saved = connections.create({
    name: 'OpenCode',
    apiKey: 'test-key',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    modelsUrl: 'https://opencode.ai/inference/v1/models',
    protocol: 'responses',
  });
  assert.equal(saved.modelsUrl, 'https://opencode.ai/inference/v1/models');
  for (const modelsUrl of [
    'https://other.example/models',
    'http://opencode.ai/inference/v1/models',
    'https://user:pass@opencode.ai/models',
    'https://opencode.ai/models?key=secret',
  ])
    assert.throws(() => connections.update(saved.provider, { modelsUrl }), /same origin/);
  assert.equal(connections.public(saved.provider).modelsUrl, saved.modelsUrl);
  connections.update(saved.provider, { modelsUrl: '' });
  assert.equal(connections.public(saved.provider).modelsUrl, '');
});
