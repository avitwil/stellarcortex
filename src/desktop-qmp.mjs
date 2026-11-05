const modifiers = { Control: 'ctrl', Alt: 'alt', Shift: 'shift', Meta: 'meta_l' };
const named = {
  Enter: 'ret',
  Escape: 'esc',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Space: 'spc',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  Insert: 'insert',
};
const keyEvent = (key, down) => ({
  type: 'key',
  data: { down, key: { type: 'qcode', data: key } },
});
const button = (name, down) => ({ type: 'btn', data: { down, button: name } });
export function qmpInputEvents(action, frame) {
  const point = (x, y) => {
    if (
      !frame ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 2 ||
      frame.height < 2 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= frame.width ||
      y >= frame.height
    )
      throw Error('Coordinates require a fresh matching display frame');
    return [
      { type: 'abs', data: { axis: 'x', value: Math.round((x * 32767) / (frame.width - 1)) } },
      { type: 'abs', data: { axis: 'y', value: Math.round((y * 32767) / (frame.height - 1)) } },
    ];
  };
  if (action.action === 'move') return point(action.x, action.y);
  if (['click', 'doubleClick', 'drag'].includes(action.action)) {
    const b = action.button || 'left';
    if (!['left', 'middle', 'right'].includes(b)) throw Error('Unsupported pointer button');
    const events = point(action.x, action.y);
    if (action.action === 'drag')
      return [...events, button(b, true), ...point(action.toX, action.toY), button(b, false)];
    events.push(button(b, true), button(b, false));
    if (action.action === 'doubleClick') events.push(button(b, true), button(b, false));
    return events;
  }
  if (action.action === 'key') {
    if (typeof action.key !== 'string') throw Error('Named key required');
    const parts = action.key.split('+');
    if (parts.length > 5 || parts.slice(0, -1).some(k => !modifiers[k]))
      throw Error('Unsupported key chord');
    const keys = parts.map(
      k =>
        modifiers[k] ||
        named[k] ||
        (/^F([1-9]|1[0-2])$/.test(k)
          ? k.toLowerCase()
          : /^[A-Za-z0-9]$/.test(k)
            ? k.toLowerCase()
            : null),
    );
    if (keys.some(k => !k) || new Set(keys).size !== keys.length) throw Error('Unsupported key');
    return [
      ...keys.map(k => keyEvent(k, true)),
      ...keys
        .slice()
        .reverse()
        .map(k => keyEvent(k, false)),
    ];
  }
  if (action.action === 'scroll') {
    if (!Number.isFinite(action.amount) || action.amount === 0)
      throw Error('Nonzero scroll required');
    const name = action.amount > 0 ? 'wheel-down' : 'wheel-up',
      count = Math.min(20, Math.max(1, Math.round(Math.abs(action.amount) / 120)));
    return Array.from({ length: count }, () => [button(name, true), button(name, false)]).flat();
  }
  throw Error('Unsupported native action; Unicode text uses the same-session guest text adapter');
}
export const qmpInputCommand = (action, frame) => ({
  execute: 'input-send-event',
  arguments: { events: qmpInputEvents(action, frame) },
});
export function parseQmpReply(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error('Invalid QMP reply');
  }
  if (value.error)
    throw Object.assign(Error('QMP command rejected: ' + String(value.error.class || 'Error')), {
      settled: true,
    });
  if (!Object.hasOwn(value, 'return')) throw Error('QMP reply has no result');
  return value.return;
}
// QMP introspection uses generated type names; identify the supported enums by
// their stable members, then emit releases only (never a press or text input).
export function qmpReleaseCommand(schema) {
  if (!Array.isArray(schema)) throw Error('QMP input schema required');
  const enums = schema.filter(x => x['meta-type'] === 'enum'),
    names = x => (x.members || []).map(m => m.name);
  const keys = enums.filter(x =>
    ['unmapped', 'ctrl', 'shift', 'ret'].every(k => names(x).includes(k)),
  );
  const buttons = enums.filter(x => ['left', 'right', 'wheel-up'].every(k => names(x).includes(k)));
  if (keys.length !== 1 || buttons.length !== 1) throw Error('Ambiguous QMP input schema');
  const keyNames = names(keys[0]).filter(k => k !== 'unmapped'),
    buttonNames = names(buttons[0]);
  if (
    keyNames.length > 512 ||
    buttonNames.length > 32 ||
    [...keyNames, ...buttonNames].some(k => !/^[-a-z0-9_]+$/.test(k))
  )
    throw Error('Invalid QMP input enum');
  return {
    execute: 'input-send-event',
    arguments: {
      events: [...keyNames.map(k => keyEvent(k, false)), ...buttonNames.map(k => button(k, false))],
    },
  };
}
