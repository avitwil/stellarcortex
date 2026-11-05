import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'server.lock'),
    token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (current.token === token) fs.unlinkSync(file);
        } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error(`Cannot read lock ${file}. Check for another server before removing it.`);
      }
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw new Error('Invalid server lock; inspect the data directory');
      let running = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') running = false;
      }
      if (running)
        throw new Error(`Another StellarCortex process (${owner.pid}) owns this data directory.`);
      fs.unlinkSync(file);
    }
  }
  throw new Error('Could not acquire data-directory lock');
}
