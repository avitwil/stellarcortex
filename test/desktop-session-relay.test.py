import importlib.util, pathlib, unittest, os, socket, tempfile

spec = importlib.util.spec_from_file_location(
    'session_relay',
    pathlib.Path(__file__).resolve().parents[1]
    / 'deployment/ubuntu-desktop/guest/session-relay.py',
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SessionRelayTests(unittest.TestCase):
    def setUp(self):
        self.a = dict(
            accountId='owner',
            environmentId='env',
            computerId='computer',
            botId='alpha',
            vmId='01',
            generation='one',
            sessionId='alpha-session',
            uid=1101,
            enabled=True,
        )
        self.b = {**self.a, 'botId': 'beta', 'sessionId': 'beta-session', 'uid': 1102}
        self.records = m.records_from({'sessions': [self.a, self.b]})

    def test_routes_each_session_and_rejects_identity_substitution(self):
        for row in [self.a, self.b]:
            result, name, display = m.select_session(
                {'protocol': 'scx-session-v1', 'channel': 'display', 'scope': m.identity(row)},
                self.records,
            )
            self.assertEqual(result['uid'], row['uid'])
            self.assertEqual(name, 'vnc.sock')
            self.assertTrue(display)
        with self.assertRaises(ValueError):
            m.select_session(
                {'protocol': 'scx-guest-v1', **m.identity(self.a), 'botId': 'beta'}, self.records
            )

    def test_disabled_and_duplicate_users_fail_closed(self):
        self.records['alpha-session']['enabled'] = False
        with self.assertRaises(ValueError):
            m.select_session({'protocol': 'scx-guest-v1', **m.identity(self.a)}, self.records)
        with self.assertRaises(ValueError):
            m.records_from({'sessions': [self.a, {**self.b, 'uid': 1101}]})

    def test_registry_refusal_reaches_the_host(self):
        sent = []

        class Peer:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def settimeout(self, value):
                pass

            def sendall(self, data):
                sent.append(data)

        with self.assertRaises(ValueError) as caught:
            m.records_from({'sessions': [self.a, {**self.b, 'accountId': 'old-owner'}]})
        self.assertIn('owners', str(caught.exception))

        def bad():
            raise ValueError('mixed registry')

        m.socket.VMADDR_CID_HOST = getattr(m.socket, 'VMADDR_CID_HOST', 2)
        header, registry = m.read_header, m.load_registry
        m.read_header = lambda peer: ({}, b'')
        m.load_registry = bad
        try:
            m.relay(Peer(), (m.socket.VMADDR_CID_HOST, 0))
        finally:
            m.read_header, m.load_registry = header, registry
        self.assertEqual(sent, [b'{"relayError": "mixed registry"}\n'])

    def test_no_arbitrary_channel_or_partial_identity(self):
        with self.assertRaises(ValueError):
            m.select_session(
                {'protocol': 'scx-session-v1', 'channel': 'host', 'scope': m.identity(self.a)},
                self.records,
            )
        with self.assertRaises(ValueError):
            m.identity({'botId': 'alpha'})


class SessionPeerTests(unittest.TestCase):
    def test_real_unix_peer_and_mode_checks(self):
        with tempfile.TemporaryDirectory() as root:
            uid = os.getuid()
            folder = pathlib.Path(root) / str(uid) / 'stellarcortex'
            folder.mkdir(parents=True)
            target = folder / 'worker.sock'
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(target))
                os.chmod(target, 0o600)
                listener.listen(1)
                peer = m.connect_peer({'uid': uid}, 'worker.sock', root=root)
                peer.close()
                os.chmod(target, 0o666)
                with self.assertRaises(ValueError):
                    m.connect_peer({'uid': uid}, 'worker.sock', root=root)

    def test_symlink_socket_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            uid = os.getuid()
            folder = pathlib.Path(root) / str(uid) / 'stellarcortex'
            folder.mkdir(parents=True)
            (folder / 'worker.sock').symlink_to('/does/not/exist')
            with self.assertRaises(ValueError):
                m.connect_peer({'uid': uid}, 'worker.sock', root=root)


if __name__ == '__main__':
    unittest.main()
