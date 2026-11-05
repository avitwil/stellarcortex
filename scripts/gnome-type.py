#!/usr/bin/python3
"""Type into the focused accessible editable field; no clipboard or keymap changes."""

import json, os, signal, sys, time


def validate_text(text):
    if not isinstance(text, str) or not text or len(text) > 1024:
        raise ValueError('Bounded text required')
    if any(
        (ord(c) < 32 and c not in '\n\t') or 0x7F <= ord(c) < 0xA0 or 0xD800 <= ord(c) <= 0xDFFF
        for c in text
    ):
        raise ValueError('Unsupported control character')
    return text


def insert_focused(text, target, locked, cancelled, attempted, pause=time.sleep):
    validate_text(text)
    submitted = 0
    for char in text:
        if cancelled() or locked() or not target.focused():
            return {'submitted': submitted, 'stopped': 'cancelled-or-locked'}
        if target.selections():
            raise ValueError('Clear the selection before inserting text')
        position = target.caret()
        if not isinstance(position, int) or position < 0:
            raise ValueError('Valid insertion position required')
        attempted()
        if not target.insert(position, char, len(char.encode('utf8'))):
            raise RuntimeError('Insertion not confirmed')
        if target.read(position, position + 1) != char:
            raise RuntimeError('Inserted character could not be verified')
        if not target.move_caret(position + 1):
            raise RuntimeError('Caret update not confirmed')
        submitted += 1
        pause(0.005)
    return {'submitted': submitted, 'stopped': None}


class AccessibleTarget:
    def __init__(self, item, Atspi):
        self.item, self.Atspi = item, Atspi
        self.text, self.edit = item.get_text_iface(), item.get_editable_text_iface()
        if self.text is None or self.edit is None:
            raise ValueError('Focused field does not expose editable text')

    def focused(self):
        state = self.item.get_state_set()
        return state.contains(self.Atspi.StateType.FOCUSED) and state.contains(
            self.Atspi.StateType.EDITABLE
        )

    def selections(self):
        return self.text.get_n_selections()

    def caret(self):
        return self.text.get_caret_offset()

    def insert(self, position, text, length):
        return self.edit.insert_text(position, text, length)

    def read(self, start, end):
        return self.Atspi.Text.get_text(self.text, start, end)

    def move_caret(self, offset):
        return self.text.set_caret_offset(offset)


def find_target(Atspi):
    Atspi.set_timeout(750, 750)
    pending = [(Atspi.get_desktop(0), 0)]
    seen, found, deadline = 0, [], time.monotonic() + 4
    while pending:
        if time.monotonic() > deadline or seen >= 4096:
            raise ValueError('Focused editable field search exceeded bounds')
        item, depth = pending.pop()
        seen += 1
        if item is None:
            continue
        state = item.get_state_set()
        if state.contains(Atspi.StateType.FOCUSED) and state.contains(Atspi.StateType.EDITABLE):
            found.append(AccessibleTarget(item, Atspi))
        if depth < 30:
            count = item.get_child_count()
            if count > 1024:
                raise ValueError('Accessible tree exceeds bounds')
            pending.extend((item.get_child_at_index(i), depth + 1) for i in range(count))
    if len(found) != 1:
        raise ValueError('One focused accessible editable field is required')
    return found[0]


def main():
    attempted = [False]
    try:
        if (
            os.getuid() == 0
            or os.environ.get('STELLARCORTEX_INSIDE_GUEST') != '1'
            or os.environ.get('XDG_SESSION_TYPE') != 'wayland'
        ):
            raise ValueError('Existing unprivileged Wayland guest session required')
        data = sys.stdin.buffer.read(16385)
        if len(data) > 16384:
            raise ValueError('Input too large')
        text = validate_text(json.loads(data)['text'])
        import gi

        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi, Gio

        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

        def locked():
            return bus.call_sync(
                'org.gnome.ScreenSaver',
                '/org/gnome/ScreenSaver',
                'org.gnome.ScreenSaver',
                'GetActive',
                None,
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None,
            ).unpack()[0]

        if locked():
            raise ValueError('Guest desktop is locked')
        target = find_target(Atspi)
        cancelled = [False]
        signal.signal(signal.SIGTERM, lambda *_: cancelled.__setitem__(0, True))
        result = insert_focused(
            text, target, locked, lambda: cancelled[0], lambda: attempted.__setitem__(0, True)
        )
        print(json.dumps({'ok': True, **result}))
    except Exception:
        # No field contents, input text or D-Bus arguments in diagnostics.
        print(
            json.dumps(
                {
                    'ok': False,
                    'rejectedBeforeEffects': not attempted[0],
                    'error': (
                        'Native text insertion needs inspection before retrying'
                        if attempted[0]
                        else 'Focus one accessible editable field with no selection; native text input is unavailable otherwise'
                    ),
                }
            )
        )


if __name__ == '__main__':
    main()
