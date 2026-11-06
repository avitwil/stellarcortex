import base64, contextlib, hashlib, importlib.util, io, pathlib, re, shutil, subprocess, tarfile, tempfile, types, unittest, json, uuid, os
from unittest.mock import patch

os.umask(0o022)
ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


installer = load('installer', 'deployment/ubuntu-desktop/installer.py')
boot = load('boot', 'deployment/ubuntu-desktop/boot.py')
host = load('host', 'deployment/ubuntu-desktop/host-setup.py')


class Tests(unittest.TestCase):
    def fixture(self):
        return dict(
            version=1,
            provider='qemu-kvm-ubuntu-desktop',
            accountId='account',
            botId='bot',
            vmId='02',
            uuid=str(uuid.uuid4()),
            memoryMiB=8192,
            vcpus=4,
            diskGiB=80,
            iso=str(pathlib.Path('/approved/ubuntu.iso').resolve()),
            isoSha256='b' * 64,
            payload=str(pathlib.Path('/approved/code.tar.gz').resolve()),
            payloadSha256='a' * 64,
            network='stellarcortex-desktops',
            disableGuestIdleLock=True,
        )

    def test_invalid_identity_resources_and_media_rejected(self):
        p = self.fixture()
        installer.validate(p)
        for key, value in [
            ('vmId', '01'),
            ('vmId', '../../etc'),
            ('botId', 'bot;reboot'),
            ('memoryMiB', 1),
            ('isoSha256', 'not-a-hash'),
            ('network', 'default'),
            ('disableGuestIdleLock', False),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                installer.validate({**p, key: value})

    def test_full_desktop_serial_target_no_credential(self):
        p = self.fixture()
        a = installer.autoinstall(p)['autoinstall']
        self.assertEqual(a['source']['id'], 'ubuntu-server')
        self.assertEqual(a['identity']['password'], '!')
        self.assertFalse(a['ssh']['install-server'])
        self.assertEqual(a['storage']['layout']['match']['serial'], installer.disk_serial(p))
        self.assertEqual(a['shutdown'], 'poweroff')
        self.assertLessEqual(len(installer.disk_serial(p)), 20)

    def test_durable_intent_precedes_first_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'state.json'
            p = self.fixture()
            (pathlib.Path(directory) / 'provisioning').mkdir()

            def prepare(_):
                self.assertEqual(json.loads(file.read_text())['stage'], 'applying')
                raise RuntimeError('lost completion')

            with patch.object(installer, 'ROOT', pathlib.Path(directory)), patch.object(
                installer, 'prepare', prepare
            ), self.assertRaises(RuntimeError):
                installer.advance(p, file)
            with patch.object(installer, 'prepare') as prepare, self.assertRaisesRegex(
                RuntimeError, 'no automatic replay'
            ):
                installer.advance(p, file)
            prepare.assert_not_called()

    def test_new_vm_directory_is_traversable_under_service_umask(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d)
            root = base / 'desktops'
            root.mkdir()
            runtime = base / 'runtime'
            runtime.mkdir()
            (runtime / 'scx-desktop-02').mkdir()
            iso = base / 'iso'
            iso.write_bytes(b'iso')
            payload = base / 'payload'
            payload.write_bytes(b'payload')
            p = self.fixture()
            p.update(
                iso=str(iso),
                isoSha256=installer.digest(iso),
                payload=str(payload),
                payloadSha256=installer.digest(payload),
            )

            def run(args, timeout=60):
                if '-extract' in args:
                    pathlib.Path(args[-1]).write_text(
                        '# Ubuntu-Server 26.04 LTS\n- description: x\n  id: ubuntu-server\n'
                    )
                if '-outdev' in args:
                    pathlib.Path(args[args.index('-outdev') + 1]).write_bytes(b'derived')
                return ''

            old = os.umask(0o077)
            try:
                with patch.object(installer, 'ROOT', root), patch.object(
                    installer, 'RUNTIME', runtime
                ), patch.object(installer, 'preflight'), patch.object(
                    installer, 'run', run
                ), patch.object(
                    installer, 'domain_xml', return_value='<domain/>'
                ), patch.object(
                    installer, 'virsh', return_value=''
                ), patch.object(
                    installer, 'assert_identity'
                ), patch.object(
                    installer.os, 'chown'
                ):
                    installer.prepare(p)
                self.assertEqual((root / installer.domain(p)).stat().st_mode & 0o777, 0o711)
                self.assertEqual((runtime / installer.domain(p)).stat().st_mode & 0o777, 0o700)
            finally:
                os.umask(old)

    def test_plan_hash_covers_owner_and_lock_policy(self):
        p = self.fixture()
        self.assertNotEqual(installer.plan_hash(p), installer.plan_hash({**p, 'botId': 'another'}))
        self.assertNotEqual(
            installer.plan_hash(p), installer.plan_hash({**p, 'disableGuestIdleLock': False})
        )

    def test_automatic_allocation_is_bounded_and_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            directory = pathlib.Path(d)
            payload = directory / 'payload'
            payload.write_bytes(b'fixture')
            cfg = {
                'desktops': [],
                'provisioningPolicy': {
                    'approved': True,
                    'accountId': 'account',
                    'vmIds': ['02', '03'],
                    'iso': '/approved/ubuntu.iso',
                    'isoSha256': 'b' * 64,
                    'payload': str(payload),
                    'payloadSha256': installer.digest(payload),
                    'disableGuestIdleLock': True,
                },
                'allocationResults': {'bot': {'state': 'needs-attention'}},
            }
            row = installer.allocate(cfg, 'bot', directory)
            self.assertEqual(row['vmId'], '02')
            self.assertEqual(installer.allocate(cfg, 'bot', directory), row)
            self.assertEqual(cfg['allocationResults'], {})
            self.assertEqual(
                installer.allocate(cfg, 'other', directory),
                row,
                'every bot shares the one computer',
            )
            self.assertEqual(len(list(directory.glob('*.plan.json'))), 1)
            self.assertEqual(
                json.loads((directory / '02.plan.json').read_text())['isoSha256'],
                'b' * 64,
                'the image comes from the install, not from the code',
            )

    def test_old_computers_keep_their_number_and_a_full_list_says_what_to_do(self):
        with tempfile.TemporaryDirectory() as d:
            directory = pathlib.Path(d)
            payload = directory / 'payload'
            payload.write_bytes(b'fixture')
            cfg = {
                'desktops': [{'accountId': 'account', 'botId': 'old', 'vmId': '02'}],
                'preservedComputers': [{'vmId': '03'}],
                'provisioningPolicy': {
                    'approved': True,
                    'accountId': 'account',
                    'vmIds': ['02', '03'],
                    'iso': '/approved/ubuntu.iso',
                    'isoSha256': 'b' * 64,
                    'payload': str(payload),
                    'payloadSha256': installer.digest(payload),
                    'disableGuestIdleLock': True,
                },
            }
            with self.assertRaisesRegex(RuntimeError, 'remove-computer'):
                installer.allocate(cfg, 'bot', directory)

    def test_remove_computer_needs_its_name_and_leaves_nothing_that_blocks_a_new_install(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d)
            root = base / 'desktops'
            runtime = base / 'run'
            (root / 'provisioning').mkdir(parents=True)
            (root / 'sessions').mkdir()
            (root / 'scx-desktop-02').mkdir()
            (runtime / 'scx-desktop-02').mkdir(parents=True)
            (root / 'provisioning' / '02.plan.json').write_text('{}')
            (root / 'provisioning' / '02.state.json').write_text('{}')
            (root / 'sessions' / 'bot.json').write_text('{}')
            ids = {
                'computerId': 'scx-desktop-02',
                'environmentId': 'scx-desktop-02',
                'accountId': 'account',
            }
            keep = {'vmId': '01', 'botId': 'other'}
            broker, provider = base / 'broker.json', base / 'provider.json'
            broker.write_text(
                json.dumps(
                    {
                        'desktops': [{'vmId': '02', 'botId': 'bot'}, keep],
                        'provisioningAllocations': [{'vmId': '02'}],
                        'preservedComputers': [{'vmId': '02'}],
                        'sessionProvisioning': ids,
                        'bootApproved': True,
                    }
                )
            )
            provider.write_text(
                json.dumps({'records': [{'vmId': '02'}, keep], 'environmentComputer': ids})
            )
            calls = []

            def virsh(*args):
                calls.append(args)
                return 'scx-desktop-02\n' if args[0] == 'list' else 'running\n'

            with patch.object(installer, 'ROOT', root), patch.object(
                installer, 'RUNTIME', runtime
            ), patch.object(installer, 'BROKER', str(broker)), patch.object(
                installer, 'PROVIDER', str(provider)
            ), patch.object(
                installer, 'virsh', virsh
            ):
                with self.assertRaisesRegex(RuntimeError, '--confirm-delete scx-desktop-02'):
                    installer.remove_computer('02', '')
                self.assertEqual(calls, [])
                installer.remove_computer('02', 'scx-desktop-02')
            self.assertIn(('destroy', 'scx-desktop-02'), calls)
            self.assertIn(('undefine', 'scx-desktop-02', '--nvram'), calls)
            self.assertFalse(
                (root / 'scx-desktop-02').exists()
                or (runtime / 'scx-desktop-02').exists()
                or (root / 'provisioning' / '02.plan.json').exists()
                or (root / 'sessions' / 'bot.json').exists()
            )
            b, v = json.loads(broker.read_text()), json.loads(provider.read_text())
            self.assertEqual(
                (
                    b['desktops'],
                    b['provisioningAllocations'],
                    b['preservedComputers'],
                    v['records'],
                    b['bootApproved'],
                    b['allocationResults'],
                ),
                ([keep], [], [], [keep], True, {}),
            )
            self.assertNotIn('sessionProvisioning', b)
            self.assertNotIn('environmentComputer', v)

    def test_unapproved_capacity_never_creates_plan(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                installer.allocate({'desktops': []}, 'bot', pathlib.Path(d))
            self.assertEqual(list(pathlib.Path(d).iterdir()), [])

    def test_boot_running_is_noop_and_unknown_state_rejected(self):
        r = installer.record(self.fixture())
        cfg = {'bootApproved': True, 'desktops': [r]}
        self.assertEqual(boot.startup_actions(cfg, lambda _: (r['uuid'], 'running')), [])
        self.assertEqual(
            boot.startup_actions(cfg, lambda _: (r['uuid'], 'shut off')), [r['domain']]
        )
        for state in ['paused', 'in shutdown', 'crashed']:
            with self.assertRaises(RuntimeError):
                boot.startup_actions(cfg, lambda _: (r['uuid'], state))
        with self.assertRaises(RuntimeError):
            boot.startup_actions(cfg, lambda _: ('other', 'running'))

    def test_shared_boot_deduplicates_and_preserves_previous_computer(self):
        first = {'domain': 'scx-desktop-01', 'vmId': '01', 'uuid': 'one'}
        second = {'domain': 'scx-desktop-02', 'vmId': '02', 'uuid': 'two'}
        seen = []

        def status(name):
            seen.append(name)
            return ('one' if name.endswith('01') else 'two', 'shut off')

        self.assertEqual(
            boot.startup_actions(
                {
                    'bootApproved': True,
                    'desktops': [first, dict(first)],
                    'preservedComputers': [second],
                },
                status,
            ),
            ['scx-desktop-01', 'scx-desktop-02'],
        )
        self.assertEqual(len(seen), 2)

    def test_a_stale_preserved_computer_never_keeps_the_shared_one_down(self):
        shared = {'domain': 'scx-desktop-01', 'vmId': '01', 'uuid': 'one'}
        gone = {'domain': 'scx-desktop-02', 'vmId': '02', 'uuid': 'two'}
        changed = {'domain': 'scx-desktop-03', 'vmId': '03', 'uuid': 'three'}
        paused = {'domain': 'scx-desktop-04', 'vmId': '04', 'uuid': 'four'}
        good = {'domain': 'scx-desktop-05', 'vmId': '05', 'uuid': 'five'}

        def status(name):
            if name.endswith('02'):
                raise boot.subprocess.CalledProcessError(1, 'virsh')
            return {
                '01': ('one', 'shut off'),
                '03': ('other', 'shut off'),
                '04': ('four', 'paused'),
                '05': ('five', 'shut off'),
            }[name[-2:]]

        with patch('sys.stderr') as log:
            self.assertEqual(
                boot.startup_actions(
                    {'desktops': [shared], 'preservedComputers': [gone, changed, paused, good]},
                    status,
                ),
                ['scx-desktop-01', 'scx-desktop-05'],
            )
        shown = ''.join(str(call) for call in log.write.call_args_list)
        for name in ['scx-desktop-02', 'scx-desktop-03', 'scx-desktop-04']:
            self.assertIn(name, shown)
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            boot.startup_actions({'desktops': [changed]}, status)

    def test_boot_runtime_parent_traversable_under_private_umask(self):
        import types

        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d) / 'runtime'
            old = os.umask(0o077)
            try:
                with patch.object(boot.os, 'chown'):
                    boot.prepare_runtime(
                        [{'domain': 'scx-desktop-02'}],
                        root,
                        types.SimpleNamespace(pw_uid=1, pw_gid=1),
                    )
                self.assertEqual(root.stat().st_mode & 0o777, 0o711)
                self.assertEqual((root / 'scx-desktop-02').stat().st_mode & 0o777, 0o700)
            finally:
                os.umask(old)

    def firewall(self, argv=[], items=[], ufw=None, firewalld=None, iptables='', zones='', **nft):
        '''Runs the script against stubbed host tools. A tool left at None is not installed.'''
        import types

        network = load('coexistence', 'deployment/ubuntu-desktop/network-coexistence.py')
        guard = [{'table': {'name': 'scx_desktops'}}]
        calls, scripts = [], []

        def run(args, **kwargs):
            args = list(args)
            calls.append(args)
            done = lambda out='', code=0: types.SimpleNamespace(returncode=code, stdout=out)
            if args[:3] == ['nft', '-j', 'list']:
                if nft.get('unreadable') == 'crash':
                    raise OSError('no fork')
                if nft.get('unreadable'):
                    return done('', 1)
                reloaded = nft.get('guard') == 'reloads' and ['systemctl', 'reload'] in [
                    c[:2] for c in calls
                ]
                loaded = 'guard' not in nft or reloaded
                return done(json.dumps({'nftables': (guard if loaded else []) + items}))
            if args[0] == 'nft':
                if '--check' in args:
                    scripts.append(kwargs['input'])
                return done()
            present = {'ufw': ufw, 'firewall-cmd': firewalld, 'iptables': iptables}
            if present.get(args[0], '') is None:
                raise FileNotFoundError(args[0])
            if args[0] == 'firewall-cmd' and '--get-zones' in args:
                return done(zones)
            if args[0] == 'iptables' and '-S' not in args:
                return done('', int('-C' in args or '-D' in args))
            return done(present.get(args[0], ''))

        with patch.object(network.sys, 'argv', ['coexistence', *argv]), patch.object(
            network.subprocess, 'run', run
        ), patch.object(network.shutil, 'copy') as copy, patch.object(
            network.time, 'sleep', side_effect=[None] * nft.get('rounds', 0) + [SystemExit('end')]
        ), contextlib.redirect_stdout(
            io.StringIO()
        ) as printed:
            with self.assertRaises(SystemExit) as stopped:
                network.main()
        return types.SimpleNamespace(
            code=stopped.exception.code,
            calls=calls,
            script=''.join(scripts),
            copied=copy.call_args_list,
            printed=printed.getvalue(),
        )

    def chain(self, name='input', hook='input', policy='accept', **values):
        return {
            'chain': {
                'family': 'inet',
                'table': 'ownrules',
                'name': name,
                'type': 'filter',
                'hook': hook,
                'policy': policy,
                **values,
            }
        }

    def rule(self, chain='input', expr=[{'accept': None}], **values):
        return {
            'rule': {
                'family': 'inet',
                'table': 'ownrules',
                'chain': chain,
                'handle': 7,
                'expr': expr,
                **values,
            }
        }

    def test_a_host_with_nothing_that_blocks_needs_no_rules(self):
        for items in [
            [],
            [self.chain()],
            [self.chain(), self.rule()],
            [self.chain(policy='drop', hook='output', name='output')],
            [self.chain(policy='drop', type='nat')],
        ]:
            self.assertEqual(self.firewall(['--check'], items).code, 0, items)

    def test_a_drop_policy_or_a_drop_rule_needs_rules_and_is_named(self):
        for items in [
            [self.chain(policy='drop')],
            [self.chain(), self.rule(expr=[{'drop': None}])],
            [self.chain(), self.rule(expr=[{'reject': {'type': 'icmpx'}}])],
            [self.chain(), self.rule(expr=[{'jump': {'target': 'mine'}}])],
        ]:
            done = self.firewall(['--check'], items)
            self.assertEqual(done.code, 10, items)
            self.assertIn('ownrules', done.printed)

    def test_rules_go_only_into_blocking_chains_and_name_the_bridge(self):
        done = self.firewall(
            items=[
                self.chain(policy='drop'),
                self.chain('routed', 'forward', 'drop'),
                self.chain('open', 'forward'),
            ]
        )
        lines = done.script.splitlines()
        self.assertEqual(done.code, 0)
        self.assertEqual(len(lines), 5)
        self.assertEqual(sum(' ownrules input ' in line for line in lines), 3)
        self.assertEqual(sum(' ownrules routed ' in line for line in lines), 2)
        self.assertNotIn(' open ', done.script)
        for line in lines:
            self.assertTrue(line.startswith('insert rule inet ownrules '), line)
            self.assertIn('"virbr-scx"', line)
            self.assertIn('comment "scx-desktop-', line)
        self.assertNotIn('dport 22', done.script)
        self.assertNotRegex(done.script, 'flush|policy|oifname "(?!virbr-scx)')
        self.assertIn('ct state established,related', lines[-1] + lines[-2])

    def test_tables_other_tools_own_are_left_alone(self):
        items = [
            self.chain(policy='drop', table=table)
            for table in ['scx_desktops', 'firewalld', 'libvirt_network']
        ] + [self.chain('INPUT', policy='drop', family='ip', table='filter')]
        self.assertEqual(self.firewall(['--check'], items).code, 0)
        self.assertEqual(self.firewall(items=items).script, '')
        own = self.chain('input', policy='drop', family='ip', table='filter')
        self.assertIn('insert rule ip filter input', self.firewall(items=[own]).script)

    def test_a_second_run_adds_nothing(self):
        rules = [
            self.rule(comment=comment)
            for comment in ['scx-desktop-dhcp', 'scx-desktop-dns-udp', 'scx-desktop-dns-tcp']
        ]
        done = self.firewall(items=[self.chain(policy='drop'), *rules])
        self.assertEqual(done.script, '')
        self.assertFalse([c for c in done.calls if c[:2] == ['nft', '-f']])

    def test_an_odd_chain_name_stops_before_anything_changes(self):
        done = self.firewall(items=[self.chain('in;flush ruleset', policy='drop')])
        self.assertIn('Unexpected chain name', done.code)
        self.assertEqual(done.script, '')

    def test_no_guard_means_no_rules(self):
        done = self.firewall(items=[self.chain(policy='drop')], guard=False)
        self.assertIn('network guard', done.code)
        self.assertEqual(done.script, '')

    def test_a_ruleset_that_cannot_be_read_is_never_read_as_no_firewall(self):
        for argv in [['--check'], []]:
            done = self.firewall(argv, unreadable=True)
            self.assertIn('No rules were changed', done.code)
            self.assertEqual(done.script, '')

    def test_remove_takes_only_our_rules_from_every_tool(self):
        items = [
            self.chain(policy='drop'),
            self.rule(handle=1, comment='scx-desktop-dhcp'),
            self.rule(handle=2, comment='scx-desktop-public-out', chain='forward'),
            self.rule(handle=3, comment='ssh'),
            self.rule(handle=4),
        ]
        done = self.firewall(['--remove'], items, ufw='ufw 0.36')
        self.assertEqual(
            done.script,
            'delete rule inet ownrules input handle 1\ndelete rule inet ownrules forward handle 2\n',
        )
        ufw = [c for c in done.calls if c[0] == 'ufw' and c[1] != 'version']
        self.assertEqual(len(ufw), 4)
        self.assertEqual(ufw[-1][:3], ['ufw', 'route', 'delete'])
        self.assertTrue(all(c[1] == 'delete' for c in ufw[:3]))
        self.assertTrue(all('virbr-scx' in c for c in ufw))
        self.assertEqual(len([c for c in done.calls if '-D' in c]), 5)

    def test_ufw_gets_rules_for_the_bridge_alone(self):
        self.assertEqual(self.firewall(['--check'], ufw='Status: active').code, 10)
        self.assertEqual(self.firewall(['--check'], ufw='Status: inactive').code, 0)
        done = self.firewall(ufw='Status: active', iptables='-P FORWARD DROP')
        rules = [c for c in done.calls if c[0] == 'ufw' and c[1] != 'status']
        self.assertEqual(len(rules), 4)
        self.assertTrue(all('virbr-scx' in c and 'in' in c for c in rules))
        self.assertEqual(rules[-1][:3], ['ufw', 'route', 'allow'])
        self.assertFalse([c for c in done.calls if '-I' in c], 'ufw owns iptables there')

    def test_firewalld_uses_the_libvirt_zone_or_a_zone_of_ours(self):
        self.assertEqual(self.firewall(['--check'], firewalld='running\n').code, 10)
        changed = lambda done: [c for c in done.calls if c[0] == 'firewall-cmd' and len(c) > 2]
        kept = self.firewall(firewalld='running\n', zones='public libvirt')
        self.assertFalse([c for c in changed(kept) if '--get-zones' not in c])
        made = self.firewall(firewalld='running\n', zones='public')
        zone = next(c[2] for c in changed(made) if c[2].startswith('--new-zone='))
        self.assertLessEqual(len(zone.split('=')[1]), 17, 'firewalld refuses a longer name')
        self.assertIn(['firewall-cmd', '--reload'], made.calls)
        self.assertTrue(any('--add-interface=virbr-scx' in c for c in made.calls))
        gone = self.firewall(['--remove'], firewalld='running\n', zones='public scx-desktops')
        self.assertIn(['firewall-cmd', '--permanent', '--delete-zone=scx-desktops'], gone.calls)

    def test_iptables_rules_are_seen_and_added_at_the_top(self):
        for rules in ['-P FORWARD DROP\n', '-P INPUT ACCEPT\n-A INPUT -p tcp -j REJECT\n']:
            self.assertEqual(self.firewall(['--check'], iptables=rules).code, 10, rules)
        self.assertEqual(self.firewall(['--check'], iptables='-P INPUT ACCEPT\n').code, 0)
        done = self.firewall(iptables='-P FORWARD DROP\n')
        added = [c for c in done.calls if '-I' in c]
        self.assertEqual(len(added), 5)
        for call in added:
            self.assertEqual(call[:2], ['iptables', '-w'])
            self.assertEqual(call[-2:], ['-j', 'ACCEPT'])
            self.assertTrue('-i' in call or '-o' in call)
            self.assertIn('virbr-scx', call)

    def test_the_watch_puts_back_what_a_reload_cleared(self):
        done = self.firewall(['--watch'], [self.chain(policy='drop')], rounds=1)
        self.assertEqual(len(done.script.splitlines()), 3)
        again = self.firewall(['--watch'], rounds=1, iptables='-P FORWARD DROP\n')
        self.assertEqual(len([c for c in again.calls if '-I' in c]), 5)

    def test_the_watch_brings_back_a_guard_that_a_flush_took(self):
        done = self.firewall(['--watch'], [self.chain(policy='drop')], rounds=1, guard='reloads')
        self.assertIn(
            ['systemctl', 'reload', 'stellarcortex-desktop-network-guard.service'], done.calls
        )
        self.assertEqual(len(done.script.splitlines()), 3)

    def test_the_watch_outlives_a_failure_and_reports_it_once(self):
        done = self.firewall(['--watch'], [self.chain(policy='drop')], rounds=3, guard='gone')
        self.assertEqual(done.code, 'end', 'only the stop ends it')
        self.assertEqual(done.printed.count('could not be put back'), 1)
        self.assertEqual(done.script, '')

    def test_the_watch_outlives_an_unexpected_error(self):
        done = self.firewall(['--watch'], rounds=2, unreadable='crash')
        self.assertEqual(done.code, 'end')
        self.assertEqual(done.printed.count('no fork'), 1)

    def test_the_watch_leaves_ufw_and_firewalld_to_keep_their_own_rules(self):
        for tool in [{'ufw': 'Status: active'}, {'firewalld': 'running\n'}]:
            done = self.firewall(['--watch'], rounds=2, **tool)
            self.assertFalse([c for c in done.calls if 'allow' in c or '--new-zone' in c[-1]])

    def test_a_zone_goes_even_when_firewalld_is_stopped(self):
        done = self.firewall(['--remove'], firewalld='not running\n')
        self.assertIn(['firewall-offline-cmd', '--delete-zone=scx-desktops'], done.calls)

    def test_stopping_the_unit_removes_the_rules_and_nothing_brings_them_back(self):
        unit = (ROOT / 'deployment/ubuntu-desktop/network-coexistence.service').read_text()
        self.assertIn('--watch', unit[unit.index('ExecStart=') :])
        self.assertRegex(unit, r'ExecStopPost=.*--remove')
        self.assertNotIn('ExecStop=', unit)
        self.assertNotIn('RemainAfterExit', unit)
        self.assertRegex(unit, r'ExecStartPre=\S+ -I -B \S+\n', 'a failed apply fails the start')
        name = 'stellarcortex-desktop-network-coexistence.service'
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            broker = (out / 'broker-coexistence.unit').read_text()
            lines = dict(line.split('=', 1) for line in broker.splitlines() if '=' in line)
            self.assertIn(name, lines['After'])
            self.assertNotIn(name, lines['Requires'])
            self.assertNotIn('Wants', lines)
        for file in ['boot.service', 'computer-start.service']:
            text = (ROOT / 'deployment/ubuntu-desktop' / file).read_text()
            self.assertNotRegex(text, r'(Requires|Wants)=.*coexistence')

    def test_the_guard_check_repairs_only_a_guard_that_went_missing(self):
        here = ROOT / 'deployment/ubuntu-desktop'
        unit = (here / 'network-guard-check.service').read_text()
        guard = 'stellarcortex-desktop-network-guard.service'
        self.assertEqual(
            re.findall(r'^ExecStart=(.*)$', unit, re.M), ['/usr/bin/systemctl reload ' + guard]
        )
        self.assertIn('ExecCondition=/usr/bin/systemctl is-active --quiet ' + guard, unit)
        self.assertNotIn('coexistence', unit)
        self.assertNotIn('[Install]', unit)
        condition = re.search(r"^ExecCondition=/bin/sh -c '(.*)'$", unit, re.M)[1]
        part = 'if ' + condition + '; then echo REPAIR; fi'
        with tempfile.TemporaryDirectory() as d:
            self.assertIn('REPAIR', self.shell(d, 'nft(){ return 1; }', part).stdout)
            self.assertNotIn('REPAIR', self.shell(d, 'nft(){ return 0; }', part).stdout)

    def test_the_guard_check_is_on_every_install_and_needs_no_firewall_answer(self):
        timer = 'stellarcortex-desktop-guard-check.timer'
        here = ROOT / 'deployment/ubuntu-desktop'
        text = (here / 'network-guard-check.timer').read_text()
        self.assertIn('WantedBy=timers.target', text)
        self.assertIn('OnCalendar=', text)
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            self.assertTrue((out / timer).is_file())
            self.assertTrue((out / timer.replace('.timer', '.service')).is_file())
            script = (out / 'install-approved.sh').read_text()
            line = f'systemctl enable {timer}\nsystemctl start {timer}\n'
            self.assertIn('./*.timer /etc/systemd/system/', script)
            self.assertGreater(script.index(line), script.index('systemctl daemon-reload'))
            block = script[script.index('if [ -n "$coexistence" ]') : script.index(line)]
            self.assertEqual(block.count('if [ -n'), block.count('\nfi\n'), 'outside the firewall')

    def test_an_upgrade_adds_the_guard_check_once_and_keeps_an_owners_disable(self):
        timer = 'stellarcortex-desktop-guard-check.timer'
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'upgrade-approved.sh').read_text()
            self.assertIn('./*.timer /etc/systemd/system/', text)
            part = text[text.index('guard_check=\n') : text.index('install -m 644 ./*.service')]
            installed = pathlib.Path(d) / timer
            part = part.replace('/etc/systemd/system/' + timer, installed.as_posix())
            part += '\necho "state=$guard_check"'
            self.assertIn('state=new', self.shell(d, '', part).stdout)
            installed.touch()
            self.assertIn('state=\n', self.shell(d, '', part).stdout)
            line = next(row for row in text.splitlines() if 'enable ' + timer in row)
            self.assertTrue(line.startswith('[ -z "$guard_check" ] ||'), line)
            self.assertLess(text.index(line), text.rindex('trap - ERR'))
            self.assertIn('|| echo', line)

    def test_nothing_that_starts_at_boot_brings_the_guard_check_or_the_rules_back(self):
        here = ROOT / 'deployment/ubuntu-desktop'
        for file in here.glob('*.service'):
            for row in file.read_text().splitlines():
                if row.startswith(('Requires=', 'Wants=', 'BindsTo=')):
                    self.assertNotIn('guard-check', row, file.name)
                    self.assertNotIn('coexistence', row, file.name)

    def test_a_firewall_problem_does_not_undo_an_update(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'upgrade-approved.sh').read_text()
            line = next(row for row in text.splitlines() if 'try-restart' in row)
            self.assertIn('coexistence.service || echo', line)
            self.assertLess(text.index(line), text.rindex('trap - ERR'))

    def test_the_guard_reloads_after_nftables_in_one_transaction(self):
        here = ROOT / 'deployment/ubuntu-desktop'
        unit = (here / 'network-guard.service').read_text()
        self.assertRegex(unit, r'After=.*nftables\.service')
        self.assertEqual(unit.count('ExecReload='), 1)
        self.assertIn('desktop-network-guard-reload.nft', unit)
        lines = [
            line
            for line in (here / 'network-guard-reload.nft').read_text().splitlines()
            if not line.startswith('#')
        ]
        self.assertEqual(lines[0], 'add table inet scx_desktops')
        self.assertEqual(lines[1], 'delete table inet scx_desktops')
        self.assertIn('/etc/stellarcortex/desktop-network-guard.nft', lines[2])
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            self.assertTrue((out / 'desktop-network-guard-reload.nft').is_file())
            for script in ['install-approved.sh', 'upgrade-approved.sh']:
                self.assertRegex(
                    (out / script).read_text(),
                    r'install -m 644 .*desktop-network-guard-reload\.nft /etc/stellarcortex/',
                )

    def test_the_fix_command_installs_and_starts_the_rules(self):
        done = self.firewall(['--install'])
        self.assertEqual(done.code, 0)
        self.assertEqual(len(done.copied), 2)
        unit = 'stellarcortex-desktop-network-coexistence.service'
        self.assertIn(['systemctl', 'enable', unit], done.calls)
        self.assertIn(['systemctl', 'restart', unit], done.calls)

    def test_rules_come_back_after_a_firewall_reload_and_go_on_stop(self):
        for name in ['network-coexistence.service', 'network-guard.service']:
            unit = (ROOT / 'deployment/ubuntu-desktop' / name).read_text()
            self.assertIn('ReloadPropagatedFrom=nftables.service', unit)
            self.assertNotIn('PartOf', unit, 'a start of nftables would not bring it back')
            self.assertIn('ExecReload=', unit)
            self.assertIn('WantedBy=multi-user.target', unit)
        unit = (ROOT / 'deployment/ubuntu-desktop/network-coexistence.service').read_text()
        self.assertIn('network-coexistence.py --remove', unit)
        self.assertNotIn('EnvironmentFile', unit)

    def watched(self, p, leases, seconds, statefile, mac='52:54:00:aa:bb:cc'):
        said = []

        def virsh(*args):
            said.append(args)
            return {
                'domstate': 'running',
                'domiflist': ' vnet0 network stellarcortex-desktops virtio ' + mac,
                'net-dhcp-leases': leases,
            }.get(args[0], '')

        with patch.object(installer, 'virsh', virsh), patch.object(
            installer, 'assert_identity'
        ), patch.object(installer.time, 'time', lambda: seconds):
            state = installer.advance(p, statefile)
        return state, said

    def test_a_computer_with_no_address_fails_plainly_instead_of_waiting(self):
        p = self.fixture()
        stale = '2026 52:54:00:00:00:01 ipv4 192.168.153.100/24 ubuntu'
        with tempfile.TemporaryDirectory() as d:
            file = pathlib.Path(d) / 'state.json'
            file.write_text(json.dumps({'stage': 'installing', 'planHash': installer.plan_hash(p)}))
            state, _ = self.watched(p, '', 1000, file)
            self.assertEqual(state['waitingSince'], 1000)
            self.assertEqual(json.loads(file.read_text())['waitingSince'], 1000)
            state, _ = self.watched(p, stale, 1000 + installer.LEASE_WAIT, file)
            self.assertEqual(state['stage'], 'installing', 'a lease of an old computer is no proof')
            with self.assertRaises(installer.BuildError) as stopped:
                self.watched(p, stale, 1001 + installer.LEASE_WAIT, file)
            self.assertEqual(installer.failure_code(stopped.exception), 'network')

    def test_a_computer_that_got_an_address_is_left_to_install(self):
        p = self.fixture()
        lease = '2026 52:54:00:aa:bb:cc ipv4 192.168.153.100/24 ubuntu'
        with tempfile.TemporaryDirectory() as d:
            file = pathlib.Path(d) / 'state.json'
            file.write_text(
                json.dumps(
                    {'stage': 'installing', 'planHash': installer.plan_hash(p), 'waitingSince': 1}
                )
            )
            self.assertTrue(self.watched(p, lease, 2, file)[0]['leased'])
            state, said = self.watched(p, '', 10**9, file)
            self.assertEqual(state['stage'], 'installing')
            self.assertEqual([args[0] for args in said], ['domstate'])

    def test_host_bundle_pins_source_snapshot_and_has_no_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'source'
            source.mkdir()
            for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
                (source / name).mkdir(parents=True)
                (source / name / 'fixture.txt').write_text('code')
            iso = pathlib.Path(directory) / 'any name.iso'
            iso.write_bytes(b'image')
            with self.assertRaisesRegex(ValueError, 'package.json'):
                host.render(
                    source,
                    pathlib.Path(directory) / 'none',
                    4242,
                    'a' * 64,
                    'stellarcortex.service',
                    '/srv/app/data',
                    iso,
                )
            for name in ['package.json', 'package-lock.json']:
                (source / name).write_text('{}')
            with self.assertRaisesRegex(ValueError, '--iso'):
                host.render(
                    source,
                    pathlib.Path(directory) / 'none',
                    4242,
                    'a' * 64,
                    'stellarcortex.service',
                    '/srv/app/data',
                    pathlib.Path(directory) / 'missing.iso',
                )
            out = pathlib.Path(directory) / 'bundle'
            manifest, h = host.render(
                source, out, 4242, 'a' * 64, 'stellarcortex.service', '/srv/app/data', iso
            )
            script = (out / 'install-approved.sh').read_text()
            self.assertIn('runtime.tar.gz', manifest['files'])
            self.assertIn(h, script)
            self.assertNotIn('enable --now', script)
            self.assertNotIn('usermod', script)
            self.assertIn('Existing firewall detected', script)
            policy = json.loads((out / 'desktop-broker.json').read_text())['provisioningPolicy']
            self.assertEqual(
                (policy['accountId'], policy['isoSha256'], policy['payloadSha256']),
                ('a' * 64, host.digest(iso), host.digest(out / 'runtime.tar.gz')),
            )
            self.assertIs(policy['approved'], True)
            self.assertIs(policy['disableGuestIdleLock'], True)
            self.assertEqual(manifest['iso']['sha256'], host.digest(iso))
            with tarfile.open(out / 'runtime.tar.gz') as archive:
                self.assertLessEqual(
                    {'package.json', 'package-lock.json'},
                    set(archive.getnames()),
                    'the guest runs npm ci from the payload',
                )
            self.assertEqual(
                installer.validate(
                    installer.create_plan(
                        'a' * 64,
                        'bot',
                        policy['vmIds'][0],
                        str(iso),
                        str(out / 'runtime.tar.gz'),
                        policy['isoSha256'],
                    )
                )['isoSha256'],
                host.digest(iso),
            )
            self.assertNotIn('not enabled', manifest['bootPolicy'])
            self.assertIn('Settings > Computer', manifest['bootPolicy'])
            for text in [script, (out / 'upgrade-approved.sh').read_text()]:
                for token in ['HASH', 'ISOSHA', 'ISOFILE', 'MEDIA', 'APP_SERVICE']:
                    self.assertNotIn(token, text)
                self.assertIn(policy['iso'], text)
                self.assertIn(policy['payload'], text)
                self.assertIn(h, text)

    def test_an_upgrade_runs_on_an_existing_host_and_keeps_what_the_owner_set(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'source'
            source.mkdir()
            for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
                (source / name).mkdir(parents=True)
                (source / name / 'fixture.txt').write_text('code')
            for name in ['package.json', 'package-lock.json']:
                (source / name).write_text('{}')
            iso = pathlib.Path(directory) / 'image.iso'
            iso.write_bytes(b'image')
            out = pathlib.Path(directory) / 'bundle'
            host.render(source, out, 4242, 'a' * 64, 'stellarcortex.service', '/srv/app/data', iso)
            text = (out / 'upgrade-approved.sh').read_text()
            self.assertNotIn('Existing deployment', text)
            self.assertIn('backups', text)
            self.assertIn('merge-config', text)
            self.assertIn('A computer is being prepared', text)
            self.assertNotIn('net-define', text)
            self.assertNotIn('start stellarcortex-desktop-network-guard', text)
            self.assertNotIn('apt-get', text)
            self.assertIn(
                'stellarcortex-desktop-network-coexistence.service stellarcortex-desktop-boot.service',
                (out / 'broker-coexistence.unit').read_text(),
            )
            self.assertIn('run upgrade-approved.sh', (out / 'install-approved.sh').read_text())
            live = pathlib.Path(directory) / 'etc'
            live.mkdir()
            row = {'accountId': 'a' * 64, 'botId': 'bot'}
            (live / 'desktop-broker.json').write_text(
                json.dumps(
                    {
                        'appUid': 4242,
                        'bootApproved': True,
                        'desktops': [row],
                        'sessionProvisioning': {'approved': True},
                        'allocationResults': {'bot': {'state': 'needs-attention'}},
                    }
                )
            )
            (live / 'desktop-provider.json').write_text(
                json.dumps(
                    {
                        'records': [row],
                        'environmentComputer': {'computerId': 'c'},
                        'dataDir': '/old',
                    }
                )
            )
            self.assertIn(
                '[ ! -e /etc/stellarcortex/desktop-isolation.json ] || cp -a',
                text,
                'a host from before the pins has no such file',
            )
            self.assertNotIn('install -m 644 desktop-isolation.json', text)
            host.merge_files(out, live)
            self.assertEqual(
                json.loads((live / 'desktop-isolation.json').read_text()),
                json.loads((out / 'desktop-isolation.json').read_text()),
            )
            (live / 'desktop-isolation.json').write_text(
                json.dumps(
                    {
                        'version': 1,
                        'providers': {
                            'custom-lab': {'enabled': True},
                            'local': {'enabled': False},
                            'claude': {'enabled': True, 'executable': '/old', 'sha256': 'b' * 64},
                        },
                    }
                )
            )
            new = {
                'version': 1,
                'providers': {
                    'local': {'enabled': True},
                    'claude': {'enabled': True, 'executable': '/new', 'sha256': 'c' * 64},
                },
            }
            (out / 'desktop-isolation.json').write_text(json.dumps(new))
            host.merge_files(out, live)
            self.assertEqual(
                json.loads((live / 'desktop-isolation.json').read_text())['providers'],
                {
                    'custom-lab': {'enabled': True},
                    'local': {'enabled': False},
                    'claude': new['providers']['claude'],
                },
            )
            b, v = json.loads((live / 'desktop-broker.json').read_text()), json.loads(
                (live / 'desktop-provider.json').read_text()
            )
            self.assertEqual(
                (
                    b['bootApproved'],
                    b['desktops'],
                    b['sessionProvisioning'],
                    b['provisioningPolicy']['accountId'],
                    b['allocationResults'],
                ),
                (True, [row], {'approved': True}, 'a' * 64, {}),
            )
            self.assertEqual(
                (v['records'], v['environmentComputer'], v['dataDir']),
                ([row], {'computerId': 'c'}, '/srv/app/data'),
            )
            new = json.loads((out / 'desktop-broker.json').read_text()), json.loads(
                (out / 'desktop-provider.json').read_text()
            )
            with self.assertRaisesRegex(ValueError, '--app-uid'):
                host.merge_config({'appUid': 5}, {}, *new)
            with self.assertRaisesRegex(ValueError, '--account-id'):
                host.merge_config({'appUid': 4242, 'desktops': [{'accountId': 'other'}]}, {}, *new)

    def test_a_failed_first_boot_stops_the_loop_with_the_step_that_failed(self):
        p = self.fixture()
        reply = lambda value: {
            'exited': True,
            'exitcode': 0,
            'out-data': base64.b64encode(json.dumps(value).encode()).decode(),
        }
        with patch.object(installer, 'qga', return_value=reply({'firstbootFailed': 'npm ci\n'})):
            with self.assertRaisesRegex(RuntimeError, 'first boot, at: npm ci$'):
                installer.publish_result(p, 1)
        with patch.object(installer, 'qga', return_value=reply({})):
            self.assertFalse(installer.publish_result(p, 1))
        self.assertIn(
            'stellarcortex-firstboot-failed',
            (ROOT / 'deployment/ubuntu-desktop/guest/firstboot.sh').read_text(),
        )
        with patch.object(installer, 'assert_identity'), patch.object(
            installer, 'virsh', return_value=json.dumps({'return': {'pid': 7}})
        ) as call:
            installer.publish(p)
        self.assertIn('firstboot-status.py', call.call_args[0][-1])

    def test_a_payload_without_the_package_files_stops_before_any_change(self):
        with tempfile.TemporaryDirectory() as d:
            payload = pathlib.Path(d) / 'payload.tar.gz'
            with tarfile.open(payload, 'w:gz') as archive:
                source = pathlib.Path(d) / 'code.txt'
                source.write_text('x')
                archive.add(source, arcname='src/code.txt')
            p = self.fixture()
            p.update(
                payload=str(payload),
                payloadSha256=installer.digest(payload),
                iso=str(payload),
                isoSha256=installer.digest(payload),
            )
            rows = json.dumps({'desktops': [], 'records': []})
            net = '<network><bridge name="virbr-scx"/><forward mode="nat"/><ip address="192.168.153.1"/></network>'

            def virsh(*args):
                return net if args[0] == 'net-dumpxml' else ''

            usage = type('U', (), {'free': 200 * 1024**3})()
            meminfo = 'MemAvailable: 99999999 kB\n'
            real = pathlib.Path.read_text

            def read(self, *a, **k):
                return (
                    rows
                    if str(self).endswith(('desktop-broker.json', 'desktop-provider.json'))
                    else meminfo if self.name == 'meminfo' else real(self, *a, **k)
                )

            exists = pathlib.Path.exists
            with patch.object(
                installer.shutil, 'which', return_value='/usr/bin/tool'
            ), patch.object(installer.shutil, 'disk_usage', return_value=usage), patch.object(
                installer, 'virsh', virsh
            ), patch.object(
                installer, 'run', return_value='virbr-scx'
            ), patch.object(
                pathlib.Path, 'read_text', read
            ), patch.object(
                pathlib.Path,
                'exists',
                lambda self: True if str(self).endswith('kvm') else exists(self),
            ):
                with self.assertRaisesRegex(RuntimeError, 'package-lock.json'):
                    installer.preflight(p)

    def test_the_owner_identity_comes_from_the_app_access_key(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, '--account-id'):
                host.account_id(d)
            (pathlib.Path(d) / 'access-key').write_text('key\n')
            self.assertEqual(
                host.account_id(d), hashlib.sha256(b'android-owner-v1:key').hexdigest()
            )
            # A new access key must not move the owner off the computers registered to the old one.
            (pathlib.Path(d) / 'owner-account').write_text('saved\n')
            self.assertEqual(host.account_id(d), 'saved')

    def test_the_app_user_cannot_be_the_source_of_what_root_runs(self):
        with tempfile.TemporaryDirectory() as d:
            source = pathlib.Path(d)
            (source / 'src').mkdir()
            (source / 'src' / 'planted.mjs').write_text('x')
            (source / 'scripts').mkdir()
            (source / 'deployment/ubuntu-desktop').mkdir(parents=True)
            safe = lambda path: types.SimpleNamespace(st_uid=0, st_mode=0o100644)
            with self.assertRaisesRegex(ValueError, 'root-owned clone'):
                host.check_source(
                    source,
                    4242,
                    read=lambda path: types.SimpleNamespace(
                        st_uid=4242 if path.name == 'planted.mjs' else 0, st_mode=0o100644
                    ),
                )
            host.check_source(source, 4242, read=safe)
            for name in ['package.json', 'package-lock.json', '.npmrc']:
                with self.subTest(name=name):
                    (source / name).write_text('{}')
                    with self.assertRaisesRegex(ValueError, name):
                        host.check_source(
                            source,
                            4242,
                            read=lambda path: types.SimpleNamespace(
                                st_uid=4242 if path.name == name else 0, st_mode=0o100644
                            ),
                        )
            for mode in [0o100664, 0o100646, 0o040777]:
                with self.subTest(mode=oct(mode)), self.assertRaisesRegex(
                    ValueError, 'planted.mjs'
                ):
                    host.check_source(
                        source,
                        4242,
                        read=lambda path: types.SimpleNamespace(
                            st_uid=0, st_mode=mode if path.name == 'planted.mjs' else 0o100644
                        ),
                    )
            host.check_source(
                source,
                4242,
                read=lambda path: types.SimpleNamespace(
                    st_uid=0, st_mode=0o120777 if path.name == 'planted.mjs' else 0o100644
                ),
            )
            calls = []
            with patch.object(
                host, 'check_source', side_effect=ValueError('root-owned clone')
            ), self.assertRaisesRegex(ValueError, 'root-owned clone'):
                host.prepare_runners(source, 4242, lambda *a, **o: calls.append(a))
            self.assertEqual(calls, [], 'nothing from the clone runs before it is checked')

    def test_claude_and_codex_are_pinned_by_the_bundle_with_no_hand_edit(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d)
            source = base / 'source'
            source.mkdir()
            for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
                (source / name).mkdir(parents=True)
                (source / name / 'fixture.txt').write_text('code')
            for name in ['package.json', 'package-lock.json']:
                (source / name).write_text('{}')
            claude = base / 'claude'
            claude.write_bytes(b'claude')
            codex = base / 'triple'
            (codex / 'bin').mkdir(parents=True)
            (codex / 'bin' / 'codex').write_bytes(b'codex')
            (codex / 'helper').write_bytes(b'helper')
            iso = base / 'image.iso'
            iso.write_bytes(b'image')
            out = base / 'bundle'
            host.render(
                source,
                out,
                4242,
                'a' * 64,
                'stellarcortex.service',
                '/srv/app/data',
                iso,
                {'claude': claude, 'codex': codex, 'policySha256': 'c' * 64},
            )
            providers = json.loads((out / 'desktop-isolation.json').read_text())['providers']
            self.assertEqual(
                providers['claude'],
                {
                    'enabled': True,
                    'executable': host.RUNNERS + '/claude',
                    'sha256': hashlib.sha256(b'claude').hexdigest(),
                },
            )
            self.assertEqual(
                providers['codex'],
                {
                    'enabled': True,
                    'executable': host.RUNNERS + '/codex/bin/codex',
                    'sha256': hashlib.sha256(b'codex').hexdigest(),
                    'policySha256': 'c' * 64,
                },
            )
            self.assertTrue(providers['local']['enabled'])
            with tarfile.open(out / 'runners.tar.gz') as archive:
                self.assertLessEqual(
                    {'claude', 'codex/bin/codex', 'codex/helper'}, set(archive.getnames())
                )
            self.assertNotIn(
                'CLAUDE_BIN',
                (out / 'app-desktop-order.conf').read_text(),
                'the app reads the pin from desktop-isolation.json',
            )
            self.assertIn(
                'install -m 644 desktop-isolation.json /etc/stellarcortex/',
                (out / 'install-approved.sh').read_text(),
            )
            for name in ['install-approved.sh', 'upgrade-approved.sh']:
                text = (out / name).read_text()
                self.assertIn('chown -R root:root ' + host.RUNNERS + '.next', text)
                self.assertIn(' systemctl restart stellarcortex.service', text)
                self.assertIn(
                    '/etc/systemd/system/stellarcortex.service.d/80-desktop-order.conf', text
                )

    def test_a_user_service_gets_no_system_unit_and_the_right_restart(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d)
            source = base / 'source'
            source.mkdir()
            for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
                (source / name).mkdir(parents=True)
                (source / name / 'fixture.txt').write_text('code')
            for name in ['package.json', 'package-lock.json']:
                (source / name).write_text('{}')
            iso = base / 'image.iso'
            iso.write_bytes(b'image')
            out = base / 'bundle'
            manifest, h = host.render(
                source,
                out,
                4242,
                'a' * 64,
                'stellarcortex.service',
                '/srv/app/data',
                iso,
                user_service=True,
            )
            self.assertFalse((out / 'app-desktop-order.conf').exists())
            self.assertNotIn('app-desktop-order.conf', manifest['files'])
            for name in ['install-approved.sh', 'upgrade-approved.sh']:
                text = (out / name).read_text()
                self.assertNotIn('stellarcortex.service.d', text)
                self.assertIn(
                    'As the app user: systemctl --user restart stellarcortex.service', text
                )
            text = (out / 'install-approved.sh').read_text()
            self.assertLess(
                text.index('install -m 600 desktop-broker.json'),
                text.index('systemctl start stellarcortex-desktop-broker.service'),
                'nothing else starts the broker before the next reboot',
            )

    def test_render_finds_a_user_or_a_system_service_and_its_data_folder(self):
        with tempfile.TemporaryDirectory() as d:
            home = lambda uid: d
            units = pathlib.Path(d) / '.config/systemd/user'
            missing = lambda *a, **o: 'LoadState=not-found\n'
            with self.assertRaisesRegex(ValueError, 'bash install.sh --service'):
                host.app_service_settings('stellarcortex.service', 4242, missing, home)
            system = 'LoadState=loaded\nEnvironment=A=1 STELLARCORTEX_DATA_DIR=/srv/system\n'
            self.assertEqual(
                host.app_service_settings(
                    'stellarcortex.service', 4242, lambda *a, **o: system, home
                ),
                (False, system),
            )
            self.assertEqual(host.app_data_dir(system, 4242, home), '/srv/system')
            units.mkdir(parents=True)
            (units / 'stellarcortex.service').write_text(
                '[Service]\nExecStart=/usr/bin/node /srv/app/src/server.mjs\n'
            )
            user, shown = host.app_service_settings('stellarcortex.service', 4242, missing, home)
            self.assertTrue(user)
            self.assertEqual(host.app_data_dir(shown, 4242, home), d + '/.stellarcortex')
            (units / 'stellarcortex.service.d').mkdir()
            (units / 'stellarcortex.service.d/override.conf').write_text(
                '[Service]\nEnvironment="STELLARCORTEX_DATA_DIR=/your/path"\n'
            )
            self.assertEqual(
                host.app_data_dir(
                    host.app_service_settings('stellarcortex.service', 4242, missing, home)[1],
                    4242,
                    home,
                ),
                '/your/path',
            )
            (units / 'stellarcortex.service.d/override.conf').write_text(
                '[Service]\nEnvironmentFile=-/etc/app.env\n'
            )
            self.assertEqual(
                host.app_data_dir(
                    host.app_service_settings('stellarcortex.service', 4242, missing, home)[1],
                    4242,
                    home,
                    lambda name: 'STELLARCORTEX_DATA_DIR=/from/file\n',
                ),
                '/from/file',
            )

    def test_runners_come_from_a_clean_install_for_this_machine(self):
        with tempfile.TemporaryDirectory() as d:
            source = pathlib.Path(d)
            calls = []

            def run(args, **options):
                calls.append((args, options['cwd']))
                self.assertIn(
                    '/usr/local/bin', options['env']['PATH'], 'npm starts node from the same place'
                )

            found_on = lambda name, path: (
                '/usr/local/bin/' + name if '/usr/local/bin' in path else None
            )
            prepare = lambda run=run, machine='x86_64', libc='glibc', which=found_on: host.prepare_runners(
                source, 4242, run, machine, libc, which
            )
            with self.assertRaisesRegex(ValueError, 'did not install .*claude-code-linux-x64'):
                prepare()
            self.assertEqual(
                calls[0],
                (
                    ['/usr/local/bin/npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                    source,
                ),
            )
            # npm installs all of these on Linux, because the lockfile does not tell glibc from musl.
            files = {}
            for key, folder in {
                'x64': 'x64',
                'x64-musl': 'x64-musl',
                'arm64': 'arm64',
                'arm64-musl': 'arm64-musl',
            }.items():
                files[key] = (
                    source
                    / 'node_modules/@anthropic-ai'
                    / ('claude-code-linux-' + folder)
                    / 'claude'
                )
                files[key].parent.mkdir(parents=True)
                files[key].write_text('x')
            with self.assertRaisesRegex(ValueError, 'Expected one codex'):
                prepare()
            codex = (
                source
                / 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
            )
            codex.parent.mkdir(parents=True)
            codex.write_text('x')
            arm = (
                source
                / 'node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex'
            )
            arm.parent.mkdir(parents=True)
            arm.write_text('x')
            with patch.object(host, 'codex_policy', return_value='c' * 64):
                found = prepare()
                self.assertEqual(
                    (found['claude'], found['codex'], found['policySha256']),
                    (files['x64'], codex.parents[1], 'c' * 64),
                )
                self.assertEqual(prepare(libc='')['claude'], files['x64-musl'])
                found = prepare(machine='aarch64')
                self.assertEqual(
                    (found['claude'], found['codex']), (files['arm64'], arm.parents[1])
                )
                self.assertEqual(prepare(machine='aarch64', libc='')['claude'], files['arm64-musl'])
                with self.assertRaisesRegex(
                    ValueError, 'no Claude or Codex program for this machine: riscv64'
                ):
                    prepare(machine='riscv64')
            for gone in ['npm', 'node']:
                with self.subTest(gone=gone), self.assertRaisesRegex(
                    ValueError, 'not found in PATH or /usr/local/bin'
                ):
                    prepare(which=lambda name, path: None if name == gone else '/usr/bin/' + name)

    def test_the_broker_finds_node_where_the_host_has_it(self):
        self.assertIn(
            'process.lock node /opt/',
            (ROOT / 'deployment/ubuntu-desktop/broker.service').read_text(),
        )
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'install-approved.sh').read_text()
            self.assertLess(text.index('PATH=$PATH:/usr/local/bin'), text.index('command -v node'))

    def shell(self, directory, stub, part, *args):
        '''Runs one part of a rendered script in real bash under its strict mode, with stubs for the host tools.'''
        file = pathlib.Path(directory) / 'part.sh'
        file.write_bytes(('set -euo pipefail\n' + stub + '\n' + part + '\necho PASSED\n').encode())
        return subprocess.run(
            [shutil.which('bash'), file.as_posix(), *args],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_a_render_with_no_iso_leaves_the_download_to_the_build(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d)
            source = base / 'source'
            source.mkdir()
            for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
                (source / name).mkdir(parents=True)
                (source / name / 'fixture.txt').write_text('code')
            for name in ['package.json', 'package-lock.json']:
                (source / name).write_text('{}')
            out = base / 'bundle'
            host.render(source, out, 4242, 'a' * 64, 'stellarcortex.service', '/srv/app/data', None)
            text = (out / 'install-approved.sh').read_text()
            policy = json.loads((out / 'desktop-broker.json').read_text())['provisioningPolicy']
            self.assertIsNone(policy['isoSha256'])
            self.assertNotIn('sha256sum', text)
            self.assertNotIn('ISOFILE', text)
            self.assertIn('install -m 600 runtime.tar.gz', text)
            self.assertLess(
                text.index('install -m 600 desktop-broker.json'),
                text.index('systemctl start --no-block stellarcortex-computer-build@start.service'),
                'the build reads that file',
            )
            self.assertTrue((out / 'stellarcortex-computer-build@.service').is_file())
            self.assertTrue((out / 'stellarcortex-session-remove@.service').is_file())
            self.assertFalse((out / 'stellarcortex-provision@.service').exists())
            self.assertIn('AF_INET', (out / 'stellarcortex-computer-build@.service').read_text())
            self.assertNotIn(
                'AF_INET', (out / 'stellarcortex-session-provision@.service').read_text()
            )

    def test_only_the_signed_list_decides_which_iso_is_good(self):
        good = hashlib.sha256(b'iso').hexdigest()
        sums = (
            good
            + ' *ubuntu-26.04.1-live-server-amd64.iso\n'
            + 'b' * 64
            + ' *ubuntu-26.04.1-desktop-amd64.iso\n'
        )
        with tempfile.TemporaryDirectory() as d:
            work = pathlib.Path(d)

            def fetch(url, target):
                target.write_text(sums)

            def gpg(status):
                return lambda args, **o: types.SimpleNamespace(
                    stdout=status if '--verify' in args else ''
                )

            signed = (
                '[GNUPG:] VALIDSIG AAAA 2026-08-06 1 0 4 0 1 10 00 ' + installer.UBUNTU_KEY + '\n'
            )
            self.assertEqual(
                installer.signed_iso(work, fetch, gpg(signed)),
                (good, 'ubuntu-26.04.1-live-server-amd64.iso'),
            )
            for status in [
                '',
                '[GNUPG:] VALIDSIG AAAA 2026-08-06 1 0 4 0 1 10 00 ' + 'C' * 40 + '\n',
                '[GNUPG:] GOODSIG ' + installer.UBUNTU_KEY + '\n',
            ]:
                with self.subTest(status=status), self.assertRaises(installer.BuildError) as raised:
                    installer.signed_iso(work, fetch, gpg(status))
                self.assertEqual(raised.exception.code, 'signature')

    def test_the_iso_is_downloaded_only_when_missing_and_must_match_the_list(self):
        good = hashlib.sha256(b'iso').hexdigest()
        with tempfile.TemporaryDirectory() as d:
            media = pathlib.Path(d)
            target = media / 'server.iso'
            policy = {'iso': str(target)}
            got = []
            said = []

            def fetch(content):
                def write(url, part, progress):
                    got.append(url)
                    part.write_bytes(content)
                    progress(50, 100)

                return write

            installer.ensure_iso(
                policy,
                lambda work: (good, 'name.iso'),
                fetch(b'iso'),
                lambda stage, **v: said.append(v),
            )
            self.assertEqual(target.read_bytes(), b'iso')
            self.assertTrue(got[0].endswith('name.iso'))
            self.assertEqual(said, [{'percent': 50}])
            installer.ensure_iso(
                policy, lambda work: (good, 'name.iso'), fetch(b'iso'), lambda stage, **v: None
            )
            self.assertEqual(len(got), 1, 'a good copy stays')
            target.unlink()
            with self.assertRaises(installer.BuildError) as raised:
                installer.ensure_iso(
                    policy,
                    lambda work: (good, 'name.iso'),
                    fetch(b'other'),
                    lambda stage, **v: None,
                )
            self.assertEqual(raised.exception.code, 'download')
            self.assertFalse(target.exists())
            self.assertFalse((media / 'download/name.iso').exists())

            def offline(work):
                raise installer.urllib.error.URLError('no route')

            with self.assertRaises(installer.BuildError) as raised:
                installer.ensure_iso(policy, offline)
            self.assertEqual(raised.exception.code, 'download')
            installer.ensure_iso(
                {'iso': str(target), 'isoSha256': 'a' * 64},
                lambda work: self.fail('an owner ISO needs no download'),
            )

    def test_a_download_goes_on_from_where_it_stopped(self):
        class Response(io.BytesIO):
            status = 206
            headers = {'Content-Length': '3'}

        with tempfile.TemporaryDirectory() as d:
            part = pathlib.Path(d) / 'file'
            part.write_bytes(b'abc')
            asked = []

            def opener(request, timeout):
                asked.append(request.headers)
                return Response(b'def')

            seen = []
            installer.download(
                'https://example.com/x',
                part,
                lambda done, total: seen.append((done, total)),
                opener,
            )
            self.assertEqual(part.read_bytes(), b'abcdef')
            self.assertEqual(asked[0]['Range'], 'bytes=3-')
            self.assertEqual(seen, [(6, 6)])

    def building(self, directory, cfg, drive=lambda p, file, say: {'stage': 'ready'}):
        root = pathlib.Path(directory)
        (root / 'provisioning').mkdir(exist_ok=True)
        config = root / 'broker.json'
        config.write_text(json.dumps(cfg))
        said = []
        return (
            root,
            config,
            said,
            [
                patch.object(installer, 'ROOT', root),
                patch.object(installer, 'BROKER', str(config)),
                patch.object(installer, 'trusted_config', lambda: config),
                patch.object(installer, 'report', lambda stage, **v: said.append((stage, v))),
                patch.object(installer, 'ensure_iso', lambda policy: None),
                patch.object(installer, 'drive', drive),
                patch.object(installer.os, 'geteuid', lambda: 0, create=True),
                patch.object(installer.os, 'umask', lambda mask: 0),
            ],
        )

    def policy(self, iso, payload):
        return {
            'approved': True,
            'accountId': 'a' * 64,
            'vmIds': ['02'],
            'iso': str(iso),
            'isoSha256': 'a' * 64,
            'payload': str(payload),
            'payloadSha256': installer.digest(payload),
            'disableGuestIdleLock': True,
        }

    def test_the_build_needs_no_bot_and_reports_each_stage(self):
        with tempfile.TemporaryDirectory() as d:
            payload = pathlib.Path(d) / 'payload'
            payload.write_bytes(b'p')
            iso = pathlib.Path(d) / 'iso'
            iso.write_bytes(b'i')
            root, config, said, patches = self.building(
                d, {'desktops': [], 'provisioningPolicy': self.policy(iso, payload)}
            )
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                installer.build('start')
            row = json.loads(config.read_text())['provisioningAllocations'][0]
            self.assertEqual(row['botId'], installer.ENVIRONMENT_BOT)
            self.assertEqual([stage for stage, _ in said], ['download', 'prepare', 'ready'])

    def test_a_failed_build_says_why_and_retry_clears_it_first(self):
        with tempfile.TemporaryDirectory() as d:
            payload = pathlib.Path(d) / 'payload'
            payload.write_bytes(b'p')
            iso = pathlib.Path(d) / 'iso'
            iso.write_bytes(b'i')

            def stop(p, file, say):
                raise RuntimeError(
                    'The computer needs 8192 MiB and the host keeps 6144 MiB, but only 100 MiB is available.'
                )

            root, config, said, patches = self.building(
                d, {'desktops': [], 'provisioningPolicy': self.policy(iso, payload)}, stop
            )
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                with self.assertRaises(RuntimeError):
                    installer.build('start')
                self.assertEqual(said[-1][0], 'failed')
                self.assertEqual(said[-1][1]['code'], 'memory')
                removed = []

                def remove(vm, name):
                    removed.append((vm, name))
                    cfg = json.loads(config.read_text())
                    cfg['provisioningAllocations'] = []
                    config.write_text(json.dumps(cfg))
                    (root / 'provisioning' / (vm + '.plan.json')).unlink()

                with patch.object(installer, 'remove_computer', remove), self.assertRaises(
                    RuntimeError
                ):
                    installer.build('retry')
                self.assertEqual(removed, [('02', 'scx-desktop-02')])

    def test_retry_clears_only_the_failed_environment_plan(self):
        with tempfile.TemporaryDirectory() as d:
            payload = pathlib.Path(d) / 'payload'
            payload.write_bytes(b'p')
            iso = pathlib.Path(d) / 'iso'
            iso.write_bytes(b'i')
            root, config, said, patches = self.building(
                d,
                {
                    'desktops': [],
                    'provisioningPolicy': self.policy(iso, payload),
                    'provisioningAllocations': [
                        {'vmId': '03', 'botId': 'someone', 'accountId': 'b' * 64}
                    ],
                },
            )
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                with patch.object(
                    installer,
                    'remove_computer',
                    lambda *a: self.fail('this computer is not the failed try'),
                ):
                    installer.build('retry')

    def test_retry_after_a_first_boot_failure_goes_on_with_the_same_computer(self):
        with tempfile.TemporaryDirectory() as d:
            payload = pathlib.Path(d) / 'payload'
            payload.write_bytes(b'p')
            iso = pathlib.Path(d) / 'iso'
            iso.write_bytes(b'i')
            seen = []
            root, config, said, patches = self.building(
                d,
                {'desktops': [], 'provisioningPolicy': self.policy(iso, payload)},
                lambda p, file, say: seen.append(
                    json.loads(file.read_text()) if file.exists() else None
                )
                or {'stage': 'ready'},
            )
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                installer.build('start')
                (root / 'provisioning' / '02.state.json').write_text(
                    json.dumps({'stage': 'needs-attention', 'resume': True, 'planHash': 'h'})
                )
                with patch.object(
                    installer, 'remove_computer', lambda *a: self.fail('its install is good')
                ), patch.object(
                    installer, 'ensure_iso', lambda policy: self.fail('it needs no ISO')
                ):
                    installer.build('retry')
            self.assertEqual(seen[-1], {'stage': 'resuming', 'planHash': 'h'})

    def test_a_finished_computer_is_never_built_or_cleared_again(self):
        with tempfile.TemporaryDirectory() as d:
            root, config, said, patches = self.building(
                d,
                {
                    'desktops': [],
                    'sessionProvisioning': {'approved': True},
                    'provisioningAllocations': [{'vmId': '02'}],
                },
            )
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                with patch.object(
                    installer, 'remove_computer', lambda *a: self.fail('a ready computer stays')
                ):
                    installer.build('retry')
            self.assertEqual(said, [('ready', {})])

    def test_install_time_disk_cache_does_not_outlive_the_install(self):
        p = self.fixture()
        xml = "<domain><os><boot dev='cdrom'/></os><devices><disk device='disk'><driver name='qemu' cache='unsafe'/></disk><disk device='cdrom'><source file='x'/></disk></devices></domain>"
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / installer.domain(p)).mkdir()

            def virsh(*args):
                return {'domstate': 'shut off', 'dumpxml': xml}.get(args[0], '')

            with patch.object(installer, 'ROOT', root), patch.object(
                installer, 'assert_identity'
            ), patch.object(installer, 'virsh', virsh):
                self.assertTrue(installer.finish_install(p))
            self.assertNotIn('unsafe', (root / installer.domain(p) / 'installed.xml').read_text())

    def test_the_install_stops_at_a_firewall_nobody_said_yes_to(self):
        check = (
            lambda code: "nft(){ :; }; python3(){ echo 'nftables table own'; return %d; }" % code
        )
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'install-approved.sh').read_text()
            part = text[text.index('firewall=\n') : text.index('apt-get update')]
            stopped = self.shell(d, check(10), part, 'hash')
            self.assertEqual(stopped.returncode, 1)
            self.assertIn('Existing firewall detected (nftables table own)', stopped.stdout)
            self.assertNotIn('PASSED', stopped.stdout)
            self.assertIn(
                'PASSED', self.shell(d, check(10), part, 'hash', '--firewall-reviewed').stdout
            )
            self.assertIn('PASSED', self.shell(d, check(0), part, 'hash').stdout)
            unknown = self.shell(d, check(1), part, 'hash')
            self.assertEqual(
                unknown.returncode, 6, 'an unreadable ruleset is no proof of no firewall'
            )
            self.assertNotIn('PASSED', unknown.stdout)

    def test_an_upgrade_sees_a_computer_being_prepared(self):
        busy = "systemctl(){ printf 'stellarcortex-computer-build@start.service loaded active running\\n';printf '%0300000d\\n' 0; }"
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'upgrade-approved.sh').read_text()
            start = text.rindex('\n', 0, text.index('systemctl list-units')) + 1
            part = text[start : text.index('live=/opt/stellarcortex-desktop-broker')]
            stopped = self.shell(d, busy, part)
            self.assertIn('A computer is being prepared', stopped.stdout)
            self.assertNotIn('PASSED', stopped.stdout)
            self.assertIn('PASSED', self.shell(d, 'systemctl(){ :; }', part).stdout)
            self.assertNotIn('PASSED', self.shell(d, 'systemctl(){ return 1; }', part).stdout)

    def test_an_install_that_stopped_partway_can_run_again(self):
        ours = "<network>\\n  <forward mode='nat'>\\n  </forward>\\n  <bridge name='virbr-scx' stp='on' delay='0'/>\\n  <ip address='192.168.153.1' netmask='255.255.255.0'>\\n</network>\\n"

        def virsh(xml, active):
            return (
                'virsh(){ echo "CALL $3" >&2;case "$3" in net-dumpxml) [ -n "'
                + xml
                + '" ] && printf "'
                + xml
                + '";;net-info) printf "Name: stellarcortex-desktops\\nActive:         '
                + active
                + '\\n";;esac; }'
            )

        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'install-approved.sh').read_text()
            part = text[
                text.index('libvirtd.service\n', text.index('systemctl daemon-reload'))
                + len('libvirtd.service\n') : text.index(
                    'if [ -n "$coexistence" ]; then\n systemctl enable'
                )
            ]
            for xml, active, calls in [
                ('', 'no', ['net-define', 'net-start']),
                (ours, 'no', ['net-start']),
                (ours, 'yes', []),
            ]:
                with self.subTest(xml=xml[:9], active=active):
                    done = self.shell(d, virsh(xml, active), part)
                    self.assertIn('PASSED', done.stdout, done.stderr)
                    self.assertEqual(
                        [
                            word
                            for word in ['net-define', 'net-start']
                            if 'CALL ' + word in done.stderr
                        ],
                        calls,
                    )
            other = self.shell(d, virsh(ours.replace('virbr-scx', 'virbr-other'), 'yes'), part)
            self.assertIn('other settings', other.stdout)
            self.assertNotIn('PASSED', other.stdout)
            self.assertNotIn('CALL net-define', other.stderr)
            self.assertLess(
                text.index('systemctl enable libvirtd.service'),
                text.index('install -m 644 desktop-provider.json'),
                'the file that marks a finished install comes last',
            )
            self.assertLess(
                text.index('install -m 644 desktop-provider.json'),
                text.index('install -m 600 desktop-broker.json'),
            )
            self.assertEqual(text.count('install -m 600 desktop-broker.json'), 1)
            self.assertNotIn('systemctl start stellarcortex-desktop-broker.service', text)

    def test_the_policy_pin_matches_what_the_app_computes(self):
        import subprocess

        code = "import {createHash} from 'node:crypto';import {CODEX_GUEST_CONFIG} from './src/codex-guest-policy.mjs';process.stdout.write(createHash('sha256').update(JSON.stringify(CODEX_GUEST_CONFIG)).digest('hex'))"
        self.assertEqual(
            host.codex_policy(ROOT),
            subprocess.check_output(
                ['node', '--input-type=module', '-e', code], cwd=ROOT, text=True
            ),
        )

    def _bundle(self, directory, iso_name='image.iso'):
        source = pathlib.Path(directory) / 'source'
        source.mkdir()
        for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
            (source / name).mkdir(parents=True)
            (source / name / 'fixture.txt').write_text('code')
        for name in ['package.json', 'package-lock.json']:
            (source / name).write_text('{}')
        iso = pathlib.Path(directory) / iso_name
        iso.write_bytes(b'image')
        out = pathlib.Path(directory) / 'bundle'
        host.render(source, out, 4242, 'a' * 64, 'stellarcortex.service', '/srv/app/data', iso)
        return out, iso

    def test_both_scripts_refuse_a_bundle_others_can_change(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            for name in ['install-approved.sh', 'upgrade-approved.sh']:
                text = (out / name).read_text()
                self.assertLess(
                    text.index('! -uid 0 -o -perm /022'),
                    text.index("python3 - <<'CHECK'"),
                    'before any bundle file is read',
                )
                self.assertIn('Others can change this folder', text)

    def test_a_host_firewall_has_a_reviewed_way_forward(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            text = (out / 'install-approved.sh').read_text()
            self.assertIn('= --firewall-reviewed', text)
            self.assertIn('nothing was changed', text)
            self.assertNotIn('.env', text)
            self.assertNotIn('left as it is. Allow', text)
            self.assertIn('exit 6', text[text.index('coexistence.service ||') :])
            self.assertLess(
                text.index('Existing firewall detected'),
                text.index('apt-get update'),
                'the default stays a refusal before any change',
            )
            self.assertTrue((out / 'network-coexistence.py').is_file())
            self.assertIn(
                'nft',
                (out / 'network-coexistence.unit').read_text()
                + (out / 'network-coexistence.py').read_text(),
            )

    def test_a_path_holding_a_placeholder_word_stays_whole(self):
        with tempfile.TemporaryDirectory() as d:
            out, iso = self._bundle(d, 'MEDIA HASH.iso')
            text = (out / 'install-approved.sh').read_text()
            self.assertIn('MEDIA HASH.iso', text)

    def test_a_host_with_its_own_computer_still_has_a_number_left(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            ids = json.loads((out / 'desktop-broker.json').read_text())['provisioningPolicy'][
                'vmIds'
            ]
            self.assertEqual((ids[0], ids[-1], len(ids)), ('02', '09', 8))

    def test_a_failed_session_keeps_its_numbers_and_a_cap_is_honoured(self):
        provision = load('provision', 'deployment/ubuntu-desktop/session-provision.py')
        used = {'uids': [], 'gids': []}
        self.assertEqual(provision.free_numbers({'desktops': []}, {}, [], used), (1101, 21))
        self.assertEqual(
            provision.free_numbers(
                {'desktops': [{'uid': 1101, 'displayNumber': 21}]},
                {},
                [{'uid': 1102, 'display': 22}],
                used,
            ),
            (1103, 23),
            'a failed session may still hold its screen',
        )
        self.assertIsNone(
            provision.free_numbers(
                {'desktops': [{'uid': 1101, 'displayNumber': 21}]}, {'maxSessions': 1}, [], used
            )
        )
        self.assertIsNone(
            provision.free_numbers(
                {'desktops': [{'displayNumber': i} for i in range(21, 4096)]}, {}, [], used
            )
        )

    def test_the_guest_installs_ubuntu_server_and_a_desktop_iso_stops_with_a_reason(self):
        p = self.fixture()
        self.assertEqual(installer.autoinstall(p)['autoinstall']['source']['id'], 'ubuntu-server')
        with tempfile.TemporaryDirectory() as d:
            staging = pathlib.Path(d)

            def sources(
                text, info='Ubuntu-Server 26.04 LTS "Resolute Raccoon" - Release amd64 (20260423)\n'
            ):
                def run(args, timeout=60):
                    pathlib.Path(args[-1]).write_text(
                        text if args[-1].endswith('sources.yaml') else info
                    )
                    return ''

                return patch.object(installer, 'run', run)

            with sources('- default: true\n  id: ubuntu-server-minimal\n- id: ubuntu-server\n'):
                installer.assert_server_iso(staging)
            with sources(
                '- id: ubuntu-desktop\n- id: ubuntu-desktop-minimal\n'
            ), self.assertRaisesRegex(RuntimeError, 'not Ubuntu Server.*live-server'):
                installer.assert_server_iso(staging)
            for info in [
                'Ubuntu-Server 26.04.1 LTS "Resolute Raccoon" - Release amd64 (20260806)\n',
                'Ubuntu-Server 26.10 "Later" - Release amd64 (20261009)\n',
                'Ubuntu-Server 28.04 LTS - Release amd64\n',
            ]:
                with self.subTest(info=info), sources('- id: ubuntu-server\n', info):
                    installer.assert_server_iso(staging)
            for info in [
                'Ubuntu-Server 24.04.2 LTS "Noble Numbat" - Release amd64 (20250215)\n',
                'Ubuntu-Server 25.10 "Questing Quokka" - Release amd64\n',
                'no version here\n',
            ]:
                with self.subTest(info=info), sources(
                    '- id: ubuntu-server\n', info
                ), self.assertRaisesRegex(RuntimeError, 'older than Ubuntu Server 26.04'):
                    installer.assert_server_iso(staging)

            def broken(args, timeout=60):
                raise installer.subprocess.CalledProcessError(1, 'xorriso')

            with patch.object(installer, 'run', broken), self.assertRaisesRegex(
                RuntimeError, 'not Ubuntu Server'
            ):
                installer.assert_server_iso(staging)

    def test_the_guest_needs_nothing_from_a_desktop_image(self):
        guest = ROOT / 'deployment/ubuntu-desktop/guest'
        install = (guest / 'install.sh').read_text()
        for word in ['gdm3', 'dconf', 'graphical', 'autostart', 'session.env']:
            self.assertNotIn(word, install)
        unit = (guest / 'firstboot.service').read_text()
        self.assertIn('WantedBy=multi-user.target', unit)
        self.assertNotIn('graphical', unit)
        self.assertNotIn('display-manager', unit)
        self.assertNotIn('apt-get', (guest / 'firstboot.sh').read_text())
        self.assertLessEqual(
            {'xfce4', 'tigervnc-standalone-server', 'fonts-culmus'},
            set(installer.autoinstall(self.fixture())['autoinstall']['packages']),
        )

    def test_a_ready_computer_needs_no_base_desktop_to_answer(self):
        p = self.fixture()
        reply = lambda value: {
            'exited': True,
            'exitcode': 0,
            'out-data': base64.b64encode(json.dumps(value).encode()).decode(),
        }
        with patch.object(installer, 'qga', return_value=reply(installer.record(p))), patch.object(
            installer, 'claim_environment', return_value=True
        ), patch.object(
            installer.subprocess, 'run', side_effect=AssertionError('no base worker to call')
        ):
            self.assertTrue(installer.publish_result(p, 1))
        with patch.object(installer, 'qga', return_value=reply(installer.record(p))), patch.object(
            installer, 'claim_environment', return_value=False
        ), self.assertRaisesRegex(RuntimeError, 'remove-computer'):
            installer.publish_result(p, 1)

    def test_the_computer_is_sized_for_the_host(self):
        self.assertEqual(host.computer_size(32768, 16), (16384, 8))
        self.assertEqual(host.computer_size(16384, 4), (8192, 2))
        self.assertEqual(host.computer_size(12288, 2), (6144, 2))
        self.assertEqual(host.computer_size(131072, 64, 8192, 4), (8192, 4))
        with self.assertRaisesRegex(ValueError, '--vm-memory-mib'):
            host.computer_size(8192, 8)
        with self.assertRaisesRegex(ValueError, '--vm-memory-mib'):
            host.computer_size(32768, 8, 30000)
        with self.assertRaisesRegex(ValueError, '--vm-vcpus'):
            host.computer_size(32768, 1)
        self.assertEqual(host.host_memory(lambda: 'MemTotal:       32768000 kB\n'), 32000)
        self.assertEqual(
            {
                k: installer.validate({**self.fixture(), 'memoryMiB': 16384, 'vcpus': 8})[k]
                for k in ['memoryMiB', 'vcpus']
            },
            {'memoryMiB': 16384, 'vcpus': 8},
        )
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            policy = json.loads((out / 'desktop-broker.json').read_text())['provisioningPolicy']
            self.assertEqual((policy['memoryMiB'], policy['vcpus']), (8192, 4))
            directory = pathlib.Path(d)
            cfg = {
                'desktops': [],
                'provisioningPolicy': {
                    **policy,
                    'approved': True,
                    'iso': str(directory / 'x'),
                    'payload': str(out / 'runtime.tar.gz'),
                    'memoryMiB': 16384,
                    'vcpus': 8,
                },
            }
            installer.allocate(cfg, 'bot', directory)
            plan = json.loads((directory / '02.plan.json').read_text())
            self.assertEqual((plan['memoryMiB'], plan['vcpus']), (16384, 8))

    def _restore(self, enabled, now=False, guard=lambda: None):
        calls = []
        net = '<network><bridge name="virbr-scx"/><forward mode="nat"/></network>'

        def virsh(*args):
            calls.append(args)
            return (
                net
                if args[0] == 'net-dumpxml'
                else (
                    'Active: yes'
                    if args[0] == 'net-info'
                    else 'one' if args[0] == 'domuuid' else 'shut off'
                )
            )

        with patch.object(boot, 'prepare_runtime'):
            boot.restore(
                {'desktops': [{'domain': 'scx-desktop-02', 'vmId': '02', 'uuid': 'one'}]},
                virsh,
                guard,
                enabled,
                now,
            )
        return calls

    def test_a_reboot_starts_the_computer_only_when_on_and_only_behind_the_guard(self):
        self.assertIn(('start', 'scx-desktop-02'), self._restore(True))
        self.assertNotIn(
            ('start', 'scx-desktop-02'), self._restore(False), 'off means it stays down'
        )
        self.assertIn(('start', 'scx-desktop-02'), self._restore(False, now=True))

        def down():
            raise RuntimeError('guard down')

        with self.assertRaisesRegex(RuntimeError, 'guard down'):
            self._restore(True, guard=down)
        with self.assertRaisesRegex(RuntimeError, 'guard down'):
            self._restore(True, now=True, guard=down)
        with self.assertRaisesRegex(RuntimeError, 'guard is down'):
            boot.guard_ready(lambda *a, **k: 'table inet other')
        boot.guard_ready(lambda *a, **k: 'iifname "virbr-scx" drop')

    def test_the_owner_choice_beats_the_install_default(self):
        with tempfile.TemporaryDirectory() as d:
            policy = pathlib.Path(d) / 'boot-policy.json'
            self.assertTrue(boot.boot_enabled({'bootApproved': True}, policy))
            self.assertFalse(boot.boot_enabled({}, policy))
            policy.write_text('{"enabled":false}')

            class Stat:
                st_uid = 0
                st_mode = 0o100600

            with patch.object(pathlib.Path, 'lstat', return_value=Stat):
                self.assertFalse(boot.boot_enabled({'bootApproved': True}, policy))

            class Open:
                st_uid = 0
                st_mode = 0o100666

            with patch.object(pathlib.Path, 'lstat', return_value=Open), self.assertRaisesRegex(
                RuntimeError, 'Trusted'
            ):
                boot.boot_enabled({'bootApproved': True}, policy)

    def test_a_fresh_install_comes_back_after_a_reboot(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = self._bundle(d)
            self.assertIs(
                json.loads((out / 'desktop-broker.json').read_text())['bootApproved'], True
            )
            for name in ['install-approved.sh', 'upgrade-approved.sh']:
                self.assertIn(
                    'systemctl enable libvirtd.service stellarcortex-desktop-network-guard.service stellarcortex-desktop-boot.service stellarcortex-desktop-broker.service',
                    (out / name).read_text(),
                )
            unit = (out / 'stellarcortex-desktop-boot.service').read_text()
            self.assertRegex(unit, r'Requires=.*stellarcortex-desktop-network-guard\.service')
            self.assertRegex(unit, r'After=.*stellarcortex-desktop-network-guard\.service')

    def test_a_session_that_fails_early_reports_why_and_later_states_stay(self):
        provision = load('provision', 'deployment/ubuntu-desktop/session-provision.py')
        with tempfile.TemporaryDirectory() as d, patch.object(provision, 'ROOT', pathlib.Path(d)):
            file = pathlib.Path(d) / 'bot.json'
            provision.report('bot', RuntimeError('The computer is not running'))
            self.assertEqual(json.loads(file.read_text())['state'], 'blocked')
            self.assertIn('not running', json.loads(file.read_text())['message'])
            for state in ['applying', 'needs-attention']:
                file.write_text(json.dumps({'state': state}))
                provision.report('bot', RuntimeError('later'))
                self.assertEqual(json.loads(file.read_text()), {'state': state})
            provision.report('../bad', RuntimeError('x'))
            self.assertEqual([f.name for f in pathlib.Path(d).iterdir()], ['bot.json'])


class FirstBoot(unittest.TestCase):
    def plan(self):
        with tempfile.TemporaryDirectory() as d:
            iso = pathlib.Path(d) / 'iso'
            iso.write_bytes(b'i')
            payload = pathlib.Path(d) / 'payload'
            payload.write_bytes(b'p')
            return installer.create_plan('a' * 64, 'environment', '02', iso, payload, 'a' * 64)

    def killed(self):
        status = load('status', 'deployment/ubuntu-desktop/guest/firstboot-status.py')
        with tempfile.TemporaryDirectory() as d:
            step = pathlib.Path(d) / 'current'
            step.write_text('browser\n')
            return status.report(
                pathlib.Path(d) / 'none',
                pathlib.Path(d) / 'none2',
                step,
                lambda: {'ActiveState': 'failed', 'Result': 'timeout'},
            )

    def test_a_killed_unit_stops_the_build_with_its_cause_and_a_way_on(self):
        said = self.killed()
        self.assertIn('browser', said['firstbootFailed'])
        self.assertIn('timeout', said['firstbootFailed'])
        out = base64.b64encode(json.dumps(said).encode()).decode()
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'provisioning').mkdir()
            p = self.plan()
            file = root / '02.state.json'
            file.write_text(json.dumps({'stage': 'booting', 'planHash': installer.plan_hash(p)}))
            answer = lambda p, command: (
                {'pid': 7}
                if command['execute'] == 'guest-exec'
                else {'exited': True, 'exitcode': 0, 'out-data': out}
            )
            with patch.object(installer, 'ROOT', root), patch.object(
                installer, 'qga', answer
            ), self.assertRaises(RuntimeError) as stopped:
                installer.drive(p, file, sleep=lambda seconds: None)
            state = json.loads(file.read_text())
            self.assertEqual(state['stage'], 'needs-attention')
            self.assertIn('browser', state['message'])
            self.assertIn('timeout', state['message'])
            self.assertTrue(state['resume'])
            self.assertEqual(installer.failure_code(stopped.exception), 'first-boot')

    def test_a_hash_mismatch_has_its_own_code_and_other_first_boot_stops_do_not(self):
        mismatch = installer.FirstBootFailed(
            'The computer could not finish its first boot, at: browser: The downloaded Chromium does not match its pinned SHA-256, so it was not installed.'
        )
        self.assertEqual(installer.failure_code(mismatch), 'browser-hash')
        self.assertEqual(
            installer.failure_code(
                installer.FirstBootFailed(
                    'The computer could not finish its first boot, at: browser: curl failed'
                )
            ),
            'first-boot',
        )
        self.assertIn(
            'pinned SHA-256',
            (ROOT / 'deployment/ubuntu-desktop/guest/fetch-chromium.sh').read_text(),
        )

    def test_a_unit_still_running_or_finished_is_not_a_failure(self):
        status = load('status', 'deployment/ubuntu-desktop/guest/firstboot-status.py')
        with tempfile.TemporaryDirectory() as d:
            none = pathlib.Path(d) / 'none'
            done = pathlib.Path(d) / 'done'
            done.write_text('{"vmId":"02"}')
            self.assertEqual(
                status.report(
                    none, none, none, lambda: {'ActiveState': 'activating', 'Result': 'success'}
                ),
                {},
            )
            self.assertEqual(
                status.report(done, none, none, lambda: {'ActiveState': 'failed'}), {'vmId': '02'}
            )

    def test_resuming_keeps_the_marks_and_goes_back_to_waiting(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.plan()
            file = pathlib.Path(d) / '02.state.json'
            file.write_text(json.dumps({'stage': 'resuming', 'planHash': installer.plan_hash(p)}))
            sent = []
            with patch.object(installer, 'virsh', lambda *a: 'running'), patch.object(
                installer, 'qga', lambda p, command: sent.append(command) or {'pid': 7}
            ):
                state = installer.advance(p, file)
            self.assertEqual(state['stage'], 'booting')
            text = sent[0]['arguments']['arg'][1]
            self.assertIn('rm -f /var/lib/stellarcortex-firstboot-failed', text)
            self.assertIn('start --no-block stellarcortex-firstboot.service', text)
            self.assertNotIn('rm -rf', text)

    def test_each_step_of_first_boot_has_a_limit_within_the_unit(self):
        script = (ROOT / 'deployment/ubuntu-desktop/guest/firstboot.sh').read_text()
        steps = [
            (int(a), int(b))
            for a, b in __import__('re').findall(r'^step \w+ (\d+) (\d+) ', script, 8)
        ]
        self.assertEqual(len(steps), 5)
        self.assertLess(sum((limit + 30) * tries for limit, tries in steps), 90 * 60)
        self.assertIn(
            'TimeoutStartSec=90min',
            (ROOT / 'deployment/ubuntu-desktop/guest/firstboot.service').read_text(),
        )
        self.assertRegex(
            script, r'step browser 1500 2 ', 'about 170 MB must fit on a link of about 1 Mbit/s'
        )

    def test_the_computer_has_no_snap_and_each_bot_finds_the_shared_chromium(self):
        guest = ROOT / 'deployment/ubuntu-desktop/guest'
        for name in ['firstboot.sh', 'firstboot.service', 'install-sessions.py']:
            self.assertNotIn('snap', (guest / name).read_text())
        self.assertIn(
            "'PLAYWRIGHT_BROWSERS_PATH': '/opt/stellarcortex-browsers'",
            (guest / 'install-sessions.py').read_text(),
        )
        self.assertIn(
            'PLAYWRIGHT_BROWSERS_PATH=/opt/stellarcortex-browsers',
            (guest / 'firstboot.sh').read_text(),
        )
        self.assertIn(
            '/opt/stellarcortex-browsers/chromium-*/chrome-linux64/chrome',
            (guest / 'chromium.apparmor').read_text(),
        )
        self.assertIn('libnss3', installer.screen_packages())

    def test_the_computers_memory_sets_how_many_bots_get_a_desktop(self):
        provision = load('provision', 'deployment/ubuntu-desktop/session-provision.py')
        used = {'uids': [], 'gids': []}
        self.assertEqual(
            [provision.session_limit(memory) for memory in [4096, 8192, 15360, 32768]],
            [2, 4, 9, 20],
        )
        rows = [{'uid': 1101 + i, 'displayNumber': 21 + i} for i in range(2)]
        config = {'desktops': rows, 'provisioningPolicy': {'memoryMiB': 4096}}
        self.assertIsNone(provision.free_numbers(config, {}, [], used))
        self.assertIsNotNone(
            provision.free_numbers(
                {**config, 'provisioningPolicy': {'memoryMiB': 8192}}, {}, [], used
            )
        )
        self.assertIsNotNone(
            provision.free_numbers(config, {'maxSessions': 3}, [], used),
            'the owner can still set it',
        )


class Units(unittest.TestCase):
    def test_no_rendered_unit_has_a_quoted_path_setting(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d)
            source = base / 'source'
            source.mkdir()
            for name in ['src', 'scripts', 'deployment/ubuntu-desktop']:
                (source / name).mkdir(parents=True)
                (source / name / 'fixture.txt').write_text('code')
            for name in ['package.json', 'package-lock.json']:
                (source / name).write_text('{}')
            out = base / 'bundle'
            host.render(source, out, 4242, 'a' * 64, 'stellarcortex.service', '/srv/app/data', None)
            units = [f for f in out.iterdir() if f.suffix in ['.service', '.unit']]
            self.assertGreater(len(units), 5)
            for unit in units:
                for line in unit.read_text().splitlines():
                    self.assertNotRegex(
                        line,
                        r'^(WorkingDirectory|RootDirectory|ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|EnvironmentFile|PIDFile)=[-+]?["\']',
                        unit.name,
                    )


class RunningUnit(unittest.TestCase):
    def settings(self, system, user):
        with tempfile.TemporaryDirectory() as d:
            units = pathlib.Path(d) / '.config/systemd/user'
            units.mkdir(parents=True)
            (units / 'stellarcortex.service').write_text(
                '[Service]\nEnvironment=STELLARCORTEX_DATA_DIR=/from/user\n'
            )

            def run(args, **options):
                if '--user' not in args:
                    return (
                        'LoadState=loaded\nActiveState='
                        + ('active' if system else 'inactive')
                        + '\nEnvironment=STELLARCORTEX_DATA_DIR=/from/system\n'
                    )
                self.assertIn('--machine=me@.host', args)
                if not user:
                    raise subprocess.CalledProcessError(3, args)
                return 'active\n'

            return host.app_service_settings(
                'stellarcortex.service', 4242, run, lambda uid: d, lambda uid: 'me'
            )

    def test_with_both_units_the_one_running_decides(self):
        isuser, shown = self.settings(False, True)
        self.assertTrue(isuser)
        self.assertIn('/from/user', shown)
        isuser, shown = self.settings(True, False)
        self.assertFalse(isuser)
        self.assertIn('/from/system', shown)

    def test_with_both_units_and_no_clear_answer_it_stops(self):
        with self.assertRaisesRegex(ValueError, 'both are running'):
            self.settings(True, True)
        with self.assertRaisesRegex(ValueError, 'neither is running'):
            self.settings(False, False)


class ReviewFive(unittest.TestCase):
    def test_every_host_that_passes_the_install_check_can_build(self):
        for total in [10240, 11264, 12288, 14336, 15872, 16384]:
            memory, _ = host.computer_size(total, 4)
            self.assertGreaterEqual(memory, 4096)
            self.assertLessEqual(memory + host.RESERVE, total)
            self.assertFalse(
                installer.memory_short(total - 2048, memory),
                str(total) + ' MiB with 2 GiB in use must build',
            )
        self.assertTrue(
            installer.memory_short(4096, 4096),
            'the host keeps some memory free beside the computer',
        )

    def test_the_host_has_the_tool_the_network_guard_runs(self):
        self.assertIn('nftables', host.PACKAGES)
        self.assertIn('nftables', installer.PACKAGES)

    def test_a_user_unit_setting_with_its_home_specifier_is_understood(self):
        with tempfile.TemporaryDirectory() as d:
            unit = pathlib.Path(d) / '.config/systemd/user'
            unit.mkdir(parents=True)
            (unit / 'stellarcortex.service').write_text(
                '[Service]\nEnvironment=STELLARCORTEX_DATA_DIR=%h/data\n'
            )
            _, shown = host.app_service_settings(
                'stellarcortex.service',
                4242,
                lambda *a, **o: 'LoadState=not-found\n',
                lambda uid: d,
            )
        self.assertIn(d + '/data', shown)

    REMOVE = (
        pathlib.Path(__file__).resolve().parent.parent
        / 'deployment/ubuntu-desktop/guest/remove-session.py'
    )

    def guest_removal(self, user):
        ran = []

        def getpwnam(name):
            if user is None:
                raise KeyError(name)
            return types.SimpleNamespace(pw_uid=user)

        import pwd, runpy

        with patch.object(os, 'geteuid', lambda: 0, create=True), patch.dict(
            os.environ, {'STELLARCORTEX_INSIDE_GUEST': '1'}
        ), patch('sys.argv', ['remove-session.py', 'desktop-' + 'a' * 20]), patch.object(
            pwd, 'getpwnam', getpwnam, create=True
        ), patch.object(
            subprocess,
            'run',
            lambda command, **o: ran.append(command) or types.SimpleNamespace(returncode=0),
        ):
            runpy.run_path(str(self.REMOVE), run_name='__main__')
        return ran

    def test_removal_finishes_when_the_user_is_already_gone(self):
        self.assertEqual(self.guest_removal(None), [])

    def test_removal_touches_one_user_and_no_other_bots_connection(self):
        ran = self.guest_removal(1200)
        self.assertEqual(ran[-1], ['/usr/sbin/userdel', '--remove', 'scxb_' + 'a' * 20])
        self.assertFalse([c for c in ran if 'session-relay' in ' '.join(c)])

    def test_the_relay_never_reads_a_half_written_registry(self):
        session = 'desktop-' + 'a' * 20
        other = {'sessionId': 'desktop-' + 'b' * 20}
        with tempfile.TemporaryDirectory() as d:
            real = pathlib.Path
            registry = real(d + '/etc/stellarcortex/session-registry.json')
            registry.parent.mkdir(parents=True)
            registry.write_text(json.dumps({'sessions': [{'sessionId': session}, other]}))
            replaced = []
            swap = os.replace

            def replace(source, target):
                replaced.append(real(target))
                swap(source, target)

            with patch.object(pathlib, 'Path', lambda name: real(d + name)), patch.object(
                os, 'replace', replace
            ), patch.object(os, 'chown', lambda *a: None, create=True):
                self.guest_removal(None)
            self.assertEqual(replaced, [registry])
            self.assertEqual(json.loads(registry.read_text()), {'sessions': [other]})
            self.assertEqual([f.name for f in registry.parent.iterdir()], [registry.name])
        text = (
            pathlib.Path(__file__).resolve().parent.parent
            / 'deployment/ubuntu-desktop/guest/install-sessions.py'
        ).read_text()
        body = text[text.index('def write(file') :]
        self.assertEqual(
            body[: body.index('\n\n')].splitlines()[-1].strip(), 'os.replace(temp, file)'
        )

    def removal(self, d, bots, record=None, result=None):
        provision = load('provision', 'deployment/ubuntu-desktop/session-provision.py')
        root = pathlib.Path(d)
        calls = []
        state = root / 'state.json'
        state.write_text(json.dumps({'bots': bots}))
        config = {
            'desktops': [record] if record else [],
            'sessionProvisioning': {
                'computer': {'computerId': 'env', 'domain': 'scx-desktop-02', 'uuid': 'u'}
            },
        }
        provider = {
            'records': [record] if record else [],
            'environmentComputer': {'computerId': 'env'},
        }
        if result:
            (root / 'bot.json').write_text(json.dumps(result))
        fcntl = types.SimpleNamespace(flock=lambda *a: None, LOCK_EX=2)
        with patch.object(provision, 'ROOT', root), patch.object(
            provision, 'fcntl', fcntl, create=True
        ), patch.object(provision.os, 'geteuid', lambda: 0, create=True), patch.object(
            provision,
            'trusted',
            lambda file: config if file.name == 'desktop-broker.json' else provider,
        ), patch.object(
            provision, 'state_file', lambda p: state
        ), patch.object(
            provision, 'save', lambda *a: None
        ), patch.object(
            provision,
            'guest_access',
            lambda base: (
                None,
                lambda command, timeout: calls.append((base['computerId'], command)),
            ),
        ):
            provision.remove('bot')
        return calls, root / 'bot.json'

    def test_a_deleted_bots_half_made_session_is_removed_by_its_result_file(self):
        with tempfile.TemporaryDirectory() as d:
            calls, file = self.removal(
                d,
                [{'id': 'bot', 'deletedAt': 'now'}],
                result={
                    'state': 'needs-attention',
                    'sessionId': 'desktop-' + 'a' * 20,
                    'uid': 1200,
                    'display': 30,
                },
            )
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], 'env')
            self.assertIn('desktop-' + 'a' * 20, calls[0][1])
            self.assertFalse(file.exists(), 'the uid and display are free again')

    def test_a_result_with_nothing_applied_needs_no_computer(self):
        with tempfile.TemporaryDirectory() as d:
            calls, file = self.removal(
                d,
                [{'id': 'bot', 'deletedAt': 'now'}],
                result={'state': 'blocked', 'message': 'off'},
            )
            self.assertEqual(calls, [])
            self.assertFalse(file.exists())

    def test_a_live_bot_keeps_a_half_made_session_too(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaisesRegex(
            RuntimeError, 'Only a deleted bot'
        ):
            self.removal(
                d,
                [{'id': 'bot'}],
                result={'state': 'needs-attention', 'sessionId': 'desktop-' + 'a' * 20},
            )


if __name__ == '__main__':
    unittest.main()
