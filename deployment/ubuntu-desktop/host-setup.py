#!/usr/bin/python3
"""Render a reviewable portable host installation bundle. Does not apply it.
No sudo/group grant, credential, firewall edit or service activation is performed.
The generated script requires an explicit approval hash at execution time.
"""

import argparse, hashlib, io, json, os, pathlib, platform, re, shlex, shutil, stat, subprocess, sys, tarfile

HERE = pathlib.Path(__file__).resolve().parent
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


def owner_home(uid):
    import pwd

    return pwd.getpwuid(uid).pw_dir


def owner_name(uid):
    import pwd

    return pwd.getpwuid(uid).pw_name


def user_unit_active(service, app_uid, run, name):
    try:
        return (
            run(
                [
                    '/usr/bin/systemctl',
                    '--user',
                    '--machine=' + name(app_uid) + '@.host',
                    'is-active',
                    service,
                ],
                text=True,
                timeout=30,
            ).strip()
            == 'active'
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def app_service_settings(
    service, app_uid, run=subprocess.check_output, home=owner_home, name=owner_name
):
    '''Whether the app is a user service, as bash install.sh --service makes it, and its settings. A user unit's settings are read from its files, so root needs no session of that user.'''
    shown = run(
        [
            '/usr/bin/systemctl',
            'show',
            service,
            '--property=LoadState,ActiveState,Environment,EnvironmentFiles,ExecStart',
        ],
        text=True,
        timeout=30,
    )
    unit = pathlib.Path(home(app_uid)) / '.config/systemd/user' / service
    if 'LoadState=not-found' not in shown:
        if not unit.is_file():
            return False, shown
        # A service moved from one kind to the other can leave both. Only the one running has the right settings.
        system = bool(re.search(r'^ActiveState=(active|activating)$', shown, re.M))
        if system == user_unit_active(service, app_uid, run, name):
            raise ValueError(
                'A system service and a user service named '
                + service
                + ' both exist, and '
                + ('both are' if system else 'neither is')
                + ' running. Keep the one you use running and stop the other, then run this again.'
            )
        if system:
            return False, shown
    if not unit.is_file():
        raise ValueError(
            'No service named '
            + service
            + ' on this host, and no user service at '
            + str(unit)
            + '. Run bash install.sh --service as the app user, or give the right --app-service and --app-uid.'
        )
    return True, '\n'.join(
        file.read_text() for file in [unit] + sorted(unit.parent.glob(service + '.d/*.conf'))
    ).replace('%h', home(app_uid))


def app_data_dir(shown, app_uid, home=owner_home, read=lambda name: pathlib.Path(name).read_text()):
    '''The service's own setting, else the app's default under its owner's home. An unreadable file stops here, not at a wrong guess.'''
    path = r'["\']?(/[A-Za-z0-9._/-]+)'
    argument = re.search(r'--data-dir[ =]' + path, shown)
    if argument:
        return argument.group(1)
    found = re.findall(r'[=\s"\']STELLARCORTEX_DATA_DIR=' + path, shown)
    for name in re.findall(r'^EnvironmentFiles?=-?(/\S+)', shown, re.M):
        try:
            found += re.findall(r'^\s*STELLARCORTEX_DATA_DIR=' + path, read(name), re.M)
        except FileNotFoundError:
            pass
    return found[-1] if found else home(app_uid) + '/.stellarcortex'


MEDIA = '/var/lib/stellarcortex/desktops/media'
RUNNERS = '/opt/stellarcortex-runners'
SOURCES = ['src', 'scripts', 'deployment/ubuntu-desktop']
NPM_INPUTS = ['package.json', 'package-lock.json', '.npmrc']


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def account_id(data_dir):
    '''The owner identity the app derives from its access key, so nobody has to work it out by hand.'''
    saved = pathlib.Path(data_dir) / 'owner-account'
    if saved.is_file():
        return saved.read_text().strip()
    file = pathlib.Path(data_dir) / 'access-key'
    if not file.is_file():
        raise ValueError(
            'No access key in '
            + str(data_dir)
            + '. Start StellarCortex once so that it creates one, or give --account-id.'
        )
    return hashlib.sha256(('android-owner-v1:' + file.read_text().strip()).encode()).hexdigest()


def check_source(source, app_uid, read=lambda path: path.lstat()):
    '''Root runs what this packs, and a host-mode bot runs as the app user, so that user must not be able to change any of it.'''
    for path in (
        [source]
        + [source / name for name in NPM_INPUTS if os.path.lexists(source / name)]
        + [item for root in SOURCES for item in (source / root).rglob('*')]
    ):
        info = read(path)
        if info.st_uid == app_uid or (not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022):
            raise ValueError(
                'Root would run files others can change: '
                + str(path)
                + '. Render as root, from a root-owned clone, not from the running checkout.'
            )


def runner_files(source, machine, libc):
    '''npm installs the glibc and the musl Claude side by side, so the name comes from this machine, not from what is on disk.'''
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(machine)
    if not arch:
        raise ValueError('There is no Claude or Codex program for this machine: ' + machine)
    claude = (
        source
        / 'node_modules/@anthropic-ai'
        / ('claude-code-linux-' + arch + ('' if libc == 'glibc' else '-musl'))
        / 'claude'
    )
    if not claude.is_file():
        raise ValueError('npm ci did not install ' + str(claude))
    codex = sorted(source.glob('node_modules/@openai/codex-linux-' + arch + '/vendor/*/bin/codex'))
    if len(codex) != 1:
        raise ValueError('Expected one codex program for this machine, found ' + str(len(codex)))
    return claude, codex[0].parents[1]


def prepare_runners(
    source,
    app_uid,
    run=subprocess.run,
    machine=platform.machine(),
    libc=platform.libc_ver()[0],
    which=shutil.which,
):
    '''npm ci checks every package against the lockfile, so nothing here comes from a folder the app user can change.'''
    check_source(source, app_uid)
    # sudo often leaves /usr/local/bin out of PATH, and a Node.js install often puts npm there.
    path = os.environ.get('PATH', '') + os.pathsep + '/usr/local/bin'
    npm = which('npm', path=path)
    if not npm or not which('node', path=path):
        raise ValueError(
            'npm or node was not found in PATH or /usr/local/bin. Install Node.js and npm for root, or render with: sudo env "PATH=/folder/of/npm:$PATH" bash install.sh --desktop-host-bundle ...'
        )
    env = {**os.environ, 'PATH': path}
    run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=source, check=True, env=env)
    claude, codex = runner_files(source, machine, libc)
    return {'claude': claude, 'codex': codex, 'policySha256': codex_policy(source, env)}


def codex_policy(source, env=None):
    code = "import {createHash} from 'node:crypto';const {CODEX_GUEST_CONFIG}=await import(process.argv[1]);process.stdout.write(createHash('sha256').update(JSON.stringify(CODEX_GUEST_CONFIG)).digest('hex'))"
    return subprocess.check_output(
        [
            'node',
            '--input-type=module',
            '-e',
            code,
            (source / 'src' / 'codex-guest-policy.mjs').as_uri(),
        ],
        text=True,
        timeout=60,
        env=env,
    )


RESERVE = 6144


def computer_size(total, cpus, memory=None, vcpus=None):
    '''All bots share this computer, so it gets half of the host or 8 GiB, whichever is more, within what the host can spare. installer.py checks free memory against this size when the build starts.'''
    memory = memory or min((total - RESERVE) // 1024 * 1024, max(total // 2 // 1024 * 1024, 8192))
    vcpus = vcpus or max(2, cpus // 2)
    if memory < 4096 or memory + RESERVE > total:
        raise ValueError(
            'This host has '
            + str(total)
            + ' MiB of memory. The computer needs at least 4096 MiB, and the host keeps '
            + str(RESERVE)
            + ' MiB. Choose a value with --vm-memory-mib, or use a larger host.'
        )
    if vcpus < 2 or vcpus > cpus:
        raise ValueError(
            'This host has '
            + str(cpus)
            + ' CPUs. Choose 2 or more, up to that number, with --vm-vcpus.'
        )
    return memory, vcpus


def host_memory(read=lambda: pathlib.Path('/proc/meminfo').read_text()):
    return int(re.search(r'^MemTotal:\s+(\d+) kB', read(), re.M).group(1)) // 1024


def merge_config(broker, provider, new_broker, new_provider):
    '''An upgrade keeps every registration and the owner's choices, and replaces only the install-time values.'''
    account = new_broker['provisioningPolicy']['accountId']
    if broker.get('appUid') != new_broker['appUid']:
        raise ValueError(
            'This bundle was made for another app user. Render it again with the right --app-uid.'
        )
    if any(
        r.get('accountId') != account
        for r in broker.get('desktops', []) + provider.get('records', [])
    ):
        raise ValueError(
            'The computers here belong to another owner. Render the bundle with their --account-id.'
        )
    return {
        **broker,
        'provisioningPolicy': new_broker['provisioningPolicy'],
        'allocationResults': {},
    }, {**provider, 'dataDir': new_provider['dataDir']}


def merge_isolation(old, new):
    '''The pins come from the bundle. Every other provider entry stays as the owner set it.'''
    pins = {name: value for name, value in new['providers'].items() if name in ['claude', 'codex']}
    return {**new, 'providers': {**new['providers'], **old.get('providers', {}), **pins}}


def merge_files(bundle, live):
    read = lambda file: json.loads(file.read_text())

    def write(file, value, mode):
        temp = file.with_name(file.name + '.tmp')
        temp.write_text(json.dumps(value, indent=2))
        temp.chmod(mode)
        os.replace(temp, file)

    pairs = [live / 'desktop-broker.json', live / 'desktop-provider.json']
    for file, value in zip(
        pairs,
        merge_config(
            read(pairs[0]),
            read(pairs[1]),
            read(bundle / 'desktop-broker.json'),
            read(bundle / 'desktop-provider.json'),
        ),
    ):
        write(file, value, file.stat().st_mode & 0o777)
    isolation = live / 'desktop-isolation.json'
    write(
        isolation,
        merge_isolation(
            read(isolation) if isolation.exists() else {}, read(bundle / isolation.name)
        ),
        0o644,
    )


def render(
    source,
    output,
    app_uid,
    account,
    app_service,
    data_dir,
    iso,
    runners=None,
    size=(8192, 4),
    user_service=False,
):
    if not re.fullmatch(r'/[A-Za-z0-9._/-]+', data_dir):
        raise ValueError('Absolute application data folder required')
    if not re.fullmatch(r'[a-f0-9]{64}', account) or not isinstance(app_uid, int) or app_uid < 1000:
        raise ValueError('Actual app account digest and unprivileged UID required')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+\.service', app_service):
        raise ValueError('Existing application service name required')
    if iso and not iso.is_file():
        raise ValueError('--iso must be the path of a verified Ubuntu Server ISO file: ' + str(iso))
    if output.exists():
        raise ValueError('New bundle directory required; preserve previous approval')
    check_source(source, app_uid)
    output.mkdir(mode=0o700, parents=True)
    files = {}
    snapshot = io.BytesIO()
    with tarfile.open(fileobj=snapshot, mode='w:gz') as archive:
        for root in SOURCES:
            for item in sorted((source / root).rglob('*')):
                if (
                    item.is_symlink()
                    or item.name
                    in ['__pycache__', 'node_modules', 'private', 'auth.json', 'state.json']
                    or item.suffix in ['.pyc', '.key', '.p12', '.pem', '.log']
                ):
                    raise ValueError('Private or linked runtime input: ' + str(item))
                if item.is_file():
                    archive.add(item, arcname=str(item.relative_to(source)), recursive=False)
        # The guest installs its dependencies from these on first boot.
        for name in ['package.json', 'package-lock.json']:
            if not (source / name).is_file():
                raise ValueError('The source has no ' + name)
            archive.add(source / name, arcname=name, recursive=False)
    files['runtime.tar.gz'] = snapshot.getvalue()
    broker = (
        (HERE / 'broker.service')
        .read_text()
        .replace(' stellarcortex-desktop-network-coexistence.service', '')
    )
    broker = broker.replace(
        'After=libvirtd.service stellarcortex-desktop-network-guard.service',
        'After=libvirtd.service stellarcortex-desktop-network-guard.service stellarcortex-desktop-boot.service',
    )
    files['stellarcortex-desktop-broker.service'] = broker
    # A host with the firewall unit keeps it in the order. Not a .service file, so a fresh install skips it.
    files['network-coexistence.py'] = (HERE / 'network-coexistence.py').read_text()
    files['network-coexistence.unit'] = (HERE / 'network-coexistence.service').read_text()
    files['broker-coexistence.unit'] = (
        (HERE / 'broker.service')
        .read_text()
        .replace(
            'stellarcortex-desktop-network-coexistence.service\n[Service]',
            'stellarcortex-desktop-network-coexistence.service stellarcortex-desktop-boot.service\n[Service]',
        )
    )
    files['stellarcortex-computer-build@.service'] = (HERE / 'computer-build@.service').read_text()
    files['stellarcortex-computer-start.service'] = (HERE / 'computer-start.service').read_text()
    files['stellarcortex-kit-update@.service'] = (HERE / 'kit-update@.service').read_text()
    files['stellarcortex-session-provision@.service'] = (
        HERE / 'session-provision@.service'
    ).read_text()
    files['stellarcortex-session-remove@.service'] = (HERE / 'session-remove@.service').read_text()
    files['stellarcortex-desktop-boot.service'] = (HERE / 'boot.service').read_text()
    files['stellarcortex-desktop-network-guard.service'] = (
        HERE / 'network-guard.service'
    ).read_text()
    for suffix in ['service', 'timer']:
        files['stellarcortex-desktop-guard-check.' + suffix] = (
            HERE / ('network-guard-check.' + suffix)
        ).read_text()
    files['desktop-network-guard.nft'] = (HERE / 'network-guard.nft').read_text()
    files['desktop-network-guard-reload.nft'] = (HERE / 'network-guard-reload.nft').read_text()
    files['network.xml'] = (HERE / 'network.xml').read_text()
    providers = {name: {'enabled': True} for name in ['openai-api', 'anthropic-api', 'local']}
    if runners:
        # Codex keeps its folder, because its program looks for helpers next to it.
        pack = io.BytesIO()
        with tarfile.open(fileobj=pack, mode='w:gz') as archive:
            archive.add(runners['claude'], arcname='claude')
            archive.add(runners['codex'], arcname='codex')
        files['runners.tar.gz'] = pack.getvalue()
        providers['claude'] = {
            'enabled': True,
            'executable': RUNNERS + '/claude',
            'sha256': digest(runners['claude']),
        }
        providers['codex'] = {
            'enabled': True,
            'executable': RUNNERS + '/codex/bin/codex',
            'sha256': digest(runners['codex'] / 'bin' / 'codex'),
            'policySha256': runners['policySha256'],
        }
    # A user service cannot be ordered after a system one, and it finds the broker when it first needs it.
    if not user_service:
        files['app-desktop-order.conf'] = (
            '[Unit]\nWants=stellarcortex-desktop-broker.service\nAfter=stellarcortex-desktop-broker.service\n'
        )
    # With no ISO given, the build downloads one and checks it against Ubuntu's signed list.
    iso_sha = digest(iso) if iso else None
    policy = {
        'approved': True,
        'accountId': account,
        'vmIds': ['0' + str(number) for number in range(2, 10)],
        'memoryMiB': size[0],
        'vcpus': size[1],
        'iso': MEDIA + '/server.iso',
        'isoSha256': iso_sha,
        'payload': MEDIA + '/guest-payload.tar.gz',
        'payloadSha256': hashlib.sha256(snapshot.getvalue()).hexdigest(),
        'disableGuestIdleLock': True,
    }
    files['desktop-broker.json'] = json.dumps(
        {
            'approved': True,
            'appUid': app_uid,
            'bootApproved': True,
            'desktops': [],
            'provisioningAllocations': [],
            'provisioningPolicy': policy,
        },
        indent=2,
    )
    files['desktop-isolation.json'] = json.dumps({'version': 1, 'providers': providers}, indent=2)
    files['desktop-provider.json'] = json.dumps(
        {
            'enabled': True,
            'provider': 'qemu-kvm-ubuntu-desktop',
            'brokerSocket': '/run/stellarcortex-desktop-broker/broker.sock',
            'lifecycleApproved': False,
            'dataDir': data_dir,
            'records': [],
        },
        indent=2,
    )
    manifest = {
        'schemaVersion': 1,
        'source': str(source),
        'accountId': account,
        'appUid': app_uid,
        'appService': app_service,
        'packages': PACKAGES,
        'iso': {
            'source': str(iso) if iso else 'downloaded and verified by the build',
            'sha256': iso_sha,
        },
        'network': '192.168.153.0/24 NAT via virbr-scx; no public ingress',
        'bootPolicy': 'The computer starts after a host reboot, once the network guard is up. Change this in Settings > Computer.',
        'files': {
            k: hashlib.sha256(v.encode() if isinstance(v, str) else v).hexdigest()
            for k, v in files.items()
        },
    }
    manifest_digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    for name, content in files.items():
        (output / name).write_bytes(content.encode() if isinstance(content, str) else content)
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (output / 'APPROVAL-SHA256').write_text(manifest_digest + '\n')
    # No shell expansion of caller paths. The source archive must be the reviewed
    # distribution, not arbitrary mutable user files copied by a privileged broker.
    head = '''#!/bin/bash
set -euo pipefail
PATH=$PATH:/usr/local/bin
[ "$(id -u)" = 0 ]
cd -- "$(dirname -- "$0")"
[ "${1:-}" = "HASH" ] || { echo 'Exact reviewed bundle hash required'; exit 1; }
# Root runs these files, so nobody else may be able to change them or the folders above them.
[ -z "$(find . \\( ! -uid 0 -o -perm /022 \\) -print -quit)" ] || { echo 'The bundle must be root-owned and not writable by group or others. Render it as root.'; exit 1; }
folder=$PWD
while [ "$folder" != / ]; do
 [ "$(stat -c %u "$folder")" = 0 ] && { [ -k "$folder" ] || [ -z "$(find "$folder" -maxdepth 0 -perm /022)" ]; } || { echo "Others can change this folder: $folder. Keep the bundle under a root-only folder."; exit 1; }
 folder=$(dirname "$folder")
done
python3 - <<'CHECK'
import hashlib,json,pathlib
p=json.loads(pathlib.Path('manifest.json').read_text())
assert hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest()=='HASH'
for name,h in p['files'].items():
 f=pathlib.Path(name);assert not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==h
CHECK
'''
    media = (
        (
            ''
            if not iso
            else '''# The ISO is copied once. A later upgrade with the same file reuses it.
if ! printf '%s  %s\\n' ISOSHA MEDIA/server.iso | sha256sum -c --status 2>/dev/null; then
 [ -f ISOFILE ] || { echo 'The ISO named when this bundle was made is gone: 'ISOFILE; exit 1; }
 install -m 600 ISOFILE MEDIA/server.iso
 printf '%s  %s\\n' ISOSHA MEDIA/server.iso | sha256sum -c --status || { echo 'The ISO changed after this bundle was made. Render a new bundle.'; exit 1; }
fi
'''
        )
        + '''install -m 600 runtime.tar.gz MEDIA/guest-payload.tar.gz
'''
    )
    pins = '''# The model programs run on the host as the app user, from a copy that user cannot change.
if [ -e runners.tar.gz ]; then
 rm -rf RUNNERS.next; install -d -m 755 RUNNERS.next
 tar -xzf runners.tar.gz --no-same-owner -C RUNNERS.next
 chown -R root:root RUNNERS.next; chmod -R 755 RUNNERS.next
 rm -rf RUNNERS; mv RUNNERS.next RUNNERS
fi
'''
    order = (
        ''
        if user_service
        else '''install -d -m 755 /etc/systemd/system/APP_SERVICE.d
install -m 644 app-desktop-order.conf /etc/systemd/system/APP_SERVICE.d/80-desktop-order.conf
'''
    )
    # Nothing else starts the broker for a user service until the next reboot.
    start = 'systemctl start stellarcortex-desktop-broker.service\n' if user_service else ''
    start += 'systemctl start --no-block stellarcortex-computer-build@start.service\n'
    restart = (
        '. As the app user: systemctl --user restart APP_SERVICE'
        if user_service
        else ': systemctl restart APP_SERVICE'
    )
    script = (
        head
        + '''[ ! -e /etc/stellarcortex/desktop-broker.json ] || { echo 'Existing deployment: run upgrade-approved.sh instead.'; exit 1; }
command -v node >/dev/null || { echo 'Install the application Node runtime first'; exit 1; }
[ -e /dev/kvm ] || { echo 'KVM unavailable'; exit 1; }
# A host firewall is the owner's: nothing changes until the owner has said yes.
firewall=
if [ "${2:-}" = --firewall-reviewed ]; then
 firewall=reviewed
elif command -v nft >/dev/null; then
 code=0
 found=$(python3 -I -B network-coexistence.py --check) || code=$?
 if [ "$code" = 10 ]; then
  echo "Existing firewall detected ($found), so nothing was changed."
  echo 'The computer needs DHCP, DNS and outbound traffic on virbr-scx (192.168.153.0/24).'
  echo 'To add rules for that bridge only, run this script again with --firewall-reviewed after the hash.'
  exit 1
 elif [ "$code" != 0 ]; then
  exit 6
 fi
fi
apt-get update
apt-get install -y PACKAGES
install -d -m 755 /opt/stellarcortex-desktop-broker /etc/stellarcortex /run/stellarcortex-desktops
install -d -m 711 /var/lib/stellarcortex/desktops
install -d -m 700 /var/lib/stellarcortex/desktops/provisioning MEDIA
'''
        + media
        + '''# Copy only the explicit runtime allowlist; no home directories or credentials.
tar -xzf runtime.tar.gz -C /opt/stellarcortex-desktop-broker
chown -R root:root /opt/stellarcortex-desktop-broker
chmod -R go-w /opt/stellarcortex-desktop-broker
'''
        + pins
        + '''install -m 644 desktop-isolation.json /etc/stellarcortex/
install -m 644 desktop-network-guard.nft desktop-network-guard-reload.nft /etc/stellarcortex/
install -m 644 ./*.service ./*.timer /etc/systemd/system/
coexistence=
if [ -n "$firewall" ]; then
 coexistence=yes
 install -m 644 network-coexistence.py /etc/stellarcortex/desktop-network-coexistence.py
 install -m 644 network-coexistence.unit /etc/systemd/system/stellarcortex-desktop-network-coexistence.service
 install -m 644 broker-coexistence.unit /etc/systemd/system/stellarcortex-desktop-broker.service
fi
'''
        + order
        + '''systemctl daemon-reload
systemctl start stellarcortex-desktop-network-guard.service libvirtd.service
# A run that stopped partway left this network behind, so it is reused if it is the same one.
network=$(virsh --connect qemu:///system net-dumpxml stellarcortex-desktops 2>/dev/null) || network=
if [ -z "$network" ]; then
 virsh --connect qemu:///system net-define network.xml
elif ! grep -q "<bridge name='virbr-scx'" <<<"$network" || ! grep -q "<forward mode='nat'" <<<"$network" || ! grep -q "<ip address='192.168.153.1'" <<<"$network"; then
 echo 'A libvirt network named stellarcortex-desktops has other settings. Review it, remove it with virsh net-undefine, and run this again.'; exit 1
fi
[[ "$(virsh --connect qemu:///system net-info stellarcortex-desktops)" =~ Active:[[:space:]]+yes ]] || virsh --connect qemu:///system net-start stellarcortex-desktops
if [ -n "$coexistence" ]; then
 systemctl enable stellarcortex-desktop-network-coexistence.service
 systemctl start stellarcortex-desktop-network-coexistence.service || {
  echo 'The firewall rules for the computer could not be added, so the computer is not ready. Chat still works.'
  echo 'See why: systemctl status stellarcortex-desktop-network-coexistence.service. Then run the install again.'
  exit 6
 }
fi
systemctl enable libvirtd.service stellarcortex-desktop-network-guard.service stellarcortex-desktop-boot.service stellarcortex-desktop-broker.service
systemctl enable stellarcortex-desktop-guard-check.timer
systemctl start stellarcortex-desktop-guard-check.timer
# Written last. desktop-broker.json marks a finished install, so a run that stopped earlier can run again.
install -m 644 desktop-provider.json /etc/stellarcortex/
install -m 600 desktop-broker.json /etc/stellarcortex/
'''
        + start
        + '''printf 'Host prepared, and the computer is building in the background. Follow it in Settings > Computer. It will come back after a reboot; you can change that there.\n'
[ -n "${STELLARCORTEX_APP_RESTARTS:-}" ] || printf 'Restart the app so that it reads these settings'''
        + restart
        + '''\n'
'''
    )
    upgrade = (
        head
        + '''[ -e /etc/stellarcortex/desktop-broker.json ] || { echo 'No deployment here: run install-approved.sh instead.'; exit 1; }
busy=$(systemctl list-units --no-legend --state=active,activating 'stellarcortex-computer-build@*' 'stellarcortex-computer-start.service' 'stellarcortex-session-provision@*' 'stellarcortex-session-remove@*')
if [ -n "$busy" ]; then
 echo 'A computer is being prepared. Run this again when it finishes.'; exit 1
fi
live=/opt/stellarcortex-desktop-broker; next=$live.next
backup=/var/lib/stellarcortex/desktops/backups/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 /var/lib/stellarcortex/desktops/backups "$backup" MEDIA
cp -a /etc/stellarcortex/desktop-broker.json /etc/stellarcortex/desktop-provider.json /etc/systemd/system/stellarcortex-*.service "$backup"/
[ ! -e /etc/stellarcortex/desktop-isolation.json ] || cp -a /etc/stellarcortex/desktop-isolation.json "$backup"/
tar -czf "$backup/runtime.tar.gz" -C "$live" .
[ ! -d RUNNERS ] || tar -czf "$backup/runners.tar.gz" -C RUNNERS .
# From here a failure puts the previous version back, so an update from Settings cannot leave a half-changed host.
restore(){
 trap - ERR
 systemctl stop stellarcortex-desktop-broker.service || true
 rm -rf "$live" "$next"; install -d -m 755 "$live"; tar -xzf "$backup/runtime.tar.gz" -C "$live"
 if [ -e "$backup/runners.tar.gz" ]; then rm -rf RUNNERS; install -d -m 755 RUNNERS; tar -xzf "$backup/runners.tar.gz" -C RUNNERS; fi
 cp -a "$backup"/desktop-broker.json "$backup"/desktop-provider.json /etc/stellarcortex/
 [ ! -e "$backup/desktop-isolation.json" ] || cp -a "$backup/desktop-isolation.json" /etc/stellarcortex/
 cp -a "$backup"/stellarcortex-*.service /etc/systemd/system/
 systemctl daemon-reload
 systemctl start stellarcortex-desktop-broker.service || true
 echo 'The upgrade failed, so the previous version was restored.'
}
trap 'restore; exit 1' ERR
rm -rf "$next"; install -d -m 755 "$next"; tar -xzf runtime.tar.gz -C "$next"
chown -R root:root "$next"; chmod -R go-w "$next"
python3 -I -B "$next/deployment/ubuntu-desktop/host-setup.py" merge-config . /etc/stellarcortex
'''
        + media
        + pins
        + '''systemctl stop stellarcortex-desktop-broker.service
rm -rf "$live"; mv "$next" "$live"
# Only a host without the check gets it switched on, so an owner's disable outlives an upgrade.
guard_check=
[ -e /etc/systemd/system/stellarcortex-desktop-guard-check.timer ] || guard_check=new
install -m 644 ./*.service ./*.timer /etc/systemd/system/
install -m 644 desktop-network-guard-reload.nft /etc/stellarcortex/
if [ -e /etc/systemd/system/stellarcortex-desktop-network-coexistence.service ]; then
 install -m 644 broker-coexistence.unit /etc/systemd/system/stellarcortex-desktop-broker.service
 install -m 644 network-coexistence.py /etc/stellarcortex/desktop-network-coexistence.py
 install -m 644 network-coexistence.unit /etc/systemd/system/stellarcortex-desktop-network-coexistence.service
fi
'''
        + order
        + '''systemctl daemon-reload
systemctl enable libvirtd.service stellarcortex-desktop-network-guard.service stellarcortex-desktop-boot.service stellarcortex-desktop-broker.service
systemctl start stellarcortex-desktop-broker.service
# A firewall problem is no reason to undo the update.
[ -z "$guard_check" ] || { systemctl enable stellarcortex-desktop-guard-check.timer && systemctl start stellarcortex-desktop-guard-check.timer; } || echo 'The network guard check did not start. See: systemctl status stellarcortex-desktop-guard-check.timer'
systemctl try-restart stellarcortex-desktop-network-coexistence.service || echo 'The firewall rules for the computer did not start. See: systemctl status stellarcortex-desktop-network-coexistence.service'
trap - ERR
cmp -s desktop-network-guard.nft /etc/stellarcortex/desktop-network-guard.nft || printf 'The network guard in this bundle differs from the one in use. It was left as it is; review it before replacing it.\\n'
printf 'Upgraded. Backup: %s\\n' "$backup"
printf 'Restart the app so that it reads these settings'''
        + restart
        + r'''\n'
'''
    )
    # One pass, so a user path that holds one of these words stays as it is.
    values = {
        'HASH': manifest_digest,
        'PACKAGES': ' '.join(PACKAGES),
        'APP_SERVICE': app_service,
        'ISOSHA': iso_sha or '',
        'ISOFILE': shlex.quote(str(iso)),
        'MEDIA': MEDIA,
        'RUNNERS': RUNNERS,
    }
    fill = lambda text: re.sub('|'.join(values), lambda match: values[match.group()], text)
    for name, text in [('install-approved.sh', script), ('upgrade-approved.sh', upgrade)]:
        (output / name).write_text(fill(text))
        (output / name).chmod(0o700)
    return manifest, manifest_digest


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1:2] == ['merge-config']:
        merge_files(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
        sys.exit()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=pathlib.Path, required=True)
    p.add_argument('--output', type=pathlib.Path, required=True)
    p.add_argument('--app-uid', type=int, required=True)
    p.add_argument('--account-id', help='default: derived from the access key in the data folder')
    p.add_argument('--app-service', required=True)
    p.add_argument('--data-dir')
    p.add_argument(
        '--iso',
        type=pathlib.Path,
        help='a verified Ubuntu Server ISO; default: the build downloads and verifies one',
    )
    p.add_argument('--vm-memory-mib', type=int, help='default: half of the host')
    p.add_argument('--vm-vcpus', type=int, help='default: half of the host')
    a = p.parse_args()
    source = a.source.resolve()
    user_service, shown = app_service_settings(a.app_service, a.app_uid)
    data = a.data_dir or app_data_dir(shown, a.app_uid)
    manifest, h = render(
        source,
        a.output,
        a.app_uid,
        a.account_id or account_id(data),
        a.app_service,
        data,
        a.iso.resolve() if a.iso else None,
        prepare_runners(source, a.app_uid),
        computer_size(host_memory(), os.cpu_count(), a.vm_memory_mib, a.vm_vcpus),
        user_service,
    )
    print(json.dumps({'approvalHash': h, 'bundle': str(a.output), 'manifest': manifest}, indent=2))
