import { PROGRAM_OUTPUT, programText } from '../public/chat-errors.js';
// Everything sent to the browser is serialized here, so no screen can show a program's output,
// even an error saved by an earlier version. Only these fields are errors or statuses. Everything
// else may be content, such as a tool's output, and code in it looks just like a stack.
export const ERROR_FIELDS = new Set([
  'error',
  'reason',
  'usageError',
  'modelsError',
  'defaultModelError',
  'checkError',
  'admissionError',
  'lastError',
]);
const english = (_, text) => text,
  plain = text => (PROGRAM_OUTPUT.test(text) ? programText(text, english) : text);
export function uiJson(value) {
  // The owner decides on an approval from what the provider wrote, so its details stay as written.
  const asWritten = new WeakSet();
  return JSON.stringify(value, function (key, item) {
    if (key === 'details' || asWritten.has(this)) {
      if (item && typeof item === 'object') asWritten.add(item);
      return item;
    }
    if (typeof item === 'string') return ERROR_FIELDS.has(key) ? plain(item) : item;
    return item?.kind === 'error' && typeof item.text === 'string'
      ? { ...item, text: plain(item.text) }
      : item;
  });
}
