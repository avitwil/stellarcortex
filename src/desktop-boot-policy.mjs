import fs from 'node:fs';
// The one setting the app may change as root. It lives in the broker's own folder, so the app cannot write it,
// and the trusted config files stay as they are. fallback() is the value the install chose.
export function bootPolicy(file, fallback) {
  return enabled => {
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') throw Error('Boot setting must be on or off');
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ enabled }), { mode: 0o600 });
      fs.renameSync(temp, file);
    }
    try {
      return { enabled: JSON.parse(fs.readFileSync(file, 'utf8')).enabled === true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { enabled: fallback() === true };
    }
  };
}
