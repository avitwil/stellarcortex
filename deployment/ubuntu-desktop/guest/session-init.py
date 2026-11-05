#!/usr/bin/python3
import json, os, pathlib, re, secrets, stat, subprocess

sid = os.environ.get('STELLARCORTEX_SESSION_ID', '')
if not re.fullmatch(r'desktop-[a-f0-9]{20}', sid):
    raise SystemExit('Registered session required')
p = pathlib.Path('/etc/stellarcortex/sessions') / (sid + '.json')
meta = p.lstat()
if meta.st_uid != 0 or meta.st_mode & 0o022 or not stat.S_ISREG(meta.st_mode):
    raise SystemExit('Trusted session config required')
r = json.loads(p.read_text())
if os.getuid() != r['uid'] or os.getuid() == 0 or os.environ['HOME'] != r['home']:
    raise SystemExit('Session user mismatch')
os.umask(0o077)
runtime = pathlib.Path('/run/user') / str(r['uid']) / 'stellarcortex'
runtime.mkdir(mode=0o700, exist_ok=True)
auth = pathlib.Path(r['home']) / '.Xauthority'
if auth.is_symlink():
    raise SystemExit('Unsafe authority path')
if not auth.exists():
    auth.touch(mode=0o600)
    result = subprocess.run(
        ['/usr/bin/xauth', '-f', str(auth)],
        input='add :' + str(r['displayNumber']) + ' . ' + secrets.token_hex(16) + '\n',
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise SystemExit('Could not initialize private display authority')
os.chmod(auth, 0o600)
