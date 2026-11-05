// Claude Code PreToolUse hook. Exit code 2 denies the tool call and shows stderr to the model.
// Anything that goes wrong here also denies.
import fs from 'node:fs';

let allowed = false;
try {
  for await (const _ of process.stdin);
  allowed = !!process.argv[2] && !fs.existsSync(process.argv[2]);
} catch {}
if (!allowed) {
  process.stderr.write(
    'This task read external content, so shell commands and file changes are blocked. There is no approval path. Do not retry through another tool.',
  );
  process.exit(2);
}
