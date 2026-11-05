// A task's error says what happened and what to do, in the owner's language. The server's text stays under "details".
const KNOWN = [
  [
    /^Connect your ChatGPT subscription/,
    'connect',
    'החשבון של ChatGPT עוד לא מחובר. חברו אותו, ואז שלחו שוב.',
    'Your ChatGPT account is not connected yet. Connect it, then send this again.',
  ],
  [
    /^Connect your Claude subscription/,
    'connect',
    'החשבון של Claude עוד לא מחובר. חברו אותו, ואז שלחו שוב.',
    'Your Claude account is not connected yet. Connect it, then send this again.',
  ],
  [
    /^Configure the .* connection and API key/,
    'connect',
    'מפתח ה־API של הספק הזה עוד לא הוגדר. הגדירו אותו, ואז שלחו שוב.',
    'This provider’s API key is not set yet. Set it, then send this again.',
  ],
  [
    /^Configure an existing local engine/,
    'connect',
    'מנוע מקומי עוד לא הוגדר. הגדירו כתובת ומודל, ואז שלחו שוב.',
    'No local engine is set yet. Set its address and model, then send this again.',
  ],
  [
    / is unavailable: /,
    'connect',
    'הספק של הבוט לא זמין כרגע. בדקו את החיבור שלו, ואז שלחו שוב.',
    'The bot’s provider is not available right now. Check its connection, then send this again.',
  ],
  [
    /^The provider connection changed/,
    null,
    'החיבור לספק השתנה בזמן שהמשימה התחילה. שלחו שוב.',
    'The provider connection changed as this started. Send it again.',
  ],
  [/^(Stopped|This task or bot has been stopped)/, null, 'המשימה נעצרה.', 'This task was stopped.'],
];
// A stopped program's words mean nothing to the owner, and errors saved earlier may still hold them.
export const PROGRAM_OUTPUT =
  /file:\/\/\/|node:internal|^[ \t]+at \S.*:\d+|throw new Error\(|Traceback \(most recent|Missing optional dependency|not fully installed|^Cannot start Codex|Command failed|Details are in the server log|A program on the server stopped|(?:Codex stopped|Claude Code exited|Claude Code \S+ failed) \(/m;
export const programText = (text, tr) =>
  /Missing optional dependency|not fully installed|Cannot start Codex/.test(text)
    ? tr(
        'Codex לא הותקן במלואו בשרת. הריצו שוב את ההתקנה, ואז שלחו שוב.',
        'Codex is not fully installed on the server. Run the installer again, then send this again.',
      )
    : tr(
        'תוכנה בשרת נעצרה. נסו שוב, ואם זה חוזר בדקו את היומן של השרת.',
        'A program on the server stopped. Try again, and if it repeats, check the server log.',
      );
export const withoutProgramOutput = (text, tr) =>
  PROGRAM_OUTPUT.test(text) ? programText(text, tr) : text;
export function chatErrorText(text, tr) {
  if (PROGRAM_OUTPUT.test(text)) return { text: programText(text, tr), action: null, detail: null };
  const match = KNOWN.find(([pattern]) => pattern.test(text));
  if (match) return { text: tr(match[2], match[3]), action: match[1], detail: null };
  return {
    text: tr(
      'המשימה נעצרה. אפשר לשלוח שוב, ולבדוק את הפרטים למטה.',
      'This task stopped. You can send it again, and see the details below.',
    ),
    action: null,
    detail: text,
  };
}
