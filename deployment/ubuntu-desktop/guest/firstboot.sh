#!/bin/bash
# Each step has a limit and leaves a mark when done, so a Retry goes on from the step that stopped.
set -uo pipefail
cd /opt/stellarcortex-worker
state=/var/lib/stellarcortex-firstboot
mkdir -p "$state"
export HOME=/root PLAYWRIGHT_BROWSERS_PATH=/opt/stellarcortex-browsers
step(){
 local name=$1 limit=$2 tries=$3 try
 shift 3
 [ -e "$state/$name.done" ] && return
 printf '%s\n' "$name" > "$state/current"
 for ((try=1;try<=tries;try++));do
  if timeout -k 30 "$limit" "$@" > "$state/$name.log" 2>&1;then touch "$state/$name.done";return;fi
 done
 { printf '%s: ' "$name";tail -n 3 "$state/$name.log"; } > /var/lib/stellarcortex-firstboot-failed
 exit 1
}
step node 30 1 node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
# Claude and Codex run on the host, so the computer skips their programs, which are the optional packages.
step packages 480 2 npm ci --omit=optional --ignore-scripts --no-audit --no-fund
# The Chromium the app already uses, pinned by hash. Each computer fetches its own, so nothing is redistributed.
step browser 1500 2 sh deployment/ubuntu-desktop/guest/fetch-chromium.sh
# Ubuntu allows Chromium's sandbox only to programs that have a profile.
step sandbox 60 1 sh -c 'install -m 644 deployment/ubuntu-desktop/guest/chromium.apparmor /etc/apparmor.d/stellarcortex-chromium && apparmor_parser -r /etc/apparmor.d/stellarcortex-chromium'
# Each bot runs it as its own user, so this checks it as a plain user, with the sandbox on.
step check 120 2 runuser -u desktop -- sh -c 'dir=$(mktemp -d) && /opt/stellarcortex-browsers/chromium-*/chrome-linux64/chrome --headless=new --no-first-run --user-data-dir="$dir" --dump-dom about:blank'
python3 - <<'PY'
import json,pathlib
p=json.loads(pathlib.Path('guest-install.json').read_text());keys=['accountId','botId','vmId','generation','uuid','domain','cid']
pathlib.Path('/var/lib/stellarcortex-installed.json').write_text(json.dumps({k:p[k] for k in keys}))
PY
