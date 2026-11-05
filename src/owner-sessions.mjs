import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
// Sign-ins survive a restart, so an update does not send the owner back to the login screen.
// Only a hash keyed by the access key is saved: the file signs nobody in, and a new key ends them all.
export class OwnerSessions {
  constructor(dir, key) {
    this.file = path.join(dir, 'sessions.json');
    this.key = key;
    this.entries = new Map();
    try {
      const now = Date.now();
      for (const [hash, expires] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8'))))
        if (expires > now) this.entries.set(hash, expires);
    } catch {
      /* No file yet, or a damaged one: the owner signs in again. */
    }
  }
  hash(token) {
    return createHmac('sha256', this.key).update(String(token)).digest('hex');
  }
  get(token) {
    return this.entries.get(this.hash(token));
  }
  set(token, expires) {
    this.entries.set(this.hash(token), expires);
    this.save();
  }
  // False only when the ended sign-in could come back after a restart.
  delete(token) {
    if (!this.entries.delete(this.hash(token)) || this.save()) return true;
    // Losing every saved sign-in is better than a logout that does not hold.
    try {
      fs.rmSync(this.file, { force: true });
      return true;
    } catch (error) {
      console.error(`Could not remove saved sign-ins: ${error.message}`);
      return false;
    }
  }
  save() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      // The sign-in still works until the next restart.
      console.error(`Could not save sign-ins: ${error.message}`);
      fs.rmSync(temp, { force: true });
      return false;
    }
  }
}
