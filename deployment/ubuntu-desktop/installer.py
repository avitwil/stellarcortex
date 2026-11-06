#!/usr/bin/python3
"""Builds the one shared Ubuntu computer. The install starts this, and the owner's Retry repeats it.
Each advance performs one bounded stage, records intent before effects and never
repeats an interrupted mutating stage. Existing guests/disks are never replaced.
"""

import argparse, base64, importlib.util, time, hashlib, json, os, pathlib, re, shutil, subprocess, tarfile, urllib.error, urllib.request, uuid, xml.etree.ElementTree as ET

ROOT = pathlib.Path('/var/lib/stellarcortex/desktops')
RUNTIME = pathlib.Path('/run/stellarcortex-desktops')
PACKAGES = [
    'qemu-system-x86',
    'qemu-utils',
    'libvirt-daemon-system',
    'libvirt-clients',
    'virtinst',
    'ovmf',
    'swtpm',
    'dnsmasq-base',
    'xorriso',
    'gnupg',
    'dirmngr',
    'nftables',
]
# host-setup.py sizes the computer to leave the host its reserve, which includes what the host already runs. This much must be free beside it.
HOST_FREE = 1024
# No bot asks for the computer, so its plan has this owner. Bots get sessions on it.
ENVIRONMENT_BOT = 'environment'
ISO_HOME = 'https://releases.ubuntu.com/26.04/'
UBUNTU_KEY = '843938DF228D22F7B3742BC0D94AA3F0EFE21092'


def screen_packages():
    spec = importlib.util.spec_from_file_location(
        'session_ready', pathlib.Path(__file__).parent / 'guest/session_ready.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PACKAGES


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def plan_hash(plan):
    return hashlib.sha256(canonical(plan)).hexdigest()


def save(path, value, mode=0o600):
    path = pathlib.Path(path)
    temp = path.with_name(path.name + '.tmp')
    with open(temp, 'x', encoding='utf8') as f:
        os.chmod(temp, mode)
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value)


def validate(p):
    if p.get('version') != 1 or p.get('provider') != 'qemu-kvm-ubuntu-desktop':
        raise ValueError('Unsupported provisioning plan')
    if not all(valid_id(p.get(k)) for k in ['accountId', 'botId']):
        raise ValueError('Stable owner identity required')
    if not re.fullmatch(r'0[2-9]|[1-9][0-9]|1[0-9]{2}', str(p.get('vmId', ''))):
        raise ValueError('New allocation ID must be 02..199; never overwrite first guest')
    if str(uuid.UUID(p['uuid'])) != p['uuid']:
        raise ValueError('Canonical UUID required')
    if (
        not isinstance(p.get('memoryMiB'), int)
        or not 4096 <= p['memoryMiB'] <= 1048576
        or not isinstance(p.get('vcpus'), int)
        or not 2 <= p['vcpus'] <= 256
        or p.get('diskGiB') != 80
    ):
        raise ValueError(
            'The computer needs 4 GiB to 1 TiB of memory, 2 to 256 CPUs, and the 80 GiB disk'
        )
    if not all(
        re.fullmatch(r'[a-f0-9]{64}', str(p.get(k, ''))) for k in ['isoSha256', 'payloadSha256']
    ):
        raise ValueError('Pinned image/payload required')
    for k in ['iso', 'payload']:
        if not pathlib.Path(p[k]).is_absolute():
            raise ValueError('Absolute local media path required')
    if p.get('network') != 'stellarcortex-desktops' or p.get('disableGuestIdleLock') is not True:
        raise ValueError('Explicit dedicated-network and guest lock policy required')
    return p


def create_plan(account, bot, vm, iso, payload, iso_sha=None, memory=8192, vcpus=4):
    return validate(
        dict(
            version=1,
            provider='qemu-kvm-ubuntu-desktop',
            accountId=account,
            botId=bot,
            vmId=vm,
            uuid=str(uuid.uuid4()),
            memoryMiB=memory,
            vcpus=vcpus,
            diskGiB=80,
            iso=str(pathlib.Path(iso).resolve()),
            isoSha256=iso_sha or digest(iso),
            payload=str(pathlib.Path(payload).resolve()),
            payloadSha256=digest(payload),
            network='stellarcortex-desktops',
            disableGuestIdleLock=True,
        )
    )


def run(args, timeout=60):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=timeout)


def virsh(*args):
    return run(['virsh', '--connect', 'qemu:///system', *args])


def domain(p):
    return 'scx-desktop-' + p['vmId']


def record(p):
    return {k: p[k] for k in ['accountId', 'botId', 'vmId']} | {
        'generation': p['uuid'],
        'uuid': p['uuid'],
        'domain': domain(p),
        'cid': 150 + int(p['vmId']),
    }


def disk_serial(p):
    return 'scx-' + p['vmId'] + '-' + p['uuid'][:8]


def autoinstall(p):
    serial = disk_serial(p)
    return {
        'autoinstall': {
            'version': 1,
            'refresh-installer': {'update': False},
            'source': {'id': 'ubuntu-server'},
            'locale': 'en_US.UTF-8',
            'keyboard': {'layout': 'us'},
            'identity': {
                'hostname': domain(p),
                'username': 'desktop',
                'realname': 'StellarCortex Desktop',
                'password': '!',
            },
            'ssh': {'install-server': False},
            'storage': {'layout': {'name': 'direct', 'match': {'serial': serial}}},
            'packages': [
                'qemu-guest-agent',
                'nodejs',
                'npm',
                'python3-gi',
                'gir1.2-atspi-2.0',
                *screen_packages(),
            ],
            'updates': 'security',
            'shutdown': 'poweroff',
            'late-commands': [
                ['mkdir', '-p', '/target/opt/stellarcortex-worker'],
                [
                    'tar',
                    '-xzf',
                    '/cdrom/scx-payload.tar.gz',
                    '-C',
                    '/target/opt/stellarcortex-worker',
                ],
                [
                    'cp',
                    '/cdrom/scx-guest.json',
                    '/target/opt/stellarcortex-worker/guest-install.json',
                ],
                [
                    'curtin',
                    'in-target',
                    '--target=/target',
                    '--',
                    '/bin/bash',
                    '/opt/stellarcortex-worker/deployment/ubuntu-desktop/guest/install.sh',
                ],
            ],
        }
    }


def domain_xml(p, media, disk):
    name = domain(p)
    sock = '/run/stellarcortex-desktops/' + name + '/vnc.sock'
    args = [
        'virt-install',
        '--connect',
        'qemu:///system',
        '--name',
        name,
        '--uuid',
        p['uuid'],
        '--memory',
        str(p['memoryMiB']),
        '--vcpus',
        str(p['vcpus']),
        '--cpu',
        'host-passthrough',
        '--machine',
        'q35',
        '--osinfo',
        'detect=on,require=off',
        '--import',
        '--disk',
        f'path={disk},format=qcow2,bus=virtio,serial={disk_serial(p)},cache=unsafe',
        '--disk',
        f'path={media},device=cdrom',
        '--network',
        'network=stellarcortex-desktops,model=virtio',
        '--graphics',
        f'vnc,listens0.type=socket,listens0.socket={sock}',
        '--video',
        'virtio',
        '--input',
        'tablet,bus=usb',
        '--channel',
        'unix,target.type=virtio,target.name=org.qemu.guest_agent.0',
        '--rng',
        '/dev/urandom',
        '--boot',
        'uefi,cdrom,hd',
        '--noautoconsole',
        '--print-xml',
    ]
    root = ET.fromstring(run(args))
    ET.SubElement(root.find('./devices/interface'), 'port', {'isolated': 'yes'})
    vs = ET.SubElement(root.find('devices'), 'vsock', {'model': 'virtio'})
    ET.SubElement(vs, 'cid', {'auto': 'no', 'address': str(150 + int(p['vmId']))})
    return ET.tostring(root, encoding='unicode')


def assert_identity(p):
    if virsh('domuuid', domain(p)).strip() != p['uuid']:
        raise RuntimeError('VM identity differs; no action taken')


def memory_short(available, memory):
    return available < memory + HOST_FREE


def preflight(p):
    for tool in ['virsh', 'virt-install', 'qemu-img', 'xorriso', 'nft']:
        if not shutil.which(tool):
            raise RuntimeError('Missing host package/tool: ' + tool)
    if not pathlib.Path('/dev/kvm').exists():
        raise RuntimeError('KVM unavailable')
    mem = (
        int(
            next(
                x.split()[1]
                for x in pathlib.Path('/proc/meminfo').read_text().splitlines()
                if x.startswith('MemAvailable:')
            )
        )
        // 1024
    )
    if memory_short(mem, p['memoryMiB']):
        raise RuntimeError(
            'The computer needs '
            + str(p['memoryMiB'])
            + ' MiB and the host needs '
            + str(HOST_FREE)
            + ' MiB free beside it, but only '
            + str(mem)
            + ' MiB is available. Close some programs and try again, or render a new bundle with a smaller --vm-memory-mib.'
        )
    if shutil.disk_usage(ROOT).free < 90 * 1024**3:
        raise RuntimeError('Less than 90 GiB free for disk and installation media')
    names = virsh('list', '--all', '--name').split()
    if domain(p) in names:
        raise RuntimeError('Domain already exists; never overwrite')
    for name in names:
        node = ET.fromstring(virsh('dumpxml', name, '--inactive')).find('./devices/vsock/cid')
        if node is not None and node.get('address') == str(150 + int(p['vmId'])):
            raise RuntimeError('vsock identity already allocated')
    for file, key in [
        ('/etc/stellarcortex/desktop-broker.json', 'desktops'),
        ('/etc/stellarcortex/desktop-provider.json', 'records'),
    ]:
        rows = json.loads(pathlib.Path(file).read_text())[key]
        if any(r['accountId'] == p['accountId'] and r['botId'] == p['botId'] for r in rows):
            raise RuntimeError('Bot already owns a computer; never replace it')
    net = ET.fromstring(virsh('net-dumpxml', 'stellarcortex-desktops'))
    if (
        net.find('bridge').get('name') != 'virbr-scx'
        or net.find('forward').get('mode') != 'nat'
        or net.find('ip').get('address') != '192.168.153.1'
    ):
        raise RuntimeError('Dedicated NAT network differs')
    # Existing host firewalls require their own reviewed coexistence plan. Never flush them.
    guard = run(['nft', 'list', 'table', 'inet', 'scx_desktops'])
    if 'virbr-scx' not in guard:
        raise RuntimeError('Dedicated network guard unavailable')
    for key, expected in [('iso', p['isoSha256']), ('payload', p['payloadSha256'])]:
        if pathlib.Path(p[key]).is_symlink() or digest(p[key]) != expected:
            raise RuntimeError('Media hash mismatch: ' + key)
    files = set()
    with tarfile.open(p['payload']) as archive:
        for entry in archive:
            name = pathlib.PurePosixPath(entry.name)
            if (
                name.is_absolute()
                or '..' in name.parts
                or entry.issym()
                or entry.islnk()
                or not (entry.isfile() or entry.isdir())
            ):
                raise RuntimeError('Unsafe payload member')
            files.add(str(name))
    if not {'package.json', 'package-lock.json'} <= files:
        raise RuntimeError(
            'The guest payload has no package.json or package-lock.json, so the computer could not finish its first boot. Render a new bundle.'
        )


MIN_UBUNTU = (26, 4)


def assert_server_iso(staging):
    '''The installer lists its own sources on the ISO. A Desktop ISO, an older release or another image stops here, with a clear reason.'''
    wrong = 'This ISO is not Ubuntu Server. Use the live-server amd64 ISO from releases.ubuntu.com, and render a new bundle with it.'
    try:
        for name, target in [
            ('/casper/install-sources.yaml', 'sources.yaml'),
            ('/.disk/info', 'disk-info'),
        ]:
            run(
                [
                    'xorriso',
                    '-osirrox',
                    'on',
                    '-indev',
                    str(staging / 'iso'),
                    '-extract',
                    name,
                    str(staging / target),
                ]
            )
    except subprocess.CalledProcessError:
        raise RuntimeError(wrong)
    if not re.search(
        r'^[\s-]*id:\s*ubuntu-server\s*$', (staging / 'sources.yaml').read_text(), re.M
    ):
        raise RuntimeError(wrong)
    # First boot needs the Node.js that this release packages.
    version = re.search(r'\b(\d+)\.(\d+)', (staging / 'disk-info').read_text())
    if not version or tuple(map(int, version.groups())) < MIN_UBUNTU:
        raise RuntimeError(
            'This ISO is older than Ubuntu Server 26.04 LTS, so the computer could not finish its first boot. Use 26.04 LTS or later, and render a new bundle with it.'
        )


def prepare(p):
    preflight(p)
    folder = ROOT / domain(p)
    folder.mkdir(mode=0o711)
    folder.chmod(0o711)
    staging = folder / 'media'
    staging.mkdir(mode=0o700)
    # Copy inputs to private root-owned staging before rechecking hashes. Never use a
    # mutable caller-controlled payload after verification.
    # The ISO stays in root's media folder and preflight just hashed it, so a link saves a 3 GB copy and hash.
    try:
        os.link(p['iso'], staging / 'iso')
    except OSError:
        shutil.copyfile(p['iso'], staging / 'iso')
    dest = staging / 'payload'
    shutil.copyfile(p['payload'], dest)
    os.chmod(dest, 0o600)
    if digest(dest) != p['payloadSha256']:
        raise RuntimeError('Media changed while copying')
    save(staging / 'autoinstall.yaml', autoinstall(p))
    save(
        staging / 'scx-guest.json', record(p) | {'provider': p['provider'], 'botIds': [p['botId']]}
    )
    grub = staging / 'grub.cfg'
    grub.write_text(
        'set timeout=0\nset default=0\nmenuentry "Install dedicated StellarCortex computer" {\n linux /casper/vmlinuz boot=casper autoinstall ---\n initrd /casper/initrd\n}\n'
    )
    assert_server_iso(staging)
    run(
        [
            'xorriso',
            '-osirrox',
            'on',
            '-indev',
            str(staging / 'iso'),
            '-extract',
            '/md5sum.txt',
            str(staging / 'md5sum.txt'),
        ]
    )
    checksums = (staging / 'md5sum.txt').read_text().splitlines()
    changed = {
        './boot/grub/grub.cfg': grub,
        './autoinstall.yaml': staging / 'autoinstall.yaml',
        './scx-payload.tar.gz': staging / 'payload',
        './scx-guest.json': staging / 'scx-guest.json',
    }
    checksums = [
        line for line in checksums if line.split(maxsplit=1)[-1].lstrip('*') not in changed
    ]
    for name, file in changed.items():
        checksums.append(hashlib.md5(file.read_bytes()).hexdigest() + '  ' + name)
    (staging / 'md5sum.txt').write_text('\n'.join(checksums) + '\n')
    run(
        [
            'xorriso',
            '-indev',
            str(staging / 'iso'),
            '-outdev',
            str(folder / 'installer.iso'),
            '-map',
            str(staging / 'md5sum.txt'),
            '/md5sum.txt',
            '-map',
            str(grub),
            '/boot/grub/grub.cfg',
            '-map',
            str(staging / 'autoinstall.yaml'),
            '/autoinstall.yaml',
            '-map',
            str(staging / 'payload'),
            '/scx-payload.tar.gz',
            '-map',
            str(staging / 'scx-guest.json'),
            '/scx-guest.json',
            '-boot_image',
            'any',
            'replay',
        ],
        timeout=1800,
    )
    os.chmod(folder / 'installer.iso', 0o644)
    run(['qemu-img', 'create', '-f', 'qcow2', str(folder / 'disk.qcow2'), '80G'])
    xml = domain_xml(p, folder / 'installer.iso', folder / 'disk.qcow2')
    (folder / 'install.xml').write_text(xml)
    # Preflight proved this domain does not exist, so a folder here is what a removed computer left.
    runtime = RUNTIME / domain(p)
    if runtime.is_symlink():
        raise RuntimeError('Runtime directory must not be a symlink')
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    import pwd

    owner = pwd.getpwnam('libvirt-qemu')
    os.chown(runtime, owner.pw_uid, owner.pw_gid)
    runtime.chmod(0o700)
    virsh('define', str(folder / 'install.xml'))
    assert_identity(p)
    virsh('start', domain(p))


def qga(p, command):
    assert_identity(p)
    return json.loads(virsh('qemu-agent-command', domain(p), json.dumps(command)))['return']


def finish_install(p):
    assert_identity(p)
    if virsh('domstate', domain(p)).strip() != 'shut off':
        return False
    folder = ROOT / domain(p)
    root = ET.fromstring(virsh('dumpxml', domain(p), '--inactive'))
    osnode = root.find('os')
    for boot in list(osnode.findall('boot')):
        osnode.remove(boot)
    ET.SubElement(osnode, 'boot', {'dev': 'hd'})
    for disk in root.findall('./devices/disk'):
        # An unsafe cache only suited the install, which a host crash would simply repeat.
        if disk.find('driver') is not None:
            disk.find('driver').attrib.pop('cache', None)
        if disk.get('device') == 'cdrom':
            for source in list(disk.findall('source')):
                disk.remove(source)
    (folder / 'installed.xml').write_text(ET.tostring(root, encoding='unicode'))
    virsh('define', str(folder / 'installed.xml'))
    virsh('start', domain(p))
    return True


def publish(p):
    # Require installed guest marker, scope and worker readiness, not just a power state.
    result = qga(
        p,
        {
            'execute': 'guest-exec',
            'arguments': {
                'path': '/usr/bin/python3',
                'arg': [
                    '-I',
                    '-B',
                    '/opt/stellarcortex-worker/deployment/ubuntu-desktop/guest/firstboot-status.py',
                ],
                'capture-output': True,
            },
        },
    )
    return result['pid']


BROKER = '/etc/stellarcortex/desktop-broker.json'
PROVIDER = '/etc/stellarcortex/desktop-provider.json'


class FirstBootFailed(RuntimeError):
    pass


# Its marks stay, so first boot goes on from the step that stopped.
RESUME = 'rm -f /var/lib/stellarcortex-firstboot-failed; systemctl reset-failed stellarcortex-firstboot.service; systemctl start --no-block stellarcortex-firstboot.service'


def claim_environment(p):
    '''The first computer becomes the shared environment. It stays out of the bot records, because a computer
    cannot hold both plain and session records. Bots get a session only when the owner sets them to it.
    An older plain computer is kept and still boots, but its bots move to sessions on this one.'''
    import fcntl

    # Its own lock: run-approved may already hold the allocation lock while it calls this.
    with open(ROOT / 'provisioning' / '.environment.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        broker, provider = pathlib.Path(BROKER), pathlib.Path(PROVIDER)
        b, v = json.loads(broker.read_text()), json.loads(provider.read_text())
        policy = b.get('sessionProvisioning')
        mine = bool(policy) and policy.get('computer', {}).get('uuid') == p['uuid']
        if not mine and (policy or v.get('environmentComputer')):
            return False
        ids = {'accountId': p['accountId'], 'environmentId': domain(p), 'computerId': domain(p)}
        # Broker first: a crash between the two saves leaves this computer recognised on retry.
        # preservedComputers lets boot.py start it before any session record exists.
        if not policy:
            kept = b.setdefault('preservedComputers', [])
            kept += [r for r in b['desktops'] if r['uuid'] not in {k['uuid'] for k in kept}]
            b['desktops'] = []
            b['sessionProvisioning'] = {'approved': True, **ids, 'computer': {**record(p), **ids}}
            kept.append(record(p))
            save(broker, b, mode=broker.stat().st_mode & 0o777)
        if not v.get('environmentComputer'):
            v['records'] = []
            v['environmentComputer'] = {**ids, 'defaultAccess': True, 'overrides': {}}
            save(provider, v, mode=provider.stat().st_mode & 0o777)
        return True


def publish_result(p, pid):
    result = qga(p, {'execute': 'guest-exec-status', 'arguments': {'pid': pid}})
    if not result.get('exited'):
        return False
    if result.get('exitcode') != 0:
        raise RuntimeError('Installed worker marker absent; inspect installer before retry')
    observed = json.loads(base64.b64decode(result.get('out-data', '')))
    if not observed:
        return False
    if 'firstbootFailed' in observed:
        raise FirstBootFailed(
            'The computer could not finish its first boot, at: '
            + observed['firstbootFailed'].strip()
        )
    if observed != record(p):
        raise RuntimeError('Installed owner/generation mismatch')
    # Ubuntu Server has no base desktop to ask: tools start with each bot's session. The marker is the last step of first boot.
    if claim_environment(p):
        return True
    raise RuntimeError(
        'Another computer is already the shared one. Remove one of them with installer.py remove-computer.'
    )


class BuildError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


LEASE_WAIT = 900


def watch_lease(p, state):
    '''With no address the install only waits. A firewall that blocks DHCP looks like that for hours.
    The MAC is matched because a removed computer's lease stays listed for an hour.'''
    mac = re.search(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', virsh('domiflist', domain(p)))
    if mac and mac[0] in virsh('net-dhcp-leases', 'stellarcortex-desktops'):
        return {**state, 'leased': True}
    state = {**state, 'waitingSince': state.get('waitingSince', time.time())}
    if time.time() - state['waitingSince'] > LEASE_WAIT:
        virsh('destroy', domain(p))
        raise BuildError('network', 'The computer got no network address')
    return state


def advance(p, statefile):
    state = json.loads(statefile.read_text()) if statefile.exists() else {'stage': 'approved'}
    stage = state['stage']
    if state.get('planHash', plan_hash(p)) != plan_hash(p):
        raise RuntimeError('Provisioning state belongs to another plan; preserve it')
    if stage in ['ready', 'needs-attention']:
        return state
    if stage == 'applying':
        raise RuntimeError(
            'Interrupted installation stage; inspect durable evidence, no automatic replay'
        )
    if stage == 'approved':
        save(statefile, {'stage': 'applying', 'operation': 'prepare', 'planHash': plan_hash(p)})
        import fcntl

        with open(ROOT / 'provisioning' / '.allocation.lock', 'a') as allocation_lock:
            fcntl.flock(allocation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            prepare(p)
        state = {'stage': 'installing', 'planHash': plan_hash(p)}
    elif stage == 'installing':
        assert_identity(p)
        if virsh('domstate', domain(p)).strip() != 'shut off':
            if state.get('leased'):
                return state
            watched = watch_lease(p, state)
            if watched != state:
                save(statefile, watched)
            return watched
        save(
            statefile,
            {'stage': 'applying', 'operation': 'installed-boot', 'planHash': plan_hash(p)},
        )
        finish_install(p)
        state = {'stage': 'booting', 'planHash': plan_hash(p)}
    elif stage == 'resuming':
        if virsh('domstate', domain(p)).strip() != 'running':
            virsh('start', domain(p))
            return state
        try:
            qga(
                p,
                {'execute': 'guest-exec', 'arguments': {'path': '/bin/sh', 'arg': ['-c', RESUME]}},
            )
        except subprocess.CalledProcessError:
            return state
        state = {'stage': 'booting', 'planHash': plan_hash(p)}
    elif stage == 'booting':
        try:
            pid = publish(p)
        except subprocess.CalledProcessError:
            return state
        state = {'stage': 'verifying', 'pid': pid, 'planHash': plan_hash(p)}
    elif stage == 'verifying':
        if not publish_result(p, state['pid']):
            state = {'stage': 'booting', 'planHash': plan_hash(p)}
            save(statefile, state)
            return state
        state = {'stage': 'ready', 'planHash': plan_hash(p)}
    else:
        raise RuntimeError('Unknown installation state')
    save(statefile, state)
    return state


STAGES = {
    'approved': 'prepare',
    'applying': 'prepare',
    'installing': 'install',
    'resuming': 'first-boot',
    'booting': 'first-boot',
    'verifying': 'first-boot',
}
FAILURES = [
    ('browser-hash', 'pinned SHA-256'),
    ('memory', 'MiB is available'),
    ('disk', 'free for disk'),
    ('kvm', 'KVM'),
    ('iso', 'not Ubuntu Server|older than Ubuntu Server'),
    ('first-boot', 'first boot'),
    ('timeout', 'two hours'),
]


def failure_code(error):
    return getattr(error, 'code', None) or next(
        (code for code, pattern in FAILURES if re.search(pattern, str(error))), 'other'
    )


def boot_id():
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def report(stage, **values):
    '''The file the broker reads for Settings. Its process and boot show whether a running build is still alive.'''
    file = ROOT / 'provisioning' / 'build.json'
    file.with_name(file.name + '.tmp').unlink(missing_ok=True)
    save(
        file,
        {'stage': stage, 'pid': os.getpid(), 'bootId': boot_id(), 'at': int(time.time()), **values},
    )


def download(url, target, progress=lambda done, total: None, opener=urllib.request.urlopen):
    '''Goes on from a partial file. Only the hash checked afterwards decides whether the file is good.'''
    have = target.stat().st_size if target.exists() else 0
    try:
        response = opener(
            urllib.request.Request(
                url, headers={'Range': 'bytes=' + str(have) + '-'} if have else {}
            ),
            timeout=60,
        )
    except urllib.error.HTTPError as error:
        if error.code == 416:
            return
        raise
    with response:
        if have and response.status != 206:
            have = 0
        total = have + int(response.headers.get('Content-Length') or 0)
        with open(target, 'ab' if have else 'wb') as file:
            while chunk := response.read(1024 * 1024):
                file.write(chunk)
                have += len(chunk)
                progress(have, total)


def signed_iso(work, fetch=download, run=subprocess.run):
    '''The name and hash of the current ISO, from Ubuntu's hash list, which must carry the signature of the pinned key.'''
    home = work / 'gnupg'
    home.mkdir(mode=0o700, exist_ok=True)
    gpg = ['gpg', '--homedir', str(home), '--batch', '--no-tty']
    for name in ['SHA256SUMS', 'SHA256SUMS.gpg']:
        (work / name).unlink(missing_ok=True)
        fetch(ISO_HOME + name, work / name)
    run(
        gpg + ['--keyserver', 'hkps://keyserver.ubuntu.com', '--recv-keys', UBUNTU_KEY],
        capture_output=True,
        text=True,
        timeout=120,
    )
    # The list can carry a second signature of a key not fetched here, so only this key's result counts.
    status = run(
        gpg
        + ['--status-fd', '1', '--verify', str(work / 'SHA256SUMS.gpg'), str(work / 'SHA256SUMS')],
        capture_output=True,
        text=True,
        timeout=60,
    ).stdout
    if not re.search(r'^\[GNUPG:\] VALIDSIG .* ' + UBUNTU_KEY + r'$', status, re.M):
        raise BuildError('signature', 'The signature on Ubuntu\'s hash list could not be verified')
    found = re.findall(
        r'^([a-f0-9]{64}) [ *](ubuntu-[0-9.]+-live-server-amd64\.iso)$',
        (work / 'SHA256SUMS').read_text(),
        re.M,
    )
    if not found:
        raise BuildError('download', 'Ubuntu\'s hash list names no Server ISO')
    return found[-1]


def ensure_iso(policy, signed=signed_iso, fetch=download, say=report):
    '''An ISO the owner gave is already in place and pinned. Otherwise this downloads it, and checks it against the signed list.'''
    target = pathlib.Path(policy['iso'])
    if policy.get('isoSha256'):
        return
    work = target.parent / 'download'
    work.mkdir(mode=0o700, exist_ok=True)
    try:
        sha, name = signed(work)
    except (urllib.error.URLError, OSError, subprocess.SubprocessError) as error:
        raise BuildError('download', str(error))
    if target.is_file() and digest(target) == sha:
        return
    part = work / name
    last = [0]

    def progress(done, total):
        if total and time.monotonic() - last[0] > 2:
            last[0] = time.monotonic()
            say('download', percent=done * 100 // total)

    try:
        fetch(ISO_HOME + name, part, progress)
    except (urllib.error.URLError, OSError) as error:
        raise BuildError('download', str(error))
    if digest(part) != sha:
        part.unlink()
        raise BuildError('download', 'The downloaded ISO does not match Ubuntu\'s signed hash list')
    os.chmod(part, 0o600)
    os.replace(part, target)


def drive(p, statefile, say=lambda state: None, sleep=time.sleep):
    import fcntl

    with open(ROOT / 'provisioning' / (p['vmId'] + '.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            deadline = time.monotonic() + 7200
            while True:
                state = advance(p, statefile)
                print(json.dumps(state), flush=True)
                say(state)
                if state['stage'] in ['ready', 'needs-attention']:
                    return state
                if time.monotonic() > deadline:
                    raise RuntimeError(
                        'Installation exceeded two hours; inspect preserved state, no automatic retry'
                    )
                sleep(5)
        except Exception as error:
            state = json.loads(statefile.read_text()) if statefile.exists() else {}
            save(
                statefile,
                {
                    **state,
                    'stage': 'needs-attention',
                    'message': type(error).__name__ + ': ' + str(error)[:300],
                    'resume': isinstance(error, FirstBootFailed),
                },
            )
            raise


def trusted_config():
    config = pathlib.Path(BROKER)
    st = config.lstat()
    if config.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Trusted capacity policy required')
    return config


def build(mode):
    '''From nothing to the ready computer. Only this can install one: bots and sessions cannot reach it.'''
    if os.geteuid() != 0:
        raise RuntimeError('Root build service required')
    import fcntl

    os.umask(0o077)
    directory = ROOT / 'provisioning'
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / '.build.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return
        try:
            config = trusted_config()
            cfg = json.loads(config.read_text())
            if cfg.get('sessionProvisioning'):
                report('ready')
                return
            # The computer never held a session, so a failed try has nothing to keep, unless only its first boot stopped.
            resuming = False
            if mode == 'retry':
                for row in cfg.get('provisioningAllocations', []):
                    if row['botId'] != ENVIRONMENT_BOT:
                        continue
                    file = directory / (row['vmId'] + '.state.json')
                    state = json.loads(file.read_text()) if file.exists() else {}
                    if state.get('resume'):
                        save(file, {'stage': 'resuming', 'planHash': state['planHash']})
                        resuming = True
                    else:
                        remove_computer(row['vmId'], 'scx-desktop-' + row['vmId'])
                cfg = json.loads(config.read_text())
            # A resumed first boot keeps the computer, so it needs no ISO.
            if not resuming:
                report('download', percent=0)
                ensure_iso(cfg['provisioningPolicy'])
            report('prepare')
            row = allocate(cfg, ENVIRONMENT_BOT, directory)
            save(config, cfg)
            file = directory / (row['vmId'] + '.plan.json')
            p = validate(json.loads(file.read_text()))
            if plan_hash(p) != row['planHash']:
                raise RuntimeError('Approved plan hash changed')
            state = drive(
                p,
                file.with_name(p['vmId'] + '.state.json'),
                lambda state: report(STAGES.get(state['stage'], 'prepare')),
            )
            if state['stage'] != 'ready':
                raise RuntimeError(state.get('message') or 'The computer needs attention')
            report('ready')
        except Exception as error:
            report('failed', code=failure_code(error), message=str(error)[:300])
            raise


def allocate(config, bot, directory):
    policy = config.get('provisioningPolicy', {})
    if (
        policy.get('approved') is not True
        or not valid_id(bot)
        or not valid_id(policy.get('accountId'))
    ):
        raise RuntimeError('Automatic computer allocation is not approved')
    # One computer holds every bot. A bot that arrives while it installs waits for it, then gets a session.
    rows = config.setdefault('provisioningAllocations', [])
    existing = next((r for r in rows if r['accountId'] == policy['accountId']), None)
    if existing:
        return existing
    used = {r['vmId'] for r in config['desktops'] + rows + config.get('preservedComputers', [])}
    vm = next((v for v in policy.get('vmIds', []) if v not in used), None)
    if vm is None:
        raise RuntimeError(
            'No free computer number. Remove an old computer with installer.py remove-computer, then try again.'
        )
    p = create_plan(
        policy['accountId'],
        bot,
        vm,
        policy['iso'],
        policy['payload'],
        policy.get('isoSha256'),
        policy.get('memoryMiB', 8192),
        policy.get('vcpus', 4),
    )
    if (
        p['payloadSha256'] != policy.get('payloadSha256')
        or policy.get('disableGuestIdleLock') is not True
    ):
        raise RuntimeError('Approved allocation payload or guest policy changed')
    target = directory / (vm + '.plan.json')
    if target.exists():
        raise RuntimeError('Unregistered plan exists; inspect without replacing it')
    save(target, p)
    row = {k: p[k] for k in ['accountId', 'botId', 'vmId']}
    row.update(approved=True, planHash=plan_hash(p))
    rows.append(row)
    config.get('allocationResults', {}).pop(bot, None)
    return row


def remove_computer(vm, confirm):
    '''Deletes one computer, its disk and every record of it, so that it can be installed again.'''
    name = 'scx-desktop-' + vm
    if not re.fullmatch(r'[0-9]{2,3}', vm) or confirm != name:
        raise RuntimeError(
            'This deletes the computer and its disk. Repeat its name with --confirm-delete ' + name
        )
    if name in virsh('list', '--all', '--name').split():
        if virsh('domstate', name).strip() != 'shut off':
            virsh('destroy', name)
        virsh('undefine', name, '--nvram')
    for folder in [ROOT / name, RUNTIME / name]:
        if folder.is_symlink():
            folder.unlink()
        elif folder.exists():
            shutil.rmtree(folder)
    for suffix in ['.plan.json', '.state.json', '.lock']:
        (ROOT / 'provisioning' / (vm + suffix)).unlink(missing_ok=True)
    broker, provider = pathlib.Path(BROKER), pathlib.Path(PROVIDER)
    b, v = json.loads(broker.read_text()), json.loads(provider.read_text())
    for bot in {r['botId'] for r in b['desktops'] if r['vmId'] == vm}:
        (ROOT / 'sessions' / (bot + '.json')).unlink(missing_ok=True)
    for key in ['desktops', 'provisioningAllocations', 'preservedComputers']:
        b[key] = [r for r in b.get(key, []) if r['vmId'] != vm]
    b['allocationResults'] = {}
    v['records'] = [r for r in v['records'] if r['vmId'] != vm]
    if b.get('sessionProvisioning', {}).get('computerId') == name:
        del b['sessionProvisioning']
    if v.get('environmentComputer', {}).get('computerId') == name:
        del v['environmentComputer']
    save(broker, b, mode=broker.stat().st_mode & 0o777)
    save(provider, v, mode=provider.stat().st_mode & 0o777)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    plan = sub.add_parser('plan')
    for arg in ['account-id', 'bot-id', 'vm-id', 'iso', 'payload', 'output']:
        plan.add_argument('--' + arg, required=True)
    apply = sub.add_parser('advance')
    apply.add_argument('--plan', required=True)
    apply.add_argument('--approved-hash', required=True)
    builder = sub.add_parser('build')
    builder.add_argument('mode', choices=['start', 'retry'])
    remover = sub.add_parser('remove-computer')
    remover.add_argument('--vm-id', required=True)
    remover.add_argument('--confirm-delete', default='')
    args = parser.parse_args()
    if args.command == 'remove-computer':
        if os.geteuid() != 0:
            raise RuntimeError('Run this as root')
        remove_computer(args.vm_id, args.confirm_delete)
        subprocess.run(
            ['systemctl', 'try-restart', 'stellarcortex-desktop-broker.service'], check=True
        )
        return
    if args.command == 'build':
        build(args.mode)
        return
    if args.command == 'plan':
        p = create_plan(args.account_id, args.bot_id, args.vm_id, args.iso, args.payload)
        target = pathlib.Path(args.output)
        if target.exists():
            raise RuntimeError('Plan already exists; preserve its identity')
        save(target, p)
        print(json.dumps({'planHash': plan_hash(p), 'plan': p}, indent=2))
        return
    if os.geteuid() != 0:
        raise RuntimeError('Approved root deployment workflow required')
    os.umask(0o077)
    file = pathlib.Path(args.plan)
    st = file.lstat()
    if not file.is_file() or file.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Root-owned immutable plan required')
    p = validate(json.loads(file.read_text()))
    if args.approved_hash != plan_hash(p):
        raise RuntimeError('Approved plan hash changed')
    expected = ROOT / 'provisioning' / (p['vmId'] + '.plan.json')
    if file != expected:
        raise RuntimeError('Plan outside fixed provisioning directory')
    print(json.dumps(advance(p, file.with_name(p['vmId'] + '.state.json'))), flush=True)


if __name__ == '__main__':
    main()
