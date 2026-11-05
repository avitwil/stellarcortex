import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CODEX_GUEST_CONFIG } from './codex-guest-policy.mjs';
// Native model runners are enabled only for the reviewed immutable executable/policy pair.
const REFRESH =
  'Update from Settings. After an update by hand, render a new bundle from a root-owned clone, run upgrade-approved.sh, then restart the app. See deployment/ubuntu-desktop/README.md. Chat still works; computer tools stay off until then.';
async function runnerProblem(name, entry, trustedUid) {
  const label = name === 'claude' ? 'Claude' : 'Codex';
  let runtime;
  try {
    runtime = fs.lstatSync(entry.executable);
  } catch (error) {
    if (error.code === 'ENOENT') return 'The pinned ' + label + ' program is missing. ' + REFRESH;
    throw error;
  }
  if (
    !runtime.isFile() ||
    runtime.isSymbolicLink() ||
    runtime.uid !== trustedUid ||
    runtime.mode & 0o022
  )
    return 'The pinned ' + label + ' program can be changed by others, so it is off. ' + REFRESH;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(entry.executable)) hash.update(chunk);
  if (hash.digest('hex') !== entry.sha256)
    return 'The ' + label + ' program changed since it was pinned, so it is off. ' + REFRESH;
  if (
    name === 'codex' &&
    entry.policySha256 !==
      createHash('sha256').update(JSON.stringify(CODEX_GUEST_CONFIG)).digest('hex')
  )
    return (
      'This app version has a new Codex tool policy, which the pin does not cover yet. ' + REFRESH
    );
  return null;
}
export async function loadDesktopIsolation({
  file = '/etc/stellarcortex/desktop-isolation.json',
  trustedUid = 0,
} = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== trustedUid || stat.mode & 0o022)
    throw Error('Trusted computer runtime configuration required');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cfg.version !== 1) throw Error('Unsupported computer runtime policy');
  const providerIsolation = {},
    problems = {};
  let codexExecutable = null,
    claudeExecutable = null;
  for (const [name, entry] of Object.entries(cfg.providers || {})) {
    if (
      ['openai-api', 'anthropic-api', 'local'].includes(name) ||
      /^custom-[A-Za-z0-9_-]+$/.test(name)
    ) {
      providerIsolation[name] = entry.enabled === true;
      continue;
    }
    if (!['codex', 'claude'].includes(name)) throw Error('Unknown runtime capability');
    providerIsolation[name] = false;
    if (entry.enabled !== true) continue;
    if (
      typeof entry.executable !== 'string' ||
      !entry.executable.startsWith('/') ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
    )
      throw Error('Pinned native runtime required');
    // A runner that fails its pin is off and says why. The app still starts, and nothing falls back to the host.
    const problem = await runnerProblem(name, entry, trustedUid);
    if (problem) {
      problems[name] = problem;
      console.error(problem);
      continue;
    }
    providerIsolation[name] = true;
    if (name === 'codex') codexExecutable = entry.executable;
    else claudeExecutable = entry.executable;
  }
  return { enabled: true, providerIsolation, codexExecutable, claudeExecutable, problems };
}
