import fs from 'node:fs';
import path from 'node:path';

// Removes all but the newest entries of a folder that only this app writes to. This is
// housekeeping after a finished update, so a failure is logged and never thrown.
export function keepNewest(folder, keep, { match = () => true, protect = [] } = {}) {
  const remove = file => {
    try {
      if (!protect.some(item => path.resolve(item) === path.resolve(file)))
        fs.rmSync(file, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove ${file}: ${error.message}`);
    }
  };
  try {
    if (!fs.existsSync(folder)) return;
    fs.readdirSync(folder)
      .filter(match)
      .map(name => ({
        file: path.join(folder, name),
        time: fs.statSync(path.join(folder, name)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time)
      .slice(keep)
      .forEach(({ file }) => remove(file));
  } catch (error) {
    console.error(`Could not clean ${folder}: ${error.message}`);
  }
}
