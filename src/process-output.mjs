// What a stopped program printed can hold stacks, paths and tokens. A cleaned tail goes to the
// server log, and the error the owner sees stays short.
const HIDDEN = [
  [/https?:\/\/\S+/g, '[url]'],
  [/\b(?:bearer|token|key|secret|password|code)\b\S*[\s:=]+\S+/gi, '[hidden]'],
  [/[A-Za-z0-9+_=-]{24,}/g, '[hidden]'],
];
// The broker and the computer run this file without the public folder, so it imports nothing.
export function logProcessOutput(name, ...parts) {
  const text = HIDDEN.reduce(
    (value, [pattern, mark]) => value.replace(pattern, mark),
    parts.filter(Boolean).join('\n').slice(-800),
  ).trim();
  if (text) console.error(`${name}: ${text}`);
}
