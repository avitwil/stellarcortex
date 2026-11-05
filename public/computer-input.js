// Native text input handles Unicode, paste and composition. Only commands become keys.
export function computerKeyAction(event) {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return null;
  const modifier = event.ctrlKey || event.metaKey || event.altKey;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyV') return null;
  if (event.getModifierState?.('AltGraph')) return null;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return null;
  let key = event.key;
  if (modifier && /^(Key[A-Z]|Digit[0-9])$/.test(event.code || ''))
    key = event.code.replace(/^(Key|Digit)/, '');
  const named =
    /^(Enter|Tab|Escape|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|F([1-9]|1[0-2]))$/.test(
      key,
    );
  if (!named && !modifier) return null;
  if (key === ' ') key = 'Space';
  if (!named && !/^[A-Za-z0-9]$/.test(key) && key !== 'Space') return null;
  return {
    action: 'key',
    key: [
      event.ctrlKey ? 'Control' : null,
      event.altKey ? 'Alt' : null,
      event.metaKey ? 'Meta' : null,
      event.shiftKey ? 'Shift' : null,
      key,
    ]
      .filter(Boolean)
      .join('+'),
  };
}

export function screenPoint(event, rect, width, height) {
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width,
    y = (event.clientY - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return {
    x: Math.min(width - 1, Math.max(0, Math.floor(x * width))),
    y: Math.min(height - 1, Math.max(0, Math.floor(y * height))),
  };
}

// Preserve keystroke order; discarding a session also discards its queued input.
export class ComputerInputQueue {
  tail = Promise.resolve();
  epoch = 0;
  pending = 0;
  enqueue(run) {
    const epoch = this.epoch;
    this.pending++;
    const work = this.tail.then(() => (epoch === this.epoch ? run() : false));
    this.tail = work
      .catch(() => {
        if (epoch === this.epoch) this.epoch++;
      })
      .finally(() => this.pending--);
    return work;
  }
  cancel() {
    this.epoch++;
  }
  idle() {
    return this.tail;
  }
}
