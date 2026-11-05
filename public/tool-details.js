// Presentation only: never mutate saved tool records or approval payloads.
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const labels = {
  command: ['פקודה', 'Command'],
  args: ['ארגומנטים (לפי הסדר)', 'Arguments (in order)'],
  arguments: ['פרמטרים', 'Arguments'],
  cwd: ['תיקיית עבודה', 'Working directory'],
  reason: ['סיבת הבקשה', 'Reason'],
  scope: ['תחום הגישה', 'Access scope'],
  privileged: ['הרשאות מנהל', 'Administrator privileges'],
  permissions: ['הרשאות מבוקשות', 'Requested permissions'],
  input: ['קלט', 'Input'],
  output: ['פלט', 'Output'],
  aggregatedOutput: ['פלט', 'Output'],
  stdout: ['פלט רגיל', 'Standard output'],
  stderr: ['פלט שגיאה', 'Standard error'],
  status: ['מצב', 'Status'],
  exitCode: ['קוד יציאה', 'Exit code'],
  error: ['שגיאה', 'Error'],
  path: ['נתיב', 'Path'],
  text: ['טקסט', 'Text'],
  tool: ['כלי', 'Tool'],
  toolName: ['כלי', 'Tool'],
  timeoutMs: ['זמן קצוב (מילישניות)', 'Timeout (milliseconds)'],
  changes: ['שינויים', 'Changes'],
  diff: ['הבדלים', 'Diff'],
  content: ['תוכן', 'Content'],
  url: ['כתובת', 'URL'],
};
export function parseToolDetail(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function fieldLabel(key, tr) {
  return Object.hasOwn(labels, key)
    ? tr(...labels[key])
    : key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}
function valueHtml(value, tr) {
  if (value === null) return '<span>—</span>';
  if (typeof value === 'object') {
    if (Array.isArray(value))
      return value.length
        ? `<ol>${value.map(v => `<li>${valueHtml(v, tr)}</li>`).join('')}</ol>`
        : '<span>[]</span>';
    return fieldsHtml(value, tr);
  }
  // Do not truncate commands, output, diffs, or unfamiliar permission fields.
  return `<pre dir="auto">${escape(value)}</pre>`;
}
function fieldsHtml(object, tr, omit = new Set()) {
  const keys = Object.keys(object).filter(key => !omit.has(key));
  const priority = [
    'command',
    'args',
    'cwd',
    'reason',
    'scope',
    'privileged',
    'permissions',
    'input',
  ];
  keys.sort(
    (a, b) =>
      (priority.includes(a) ? priority.indexOf(a) : 99) -
      (priority.includes(b) ? priority.indexOf(b) : 99),
  );
  return `<dl>${keys.map(key => `<div class="tool-field"><dt>${escape(fieldLabel(key, tr))}</dt><dd>${valueHtml(object[key], tr)}</dd></div>`).join('')}</dl>`;
}
export function renderToolDetails(
  value,
  { tr = (_he, en) => en, approval = false, fallbackCommand = '' } = {},
) {
  let parsed = parseToolDetail(value);
  if (
    parsed?.input &&
    !Array.isArray(parsed.input) &&
    typeof parsed.input === 'object' &&
    typeof parsed.command === 'string' &&
    parsed.input.command === parsed.command
  ) {
    parsed = { ...parsed, input: { ...parsed.input } };
    delete parsed.input.command;
    if (!Object.keys(parsed.input).length) delete parsed.input;
  }
  let body;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // Correlation IDs remain in storage. Approval fields, including unfamiliar ones,
    // are all shown; transport metadata is omitted only for historical tool cards.
    body = fieldsHtml(
      parsed,
      tr,
      approval ? new Set() : new Set(['id', 'type', 'tool', 'toolName']),
    );
  } else {
    body =
      (fallbackCommand ? fieldsHtml({ command: fallbackCommand }, tr) : '') +
      valueHtml(parsed ?? '', tr);
  }
  return `<div class="tool-details">${body}</div>`;
}
