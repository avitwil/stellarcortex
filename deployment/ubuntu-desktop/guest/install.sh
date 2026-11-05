#!/bin/bash
# Executed only inside the newly installed dedicated Ubuntu disk by Subiquity.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ -e /opt/stellarcortex-worker/guest-install.json ]
cd /opt/stellarcortex-worker
install -d -m 755 /etc/stellarcortex /var/lib
python3 - <<'PY'
import json,pathlib,re
p=json.loads(pathlib.Path('guest-install.json').read_text())
assert p['provider']=='qemu-kvm-ubuntu-desktop' and len(p['botIds'])==1
assert all(re.fullmatch(r'[A-Za-z0-9_-]{1,128}',p[k]) for k in ['vmId','generation','botId'])
pathlib.Path('/etc/stellarcortex/guest.json').write_text(json.dumps(p))
PY
systemctl enable qemu-guest-agent
# Dedicated account owns its files but has no host privileges or login credential.
passwd -l desktop
for group in sudo adm; do gpasswd -d desktop "$group" 2>/dev/null || true; done
install -m 644 deployment/ubuntu-desktop/guest/firstboot.service /etc/systemd/system/stellarcortex-firstboot.service
systemctl enable stellarcortex-firstboot.service
