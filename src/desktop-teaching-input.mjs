// Observe only authorized, forwarded RFB input. Never retain printable keysyms.
const keys = new Map([
  [0xff08, 'Backspace'],
  [0xff09, 'Tab'],
  [0xff0d, 'Enter'],
  [0xff1b, 'Escape'],
  [0xff50, 'Home'],
  [0xff51, 'ArrowLeft'],
  [0xff52, 'ArrowUp'],
  [0xff53, 'ArrowRight'],
  [0xff54, 'ArrowDown'],
  [0xff55, 'PageUp'],
  [0xff56, 'PageDown'],
  [0xff57, 'End'],
  [0xffff, 'Delete'],
]);
const modifiers = new Map([
  [0xffe1, 'Shift'],
  [0xffe2, 'Shift'],
  [0xffe3, 'Control'],
  [0xffe4, 'Control'],
  [0xffe9, 'Alt'],
  [0xffea, 'Alt'],
  [0xffeb, 'Meta'],
  [0xffec, 'Meta'],
]);
export class DesktopTeachingInput {
  constructor(emit) {
    this.emit = emit;
    this.modifiers = new Map();
    this.buttons = 0;
    this.presses = new Map();
  }
  push(b) {
    if (b[0] === 4 || b[0] === 255) {
      const down = b[0] === 4 ? b[1] !== 0 : b.readUInt16BE(2) !== 0,
        k = b.readUInt32BE(4),
        modifier = modifiers.get(k);
      if (modifier) {
        if (down) this.modifiers.set(k, modifier);
        else this.modifiers.delete(k);
        return;
      }
      if (!down) return;
      let key = keys.get(k);
      const mods = [...new Set(this.modifiers.values())];
      if (
        !key &&
        mods.some(m => ['Control', 'Alt', 'Meta'].includes(m)) &&
        k >= 48 &&
        k <= 122 &&
        /^[a-z0-9]$/i.test(String.fromCharCode(k))
      )
        key = String.fromCharCode(k).toLowerCase();
      this.emit(
        key ? { action: 'key', key: [...mods, key].join('+') } : { action: 'manual-input' },
      );
      return;
    }
    if (b[0] !== 5) return;
    const mask = b[1] & 127,
      x = b.readUInt16BE(2),
      y = b.readUInt16BE(4);
    for (const [bit, button] of [
      [1, 'left'],
      [2, 'middle'],
      [4, 'right'],
    ]) {
      if (mask & bit && !(this.buttons & bit)) this.presses.set(bit, { x, y });
      if (!(mask & bit) && this.buttons & bit) {
        const p = this.presses.get(bit);
        this.presses.delete(bit);
        if (p)
          this.emit(
            p.x === x && p.y === y
              ? { action: 'click', ...p, button }
              : { action: 'drag', ...p, toX: x, toY: y, button },
          );
      }
    }
    for (const [bit, amount] of [
      [8, -120],
      [16, 120],
    ])
      if (mask & bit && !(this.buttons & bit)) this.emit({ action: 'scroll', amount });
    this.buttons = mask;
  }
}
