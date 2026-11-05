import importlib.util, pathlib, unittest

spec = importlib.util.spec_from_file_location(
    'session_plan',
    pathlib.Path(__file__).resolve().parents[1] / 'deployment/ubuntu-desktop/guest/session-plan.py',
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SessionPlanTests(unittest.TestCase):
    def test_stable_separate_users_in_one_computer(self):
        scope = dict(
            accountId='owner',
            environmentId='env',
            computerId='computer',
            vmId='01',
            generation='one',
            botId='a',
        )
        a = m.plan_session(scope, 1101, 21)
        b = m.plan_session({**scope, 'botId': 'b'}, 1102, 22)
        self.assertEqual(a, m.plan_session(scope, 1101, 21))
        self.assertNotEqual(a['user']['name'], b['user']['name'])
        self.assertEqual(a['record']['vmId'], b['record']['vmId'])
        self.assertFalse(a['user']['sudo'])
        self.assertFalse(a['copyCredentials'])
        self.assertFalse(a['session']['tcpListeners'])
        self.assertFalse(a['provisionNewVM'])
        with self.assertRaises(ValueError):
            m.plan_session({**scope, 'botId': '../root'}, 1101, 21)
        with self.assertRaises(ValueError):
            m.plan_session(scope, 0, 21)


if __name__ == '__main__':
    unittest.main()
