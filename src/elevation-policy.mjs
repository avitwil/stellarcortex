export const SUDO_DENY_RULES = Object.freeze([
  'Bash(sudo)',
  'Bash(sudo *)',
  'Bash(/usr/bin/sudo *)',
  'Bash(/bin/sudo *)',
  'Bash(sudoedit *)',
  'Bash(doas *)',
  'Bash(pkexec *)',
  'Bash(su *)',
  'Bash(runas *)',
  'Bash(runas.exe *)',
]);
export const ELEVATION_POLICY =
  'OS elevation is not permitted. Do not request or run sudo or any other elevation. Recognized elevation commands are refused; this is a best-effort check, not an OS boundary.';
// Recognition, not a shell parser or security boundary. Do not market this as
// complete prevention of equivalent commands, encoded scripts, aliases or MCP.
export function recognizedElevation(command, args = []) {
  if (Array.isArray(command)) return recognizedElevation(command[0] || '', command.slice(1));
  if (typeof command !== 'string') return false;
  args = Array.isArray(args) ? args : [];
  const name = command.trim().split(/[\\/]/).at(-1)?.toLowerCase();
  if (/^(sudo|sudoedit|su|doas|pkexec|runas(?:\.exe)?)$/.test(name)) return true;
  const text = [command, ...(Array.isArray(args) ? args : [])].join(' ');
  if (/\bStart-Process\b[\s\S]*-Verb\s+['"]?RunAs\b/i.test(text)) return true;
  return (
    /(?:^|[;&|\n(])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:command|exec|env)\s+)*(?:[^\s'"`;&|()]*[\\/])?(?:sudo|sudoedit|su|doas|pkexec|runas(?:\.exe)?)(?=\s|$)/i.test(
      text,
    ) ||
    args.some(
      arg =>
        typeof arg === 'string' &&
        /^(?:[^\s]*\/)?(?:sudo|sudoedit|su|doas|pkexec|runas(?:\.exe)?)(?:\s|$)/i.test(arg),
    )
  );
}
