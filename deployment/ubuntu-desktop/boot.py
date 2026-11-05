#!/usr/bin/python3
"""Start only explicitly registered installed computers after guarded networking.
Never reinstalls, powers off, changes autostart flags or resumes agent jobs.
"""

import json, os, pathlib, pwd, re, subprocess, sys, xml.etree.ElementTree as ET

CONFIG = pathlib.Path('/etc/stellarcortex/desktop-broker.json')
POLICY = pathlib.Path('/var/lib/stellarcortex/desktops/broker/boot-policy.json')


def read_config(path=CONFIG):
    st = path.lstat()
    if path.is_symlink() or not path.is_file() or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Trusted root registry required')
    return json.loads(path.read_text())


def boot_enabled(config, policy=POLICY):
    '''The owner's choice in Settings, which the broker keeps in its own root folder, wins over the install default.'''
    try:
        st = policy.lstat()
    except FileNotFoundError:
        return config.get('bootApproved') is True
    if policy.is_symlink() or not policy.is_file() or st.st_uid != 0 or st.st_mode & 0o022:
        raise RuntimeError('Trusted boot policy required')
    return json.loads(policy.read_text()).get('enabled') is True


def guard_ready(run=subprocess.check_output):
    if 'virbr-scx' not in run(
        ['nft', 'list', 'table', 'inet', 'scx_desktops'], text=True, timeout=15
    ):
        raise RuntimeError('The network guard is down, so no computer starts')


def startup_action(r, status, seen):
    name = r.get('domain', '')
    if (
        not re.fullmatch(r'scx-desktop-[A-Za-z0-9_-]{1,128}', name)
        or name != 'scx-desktop-' + r['vmId']
    ):
        raise RuntimeError('Invalid domain identity')
    if name in seen:
        if seen[name] != r['uuid']:
            raise RuntimeError('Conflicting computer identity')
        return None
    seen[name] = r['uuid']
    uuid, state = status(name)
    if uuid != r['uuid']:
        raise RuntimeError('Registered domain identity changed')
    if state == 'running':
        return None
    if state != 'shut off':
        raise RuntimeError('Computer is not safely stopped: ' + name + ' (' + state + ')')
    return name


def startup_actions(config, status):
    seen = {}
    actions = [startup_action(r, status, seen) for r in config['desktops']]
    # A leftover older computer never starts, and it does not keep the shared one down.
    for r in config.get('preservedComputers', []):
        try:
            actions.append(startup_action(r, status, seen))
        except (RuntimeError, KeyError, subprocess.SubprocessError) as error:
            print(
                'Skipped a preserved computer, ' + str(r.get('domain')) + ': ' + str(error),
                file=sys.stderr,
            )
    return [name for name in actions if name]


def prepare_runtime(records, root=pathlib.Path('/run/stellarcortex-desktops'), owner=None):
    owner = owner or pwd.getpwnam('libvirt-qemu')
    if root.is_symlink():
        raise RuntimeError('Runtime root must not be a symlink')
    root.mkdir(exist_ok=True, mode=0o711)
    os.chmod(root, 0o711)
    for r in records:
        directory = root / r['domain']
        if directory.is_symlink():
            raise RuntimeError('Runtime directory must not be a symlink')
        directory.mkdir(exist_ok=True, mode=0o700)
        os.chown(directory, owner.pw_uid, owner.pw_gid)
        os.chmod(directory, 0o700)


def restore(config, virsh, guard, enabled, now=False):
    # The network must already exist and be guarded; this service never changes it.
    guard()
    network = ET.fromstring(virsh('net-dumpxml', 'stellarcortex-desktops'))
    if (
        network.find('bridge').get('name') != 'virbr-scx'
        or network.find('forward').get('mode') != 'nat'
    ):
        raise RuntimeError('Dedicated network identity differs')
    info = virsh('net-info', 'stellarcortex-desktops')
    if not re.search(r'^Active:\s+yes$', info, re.M):
        virsh('net-start', 'stellarcortex-desktops')
    prepare_runtime(config['desktops'] + config.get('preservedComputers', []))
    if not enabled and not now:
        print(
            'Computers stay off, as set in Settings > Computer. To start them now, run this script as root with --now.'
        )
        return
    for name in startup_actions(
        config, lambda name: (virsh('domuuid', name), virsh('domstate', name))
    ):
        virsh('start', name)
    print('Registered computers running; no agent requests resumed')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Dedicated boot service required')

    def virsh(*args):
        return subprocess.check_output(
            ['virsh', '--connect', 'qemu:///system', *args], text=True, timeout=30
        ).strip()

    config = read_config()
    restore(config, virsh, guard_ready, boot_enabled(config), '--now' in sys.argv[1:])


if __name__ == '__main__':
    main()
