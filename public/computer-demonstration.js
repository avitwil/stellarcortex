// Raw keystrokes/clipboard are never retained. Literal text requires explicit per-step review.
const commands =
  /^(?:(?:Control|Alt|Meta|Shift)\+)*(?:Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|Insert|F(?:[1-9]|1[0-2]))$|^(?:Control|Alt|Meta)(?:\+(?:Control|Alt|Meta|Shift))*\+[A-Za-z0-9]$/;
export function safeDemonstrationStep(a, frame = {}) {
  frame = frame || {};
  const dimensions = { width: Number(frame.width), height: Number(frame.height) },
    point = (x, y) => {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(dimensions.width) ||
        !Number.isFinite(dimensions.height) ||
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        x < 0 ||
        y < 0 ||
        x >= dimensions.width ||
        y >= dimensions.height
      )
        throw Error('Invalid demonstration coordinates');
      return { x: Math.round(x), y: Math.round(y) };
    };
  if (a.action === 'reviewed-text') {
    if (
      a.reviewed !== true ||
      typeof a.text !== 'string' ||
      !a.text.trim() ||
      a.text.length > 4096 ||
      !noDemonstrationSecrets(a.text)
    )
      throw Error('Explicitly reviewed non-sensitive text required (maximum 4096 characters)');
    return { action: 'reviewed-text', text: a.text, reviewed: true };
  }
  if (a.action === 'type' || a.action === 'manual-input') return { action: 'manual-input' };
  if (a.action === 'move') return null;
  if (a.action === 'key') {
    if (!commands.test(a.key || '')) throw Error('Only command keys may be recorded');
    return { action: 'key', key: a.key };
  }
  if (a.action === 'scroll') {
    if (!Number.isFinite(a.amount) || a.amount === 0) throw Error('Invalid scroll');
    return { action: 'scroll', amount: Math.max(-2400, Math.min(2400, Math.round(a.amount))) };
  }
  if (['click', 'doubleClick', 'drag'].includes(a.action)) {
    const p = point(a.x, a.y),
      result = { action: a.action, ...p, ...dimensions };
    if (a.action === 'drag')
      Object.assign(result, { toX: point(a.toX, a.toY).x, toY: point(a.toX, a.toY).y });
    else {
      if (!['left', 'right', 'middle'].includes(a.button || 'left'))
        throw Error('Invalid pointer button');
      result.button = a.button || 'left';
    }
    return result;
  }
  throw Error('Unsupported demonstration action');
}
export function demonstrationText(d, language = 'en') {
  const he = language === 'he';
  const lines = d.steps.map(
    (s, i) =>
      `${i + 1}. ` +
      (s.action === 'reviewed-text'
        ? `${he ? 'הקלד את הטקסט שאושר' : 'Type the reviewed text'}: ${JSON.stringify(s.text)}`
        : s.action === 'manual-input'
          ? he
            ? 'הזן את הערך הדרוש ידנית; הטקסט לא הוקלט. אין לבקש סודות בהודעה.'
            : 'Enter the required value manually; text was not recorded. Never request secrets in chat.'
          : s.action === 'key'
            ? `${he ? 'קיצור' : 'Command'}: ${s.key}`
            : s.action === 'scroll'
              ? `${he ? 'גלילה' : 'Scroll'}: ${s.amount}`
              : `${s.action} (${s.x}, ${s.y})${s.action === 'drag' ? ` → (${s.toX}, ${s.toY})` : ''}; ${he ? 'מסך ייחוס' : 'reference screen'} ${s.width}×${s.height}`),
  );
  return `${he ? 'תוצאה רצויה' : 'Intended result'}: ${d.objective}\n\n${he ? 'טיוטה מובנית מהפעולות שהצליחו. יש לערוך ולהוסיף משמעות לצעדים; אין כאן אימון מודל או וידאו.' : 'Structured draft from successful actions. Edit and explain each step; this is not model training or video.'}\n${lines.join('\n')}\n\n${he ? 'לפני שימוש: קבל משימה מפורשת, צלם מסך עדכני ובדוק את היעדים. מיקומים הם רמזים, לא הוראת הרצה עיוורת. שמור על אישורי הפעולות וההרשאות הקיימים. עצור לבקשת קלט רגיש מהמשתמש בלי לשמור אותו.' : 'Before use: require an explicit task, take a fresh screenshot and verify targets. Coordinates are hints, never blind replay instructions. Retain all existing action approvals and permissions. Pause for sensitive user input without storing it.'}`;
}
export function noDemonstrationSecrets(text) {
  return !/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{10,}|-----BEGIN [\w ]*PRIVATE KEY|(?:password|token|secret|סיסמה|סיסמא)\s*[:=]\s*\S+/i.test(
    text,
  );
}
export class ComputerDemonstration {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.current = null;
  }
  start({ botId, mode, objective, authorized }) {
    if (!authorized) throw Error('Take control before teaching');
    if (this.current) throw Error('Review or discard the previous demonstration first');
    if (
      !['desktop', 'browser'].includes(mode) ||
      !objective?.trim() ||
      objective.length > 2000 ||
      !noDemonstrationSecrets(objective)
    )
      throw Error('Enter a non-sensitive intended result');
    this.current = {
      id:
        globalThis.crypto?.randomUUID?.() ||
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
      botId,
      mode,
      objective: objective.trim(),
      state: 'recording',
      startedAt: this.clock(),
      steps: [],
    };
    return this.current;
  }
  capture(args, frame, scope) {
    const d = this.current;
    if (!d || d.state !== 'recording') return;
    if (d.botId !== scope.botId || d.mode !== scope.mode) {
      this.pause();
      return;
    }
    if (this.clock() - d.startedAt >= 600000 || d.steps.length >= 500) {
      this.pause();
      return;
    }
    const step = safeDemonstrationStep(args, frame);
    if (step && !(step.action === 'manual-input' && d.steps.at(-1)?.action === 'manual-input'))
      d.steps.push(step);
  }
  pause() {
    if (this.current?.state === 'recording') this.current.state = 'paused';
  }
  resume(scope) {
    const d = this.current;
    if (
      !d ||
      d.state !== 'paused' ||
      !scope.authorized ||
      d.botId !== scope.botId ||
      d.mode !== scope.mode
    )
      throw Error('Take control of the same agent computer before resuming');
    if (this.clock() - d.startedAt >= 600000 || d.steps.length >= 500)
      throw Error('Demonstration limit reached; review this draft');
    d.state = 'recording';
  }
  stop() {
    if (!this.current) throw Error('No demonstration');
    this.current.state = 'review';
    return this.current;
  }
  discard() {
    this.current = null;
  }
}
