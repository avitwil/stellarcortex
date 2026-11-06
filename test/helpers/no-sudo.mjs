import fs from 'node:fs';
import path from 'node:path';
// A test must never reach a real sudo, on any machine. Windows ships its own, which asks for admin
// rights on the owner's screen, so a test whose script gets as far as sudo runs on Linux only.
export const noRealSudo = process.platform === 'win32' && 'a script that calls sudo: Linux only';
// The stub is first on PATH. BASH_ENV also makes sudo a bash function that calls the stub by its
// full path, so a script that changes PATH, or a stub that went missing, still cannot get past it.
export function sudoGuard(bin, body = 'exit 1') {
  const stub = path.join(bin, 'sudo'),
    guard = path.join(bin, 'no-real-sudo.sh');
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.writeFileSync(guard, `sudo(){ ${JSON.stringify(stub)} "$@"; }\n`);
  return { BASH_ENV: guard, PATH: bin + path.delimiter + process.env.PATH };
}
