#!/usr/bin/python3
"""Allocate one separate user desktop on the existing approved environment VM.
No image installation, credential copying, VM creation or network changes.
"""

import base64, fcntl, importlib.util, json, os, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path('/var/lib/stellarcortex/desktops/sessions')
CONFIG = pathlib.Path('/etc/stellarcortex')


def trusted(file):
    s = file.lstat()
    if not file.is_file() or file.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError('Trusted root configuration required')
    return json.loads(file.read_text())


def save(file, value, mode=0o600):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.chmod(mode)
    os.replace(tmp, file)


def state_file(provider):
    data = provider.get('dataDir')
    if not isinstance(data, str) or not data.startswith('/'):
        raise RuntimeError(
            'desktop-provider.json needs dataDir, the absolute path of the app data folder'
        )
    return pathlib.Path(data) / 'state.json'


# A safe estimate of what the system and one bot's desktop, browser and tools use, until real numbers are measured.
SYSTEM_MIB = 1024
SESSION_MIB = 1536


def session_limit(memory):
    return max(1, (memory - SYSTEM_MIB) // SESSION_MIB)


def free_numbers(config, policy, held, used):
    '''A failed session keeps its numbers, because its screen may still be up. The computer's memory sets the limit, unless the owner set maxSessions.'''
    rows = config['desktops']
    limit = policy.get(
        'maxSessions', session_limit(config.get('provisioningPolicy', {}).get('memoryMiB', 8192))
    )
    if isinstance(limit, int) and len(rows) >= limit:
        return None
    uids = {r.get('uid') for r in rows + held}
    displays = {r.get('displayNumber') for r in rows} | {r.get('display') for r in held}
    uid = next(
        (
            i
            for i in range(1101, 60001)
            if i not in uids and i not in used['uids'] and i not in used['gids']
        ),
        None,
    )
    display = next((i for i in range(21, 4096) if i not in displays), None)
    return None if uid is None or display is None else (uid, display)


def base_record(config, policy, env):
    # Until the first session exists, the environment computer is known only from the policy.
    return next(
        r
        for r in config['desktops'] + [policy.get('computer', {})]
        if r.get('computerId') == env['computerId']
    )


def guest_access(base):
    def virsh(*args):
        return subprocess.check_output(
            ['/usr/bin/virsh', '--connect', 'qemu:///system', *args], text=True, timeout=30
        ).strip()

    if virsh('domuuid', base['domain']) != base['uuid']:
        raise RuntimeError('Registered computer identity changed')
    if virsh('domstate', base['domain']) != 'running':
        raise RuntimeError('The computer is not running. Press Start in Settings > Computer.')

    def qga(value):
        return json.loads(virsh('qemu-agent-command', base['domain'], json.dumps(value)))['return']

    def execute(script, tries=240):
        pid = qga(
            {
                'execute': 'guest-exec',
                'arguments': {'path': '/bin/bash', 'arg': ['-lc', script], 'capture-output': True},
            }
        )['pid']
        for _ in range(tries):
            r = qga({'execute': 'guest-exec-status', 'arguments': {'pid': pid}})
            if r.get('exited'):
                if r.get('exitcode') != 0:
                    raise RuntimeError(
                        'Guest setup failed; inspect installation journal (pid ' + str(pid) + ')'
                    )
                return base64.b64decode(r.get('out-data', '')).decode()
            time.sleep(0.5)
        raise RuntimeError(
            'Guest setup outcome uncertain; inspect pid ' + str(pid) + ' without replay'
        )

    return qga, execute


def remove(bot):
    '''A deleted bot loses its own user and desktop. Nothing else on the computer changes.'''
    if os.geteuid() != 0 or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', bot):
        raise RuntimeError('Root service and stable bot identity required')
    with (ROOT / 'allocation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = trusted(CONFIG / 'desktop-broker.json')
        provider = trusted(CONFIG / 'desktop-provider.json')
        record = next((r for r in config['desktops'] if r['botId'] == bot), None)
        # A setup that stopped half way left no record, only its result file, which holds its uid and display.
        resultfile = ROOT / (bot + '.json')
        session = (
            record['sessionId']
            if record
            else (
                json.loads(resultfile.read_text()).get('sessionId') if resultfile.exists() else None
            )
        )
        candidate = next(
            (b for b in json.loads(state_file(provider).read_text())['bots'] if b['id'] == bot),
            None,
        )
        if candidate and not candidate.get('deletedAt'):
            raise RuntimeError('Only a deleted bot loses its desktop')
        if session:
            if not re.fullmatch(r'desktop-[a-f0-9]{20}', session):
                raise RuntimeError('Unexpected session identity')
            _, execute = guest_access(
                record
                or base_record(
                    config, config['sessionProvisioning'], provider['environmentComputer']
                )
            )
            execute(
                'STELLARCORTEX_INSIDE_GUEST=1 /usr/bin/python3 /opt/stellarcortex-worker/deployment/ubuntu-desktop/guest/remove-session.py '
                + session,
                120,
            )
        if record:
            config['desktops'] = [r for r in config['desktops'] if r['botId'] != bot]
            provider['records'] = [r for r in provider['records'] if r['botId'] != bot]
            save(CONFIG / 'desktop-broker.json', config)
            save(CONFIG / 'desktop-provider.json', provider, 0o644)
        resultfile.unlink(missing_ok=True)


def main(bot):
    if os.geteuid() != 0 or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', bot):
        raise RuntimeError('Root service and stable bot identity required')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT / 'allocation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = trusted(CONFIG / 'desktop-broker.json')
        policy = config.get('sessionProvisioning', {})
        if policy.get('approved') is not True:
            raise RuntimeError('Automatic session provisioning is not approved')
        provider = trusted(CONFIG / 'desktop-provider.json')
        env = provider['environmentComputer']
        base = base_record(config, policy, env)
        if (
            policy.get('accountId') != base['accountId']
            or policy.get('environmentId') != base['environmentId']
            or policy.get('computerId') != base['computerId']
        ):
            raise RuntimeError('Provisioning scope mismatch')
        state = json.loads(state_file(provider).read_text())
        candidate = next(
            (b for b in state['bots'] if b['id'] == bot and not b.get('deletedAt')), None
        )
        if (
            not candidate
            or (candidate.get('environmentId') or env['environmentId']) != env['environmentId']
        ):
            raise RuntimeError('Unknown environment bot')
        computer = candidate.get('computer')
        allowed = env.get('overrides', {}).get(
            bot, computer == 'vm' if computer else env['defaultAccess']
        )
        if allowed is not True:
            raise RuntimeError('Computer access disabled')
        resultfile = ROOT / (bot + '.json')
        if any(r['botId'] == bot for r in config['desktops']):
            save(resultfile, {'state': 'ready', 'active': False})
            return
        if resultfile.exists() and json.loads(resultfile.read_text()).get('state') in [
            'applying',
            'needs-attention',
        ]:
            raise RuntimeError('Previous allocation requires inspection; no automatic replay')
        qga, execute = guest_access(base)
        used = json.loads(
            execute(
                "python3 - <<'CHECK'\nimport pwd,grp,json\nprint(json.dumps({'uids':[x.pw_uid for x in pwd.getpwall()],'gids':[x.gr_gid for x in grp.getgrall()]}))\nCHECK"
            )
        )
        registry = json.loads(
            execute("cat /etc/stellarcortex/session-registry.json 2>/dev/null || echo '{}'")
        )
        if any(s.get('accountId') != base['accountId'] for s in registry.get('sessions', [])):
            raise RuntimeError(
                'This computer holds sessions of another owner. Remove it with installer.py remove-computer, then install it again.'
            )
        numbers = free_numbers(
            config, policy, [json.loads(f.read_text()) for f in ROOT.glob('*.json')], used
        )
        if not numbers:
            save(resultfile, {'state': 'session-limit', 'active': False, 'botId': bot})
            return
        uid, display = numbers
        spec = importlib.util.spec_from_file_location(
            'session_plan', pathlib.Path(__file__).parent / 'guest/session-plan.py'
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scope = {k: base[k] for k in module.KEYS}
        scope['botId'] = bot
        planned = module.plan_session(scope, uid, display)
        record = {
            **base,
            **planned['record'],
            'username': planned['user']['name'],
            'home': planned['user']['home'],
        }
        plan = {'approved': True, 'incremental': True, 'records': [record]}
        payload = json.dumps(plan).encode()
        guestplan = '/root/scx-session-' + bot + '.json'
        save(
            resultfile,
            {
                'state': 'applying',
                'active': True,
                'botId': bot,
                'sessionId': record['sessionId'],
                'uid': uid,
                'display': display,
            },
        )
        try:
            handle = qga(
                {'execute': 'guest-file-open', 'arguments': {'path': guestplan, 'mode': 'w'}}
            )
            try:
                if qga(
                    {
                        'execute': 'guest-file-write',
                        'arguments': {
                            'handle': handle,
                            'buf-b64': base64.b64encode(payload).decode(),
                        },
                    }
                )['count'] != len(payload):
                    raise RuntimeError('Incomplete plan transfer')
            finally:
                qga({'execute': 'guest-file-close', 'arguments': {'handle': handle}})
            execute(
                'chmod 600 '
                + guestplan
                + '; STELLARCORTEX_INSIDE_GUEST=1 /usr/bin/python3 /opt/stellarcortex-worker/deployment/ubuntu-desktop/guest/install-sessions.py '
                + guestplan,
                1500,
            )
            # Guest registry creation is durable proof that the installation script completed.
            guest = json.loads(execute("cat /etc/stellarcortex/session-registry.json"))
            if record not in guest['sessions']:
                raise RuntimeError('Guest registration not confirmed')
            config = trusted(CONFIG / 'desktop-broker.json')
            provider = trusted(CONFIG / 'desktop-provider.json')
            if any(r['botId'] == bot for r in config['desktops'] + provider['records']):
                raise RuntimeError('Allocation changed during setup')
            config['desktops'].append(record)
            provider['records'].append(record)
            save(CONFIG / 'desktop-broker.json', config)
            save(CONFIG / 'desktop-provider.json', provider, 0o644)
            save(
                resultfile,
                {
                    'state': 'ready',
                    'active': False,
                    'botId': bot,
                    'sessionId': record['sessionId'],
                    'uid': uid,
                },
            )
            print('BOT_SESSION_READY')
        except Exception as error:
            save(
                resultfile,
                {
                    'state': 'needs-attention',
                    'active': False,
                    'botId': bot,
                    'sessionId': record['sessionId'],
                    'message': str(error),
                    'noReplay': True,
                    'uid': uid,
                    'display': display,
                },
            )
            raise


def report(bot, error):
    '''A failure before any change can be retried, and the owner must see why. Later states stay for inspection.'''
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', bot) or not ROOT.is_dir():
        return
    file = ROOT / (bot + '.json')
    if not file.exists() or json.loads(file.read_text()).get('state') not in [
        'applying',
        'needs-attention',
    ]:
        save(file, {'state': 'blocked', 'active': False, 'botId': bot, 'message': str(error)[:300]})


if __name__ == '__main__':
    if sys.argv[2:] == ['remove']:
        remove(sys.argv[1])
        sys.exit()
    try:
        main(sys.argv[1])
    except Exception as error:
        report(sys.argv[1], error)
        raise
