#!/usr/bin/python3
"""Removes one deleted bot's user and desktop from this computer, and nothing else. The relay closes that bot's connections by itself."""

import json, os, pathlib, pwd, re, subprocess, sys

if (
    os.geteuid() != 0
    or os.environ.get('STELLARCORTEX_INSIDE_GUEST') != '1'
    or not re.fullmatch(r'desktop-[a-f0-9]{20}', sys.argv[1])
):
    raise SystemExit('Dedicated guest removal required')
session = sys.argv[1]
name = 'scxb_' + session.removeprefix('desktop-')
registryfile = pathlib.Path('/etc/stellarcortex/session-registry.json')
# A second run, or a setup that stopped half way, can find only part of this.
try:
    uid = str(pwd.getpwnam(name).pw_uid)
except KeyError:
    uid = None
if uid:
    for command in [
        ['/usr/bin/loginctl', 'disable-linger', name],
        ['/usr/bin/systemctl', 'stop', 'user@' + uid + '.service'],
        ['/usr/bin/pkill', '-KILL', '-u', uid],
    ]:
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(
        ['/usr/sbin/userdel', '--remove', name],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
if registryfile.exists():
    sessions = json.loads(registryfile.read_text())['sessions']
    # The relay reads this file every second, so it must never see half of it.
    if any(s['sessionId'] == session for s in sessions):
        meta = registryfile.stat()
        temp = registryfile.with_name(registryfile.name + '.tmp')
        temp.write_text(
            json.dumps({'sessions': [s for s in sessions if s['sessionId'] != session]}, indent=2)
            + '\n'
        )
        temp.chmod(meta.st_mode & 0o777)
        os.chown(temp, meta.st_uid, meta.st_gid)
        os.replace(temp, registryfile)
for file in [
    '/etc/stellarcortex/sessions/' + session + '.json',
    '/var/lib/stellarcortex-session-installs/' + session + '.json',
]:
    pathlib.Path(file).unlink(missing_ok=True)
