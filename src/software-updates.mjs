import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareVersions,
  fetchRelease,
  latestVersion,
  readPinnedKeys,
} from './signed-releases.mjs';

const SHA = /^[a-f0-9]{40}$/;
export const UPDATE_PREREQUISITE =
  'This installation has no update supervisor. Run bash install.sh --service to get one, or have an administrator stage a verified release, back up the data and provider homes, stop work, switch releases, and restore the previous release and backup if health checks fail. Root-owned systemd installations cannot self-update. No files, ownership, sudo rules or service permissions have been changed.';
export function installedSoftware(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  let commit = null,
    modified = null;
  try {
    // Only the actual checkout can establish provenance. A directory named after
    // a commit is not evidence of its contents, nor is the package version.
    if (fs.existsSync(path.join(root, '.git'))) {
      const value = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (SHA.test(value)) commit = value;
      modified = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }
  } catch {
    /* Unknown provenance is shown honestly for archives and missing Git. */
  }
  return { version, commit, modified };
}
export class SoftwareUpdates {
  constructor({
    root,
    fetchImpl = fetch,
    clock = Date.now,
    installed = installedSoftware(root),
    manager = null,
    keys = null,
  } = {}) {
    this.root = root;
    this.keys = keys;
    this.installed = installed;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.pending = null;
    this.last = null;
    this.manager = manager;
    this.applying = false;
    this.lastUpdate = null;
    this.checkError = null;
    this.progress = null;
  }
  status() {
    return {
      installed: this.installed,
      canApply: !!this.manager,
      prerequisite: this.manager ? null : UPDATE_PREREQUISITE,
      applying: this.applying,
      progress: this.progress,
      lastUpdate: this.lastUpdate,
      checkError: this.checkError,
      ...this.last,
    };
  }
  async check() {
    if (this.pending) return this.pending;
    if (this.last && this.clock() - this.last.checkedAtMs < 30000) return this.status();
    this.pending = (async () => {
      const version = await latestVersion({ fetchImpl: this.fetch, now: this.clock() });
      const entry = await fetchRelease({
          version,
          fetchImpl: this.fetch,
          keys: this.keys || readPinnedKeys(this.root),
        }),
        order = compareVersions(entry.version, this.installed.version);
      const comparison = this.installed.modified
        ? 'locally-modified'
        : order > 0
          ? 'newer-version'
          : order < 0
            ? 'installed-ahead'
            : 'same-version';
      this.last = {
        checkedAtMs: this.clock(),
        checkedAt: new Date(this.clock()).toISOString(),
        offered: { version: entry.version, date: entry.date || null, notes: entry.notes || null },
        comparison,
      };
      this.checkError = null;
      return this.status();
    })()
      .catch(error => {
        this.checkError = error.message;
        throw error;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async requestApply(input, { active = false } = {}) {
    if (this.applying)
      return { ok: false, code: 'update-active', error: 'An update is already in progress.' };
    if (!input || Object.keys(input).some(key => !['version', 'confirm'].includes(key)))
      throw new Error('Only a checked version and explicit confirmation are accepted');
    if (input.confirm !== true) throw new Error('Explicit update confirmation is required');
    if (
      !this.last ||
      this.checkError ||
      this.clock() - this.last.checkedAtMs > 300000 ||
      input.version !== this.last.offered.version
    )
      throw new Error('Check for updates again before confirming this version');
    if (active)
      return {
        ok: false,
        code: 'work-active',
        error: 'Wait for active and queued work to finish before updating.',
      };
    if (!this.manager)
      return {
        ok: false,
        code: 'administrator-required',
        error: UPDATE_PREREQUISITE,
        installed: this.installed,
        offered: this.last.offered,
      };
    if (this.installed.modified)
      throw new Error('This installation has local changes. Preserve them before updating');
    if (this.last.comparison !== 'newer-version')
      throw new Error('Only a newer signed release can be installed');
    this.applying = true;
    try {
      await this.manager.prepare(input.version);
      return { ok: true, status: 'prepared', offered: this.last.offered };
    } catch (error) {
      this.applying = false;
      this.progress = null;
      throw error;
    }
  }
  commitPrepared() {
    if (this.applying) this.manager?.commit();
  }
}
