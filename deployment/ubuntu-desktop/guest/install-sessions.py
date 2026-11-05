#!/usr/bin/python3
"""Apply only the root-approved installation plan of bot users inside this computer."""

import hashlib, json, os, pathlib, pwd, grp, shutil, subprocess, sys
from session_ready import ensure_screen_software, wait_for_screen

if os.geteuid() != 0 or os.environ.get('STELLARCORTEX_INSIDE_GUEST') != '1':
    raise SystemExit('Dedicated guest installation required')
planfile = pathlib.Path(sys.argv[1])
st = planfile.lstat()
if not planfile.is_file() or planfile.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
    raise SystemExit('Trusted plan required')
plan = json.loads(planfile.read_text())
legacy = json.loads(pathlib.Path('/etc/stellarcortex/guest.json').read_text())
if (
    plan.get('approved') is not True
    or len(plan['records']) not in (1, 2)
    or any(
        r['vmId'] != legacy['vmId'] or r['generation'] != legacy['generation']
        for r in plan['records']
    )
):
    raise SystemExit('Approved existing-VM plan required')
incremental = plan.get('incremental') is True
if incremental and len(plan['records']) != 1:
    raise SystemExit('One incremental session required')
statefile = (
    pathlib.Path('/var/lib/stellarcortex-session-installs')
    / (plan['records'][0]['sessionId'] + '.json')
    if incremental
    else pathlib.Path('/var/lib/stellarcortex-shared-session-install.json')
)
statefile.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
digest = hashlib.sha256(planfile.read_bytes()).hexdigest()
state = (
    json.loads(statefile.read_text()) if statefile.exists() else {'planHash': digest, 'created': []}
)
if state['planHash'] != digest:
    raise SystemExit('Different installation plan already exists')


def save():
    temp = statefile.with_suffix('.tmp')
    temp.write_text(json.dumps(state))
    temp.chmod(0o600)
    os.replace(temp, statefile)


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def write(file, text, uid=0, gid=0, mode=0o644):
    file = pathlib.Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + '.tmp')
    temp.write_text(text)
    temp.chmod(mode)
    os.chown(temp, uid, gid)
    os.replace(temp, file)


for r in plan['records']:
    if (
        not 1101 <= r['uid'] <= 60000
        or not 21 <= r['displayNumber'] <= 4095
        or r['home'] != '/home/' + r['username']
    ):
        raise SystemExit('Unexpected user allocation')
    try:
        u = pwd.getpwnam(r['username'])
        if r['username'] not in state['created'] or u.pw_uid != r['uid'] or u.pw_dir != r['home']:
            raise SystemExit('Existing user is not this installation')
    except KeyError:
        try:
            pwd.getpwuid(r['uid'])
            raise SystemExit('UID occupied')
        except KeyError:
            pass
        try:
            grp.getgrgid(r['uid'])
            raise SystemExit('GID occupied')
        except KeyError:
            pass
# Validate the complete application dependency bundle before creating any account.
run(
    '/usr/bin/node',
    '--input-type=module',
    '-e',
    "await import('/opt/stellarcortex-worker/src/private-browser.mjs')",
)


def install_packages(packages):
    run('/usr/bin/apt-get', 'update')
    run(
        '/usr/bin/env',
        'DEBIAN_FRONTEND=noninteractive',
        '/usr/bin/apt-get',
        'install',
        '-y',
        '--no-install-recommends',
        *packages
    )


ensure_screen_software(os.path.exists, install_packages)
registryfile = pathlib.Path('/etc/stellarcortex/session-registry.json')
existing = (
    json.loads(registryfile.read_text())['sessions']
    if incremental and registryfile.exists()
    else []
)
for r in plan['records']:
    if any(
        x['botId'] == r['botId']
        or x['uid'] == r['uid']
        or x['sessionId'] == r['sessionId']
        or x['displayNumber'] == r['displayNumber']
        for x in existing
    ):
        raise SystemExit('Session identity already allocated; inspect before retry')
save()
for r in plan['records']:
    uid = r['uid']
    name = r['username']
    home = pathlib.Path(r['home'])
    sid = r['sessionId']
    runtime = '/run/user/' + str(uid)
    if name not in state['created']:
        run('/usr/sbin/groupadd', '--gid', str(uid), name)
        run(
            '/usr/sbin/useradd',
            '--uid',
            str(uid),
            '--gid',
            str(uid),
            '--create-home',
            '--home-dir',
            str(home),
            '--shell',
            '/bin/bash',
            '--password',
            '!',
            name,
        )
        state['created'].append(name)
        save()
    home.chmod(0o700)
    write('/etc/stellarcortex/sessions/' + sid + '.json', json.dumps(r, indent=2) + '\n')
    units = home / '.config/systemd/user'
    units.mkdir(parents=True, exist_ok=True)
    env = {
        'HOME': str(home),
        'USER': name,
        'LOGNAME': name,
        'DISPLAY': ':' + str(r['displayNumber']),
        'XAUTHORITY': str(home / '.Xauthority'),
        'XDG_RUNTIME_DIR': runtime,
        'XDG_SESSION_TYPE': 'x11',
        'XDG_CURRENT_DESKTOP': 'XFCE',
        'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus',
        'STELLARCORTEX_INSIDE_GUEST': '1',
        'STELLARCORTEX_SESSION_ID': sid,
        'STELLARCORTEX_DESKTOP_MODE': 'virtual',
        'STELLARCORTEX_BOT_DESKTOP_ID': r['botId'],
        'STELLARCORTEX_DATA_DIR': str(home / '.local/share/stellarcortex'),
        'PLAYWRIGHT_BROWSERS_PATH': '/opt/stellarcortex-browsers',
    }
    common = (
        ''.join('Environment=' + k + '=' + v + '\n' for k, v in env.items())
        + 'UMask=0077\nLimitCORE=0\nRestart=on-failure\nRestartSec=2\n'
    )

    def unit(description, command, after='', pre=''):
        return (
            '[Unit]\nDescription='
            + description
            + '\nPartOf=stellarcortex-session.target\n'
            + ('After=' + after + '\nRequires=stellarcortex-display.service\n' if after else '')
            + '[Service]\nType=simple\n'
            + common
            + pre
            + 'ExecStart='
            + command
            + '\n'
        )

    source = '/opt/stellarcortex-worker/'
    display = (
        '/usr/bin/Xtigervnc :'
        + str(r['displayNumber'])
        + ' -geometry 1440x900 -depth 24 -auth '
        + str(home / '.Xauthority')
        + ' -rfbport -1 -rfbunixpath '
        + runtime
        + '/stellarcortex/vnc.sock -rfbunixmode 0600 -SecurityTypes None -AlwaysShared -nolisten tcp -s 0'
    )
    write(
        units / 'stellarcortex-display.service',
        unit(
            'Private bot X11 display',
            display,
            pre='ExecStartPre=/usr/bin/python3 '
            + source
            + 'deployment/ubuntu-desktop/guest/session-init.py\n',
        ),
        uid,
        uid,
    )
    wait = (
        'ExecStartPre=/usr/bin/python3 '
        + source
        + 'deployment/ubuntu-desktop/guest/wait-session-display.py\n'
    )
    write(
        units / 'stellarcortex-desktop.service',
        unit(
            'Standard Xfce bot desktop',
            '/usr/bin/startxfce4',
            'stellarcortex-display.service',
            wait,
        ),
        uid,
        uid,
    )
    write(
        units / 'stellarcortex-browser.service',
        unit(
            'Same-session bot browser',
            '/usr/bin/node ' + source + 'scripts/browser-desktop.mjs',
            'stellarcortex-display.service',
            wait,
        )
        + 'KillMode=mixed\nTimeoutStopSec=30\n',
        uid,
        uid,
    )
    write(
        units / 'stellarcortex-worker.service',
        unit(
            'Scoped bot session tools',
            '/usr/bin/node ' + source + 'scripts/ubuntu-session-worker.mjs',
            'stellarcortex-display.service',
            wait,
        ),
        uid,
        uid,
    )
    write(
        units / 'stellarcortex-session.target',
        '[Unit]\nDescription=Persistent bot desktop session\nWants=stellarcortex-display.service stellarcortex-desktop.service stellarcortex-browser.service stellarcortex-worker.service\n[Install]\nWantedBy=default.target\n',
        uid,
        uid,
    )
    wants = units / 'default.target.wants'
    wants.mkdir(exist_ok=True)
    link = wants / 'stellarcortex-session.target'
    if not link.exists():
        link.symlink_to('../stellarcortex-session.target')
    conf = home / '.config/xfce4/xfconf/xfce-perchannel-xml'
    write(
        conf / 'xfce4-power-manager.xml',
        '<channel name="xfce4-power-manager" version="1.0"><property name="xfce4-power-manager" type="empty"><property name="inactivity-on-ac" type="uint" value="0"/><property name="inactivity-on-battery" type="uint" value="0"/><property name="dpms-enabled" type="bool" value="false"/><property name="blank-on-ac" type="int" value="0"/><property name="blank-on-battery" type="int" value="0"/></property></channel>',
        uid,
        uid,
    )
    write(
        conf / 'xfce4-screensaver.xml',
        '<channel name="xfce4-screensaver" version="1.0"><property name="saver" type="empty"><property name="enabled" type="bool" value="false"/><property name="idle-activation" type="empty"><property name="enabled" type="bool" value="false"/></property></property></channel>',
        uid,
        uid,
    )
    # Make the standard browser launcher target this user's registered visible browser.
    applications = home / '.local/share/applications'
    applications.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(
        source + 'deployment/ubuntu-desktop/guest/stellarcortex-browser.desktop',
        applications / 'stellarcortex-browser.desktop',
    )
    write(
        home / '.config/mimeapps.list',
        '[Default Applications]\nx-scheme-handler/http=stellarcortex-browser.desktop\nx-scheme-handler/https=stellarcortex-browser.desktop\ntext/html=stellarcortex-browser.desktop\n',
        uid,
        uid,
    )
    for directory, dirs, files in os.walk(home):
        os.chown(directory, uid, uid)
        for f in files:
            os.lchown(os.path.join(directory, f), uid, uid)
    run('/usr/bin/loginctl', 'enable-linger', name)
    run('/usr/bin/systemctl', 'start', 'user@' + str(uid) + '.service')
    run(
        '/usr/sbin/runuser',
        '-u',
        name,
        '--',
        'env',
        'XDG_RUNTIME_DIR=' + runtime,
        'DBUS_SESSION_BUS_ADDRESS=unix:path=' + runtime + '/bus',
        'systemctl',
        '--user',
        'daemon-reload',
    )
    run(
        '/usr/sbin/runuser',
        '-u',
        name,
        '--',
        'env',
        'XDG_RUNTIME_DIR=' + runtime,
        'DBUS_SESSION_BUS_ADDRESS=unix:path=' + runtime + '/bus',
        'systemctl',
        '--user',
        'start',
        'stellarcortex-session.target',
    )

    # The target only Wants its units, so a clean start proves nothing about the screen.
    def active(service):
        return (
            subprocess.run(
                [
                    '/usr/sbin/runuser',
                    '-u',
                    name,
                    '--',
                    'env',
                    'XDG_RUNTIME_DIR=' + runtime,
                    'DBUS_SESSION_BUS_ADDRESS=unix:path=' + runtime + '/bus',
                    'systemctl',
                    '--user',
                    'is-active',
                    '--quiet',
                    service,
                ],
                stdout=subprocess.DEVNULL,
            ).returncode
            == 0
        )

    wait_for_screen(
        lambda: pathlib.Path(runtime + '/stellarcortex/vnc.sock').is_socket()
        and all(
            active('stellarcortex-' + part + '.service')
            for part in ['display', 'desktop', 'browser', 'worker']
        )
    )
write(
    '/etc/stellarcortex/session-registry.json',
    json.dumps({'sessions': existing + plan['records']}, indent=2) + '\n',
    mode=0o600,
)
write(
    '/etc/systemd/system/stellarcortex-session-relay.service',
    '''[Unit]
Description=Private registered bot session router
After=systemd-user-sessions.service
[Service]
Type=simple
User=root
Environment=STELLARCORTEX_INSIDE_GUEST=1
ExecStart=/usr/bin/python3 -I /opt/stellarcortex-worker/deployment/ubuntu-desktop/guest/session-relay.py
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_DAC_OVERRIDE
ProtectSystem=strict
InaccessiblePaths=/home /root
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_VSOCK
[Install]
WantedBy=multi-user.target
''',
)
run('/usr/bin/systemctl', 'daemon-reload')
run('/usr/bin/systemctl', 'enable', '--now', 'stellarcortex-session-relay.service')
state['stage'] = 'services-started'
save()
print('SESSION_SERVICES_STARTED')
