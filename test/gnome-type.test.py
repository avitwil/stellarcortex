import importlib.util, pathlib, unittest

spec = importlib.util.spec_from_file_location(
    'gnome_type', pathlib.Path(__file__).resolve().parents[1] / 'scripts/gnome-type.py'
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Target:
    def __init__(self):
        self.value = ''
        self.pos = 0
        self.active = True
        self.selected = 0
        self.lengths = []

    def focused(self):
        return self.active

    def selections(self):
        return self.selected

    def caret(self):
        return self.pos

    def insert(self, p, t, n):
        self.lengths.append(n)
        self.value = self.value[:p] + t + self.value[p:]
        return True

    def read(self, a, b):
        return self.value[a:b]

    def move_caret(self, p):
        self.pos = p
        return True


class Tests(unittest.TestCase):
    def test_accessible_get_text_uses_text_interface_not_accessible_getter(self):
        class Item:
            def get_text_iface(self):
                return self

            def get_editable_text_iface(self):
                return self

            def get_text(self):
                raise AssertionError('Wrong Accessible.get_text overload')

        class API:
            class Text:
                @staticmethod
                def get_text(item, start, end):
                    return 'שלום'[start:end]

        self.assertEqual(m.AccessibleTarget(Item(), API).read(0, 4), 'שלום')

    def test_unicode_and_byte_lengths(self):
        t = Target()
        text = 'שלום עולם — café 🙂\n'
        r = m.insert_focused(text, t, lambda: False, lambda: False, lambda: None, lambda _: None)
        self.assertEqual(t.value, text)
        self.assertEqual(r['submitted'], len(text))
        self.assertEqual(t.lengths, [len(c.encode()) for c in text])

    def test_invalid_text(self):
        for s in ['', '\x00', '\x1b', '\ud800', 'a' * 1025]:
            with self.assertRaises(ValueError):
                m.validate_text(s)

    def test_lock_and_focus_cancel_before_new_access(self):
        for reason in ['lock', 'focus', 'cancel']:
            t = Target()
            stop = [False]

            def pause(_):
                stop[0] = True
                if reason == 'focus':
                    t.active = False

            r = m.insert_focused(
                'אב',
                t,
                lambda: stop[0] and reason == 'lock',
                lambda: stop[0] and reason == 'cancel',
                lambda: None,
                pause,
            )
            self.assertEqual(t.value, 'א')
            self.assertEqual(r['submitted'], 1)

    def test_selection_is_not_silently_deleted(self):
        t = Target()
        t.selected = 1
        attempts = []
        with self.assertRaises(ValueError):
            m.insert_focused('a', t, lambda: False, lambda: False, lambda: attempts.append(1))
        self.assertEqual(attempts, [])
        self.assertEqual(t.value, '')

    def test_unconfirmed_insertion_is_not_repeated(self):
        t = Target()
        t.read = lambda *_: 'different'
        attempts = []
        with self.assertRaises(RuntimeError):
            m.insert_focused('אב', t, lambda: False, lambda: False, lambda: attempts.append(1))
        self.assertEqual(len(attempts), 1)
        self.assertEqual(t.value, 'א')


if __name__ == '__main__':
    unittest.main()
