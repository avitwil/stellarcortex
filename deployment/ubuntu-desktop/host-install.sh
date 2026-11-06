#!/bin/bash
# The root step of `bash install.sh --service`, run once. A later update goes through the root-owned kit, never this folder.
# Exit 3: the owner said no to the firewall question. Exit 4: root has no Node.js. Exit 5: a step failed; sudo itself worked.
# Exit 6: the firewall could not be read or changed.
set -euo pipefail
trap 'exit 5' ERR
PATH=$PATH:/usr/local/bin
[ "$(id -u)" = 0 ] && [ "$#" = 4 ] || { echo 'Run this through: bash install.sh --service'; exit 2; }
app=$1 uid=$2 service=$3 user=$4
command -v node >/dev/null && command -v npm >/dev/null || exit 4
loginctl enable-linger "$user"
# Root must not keep running files the app user can change, so it works from its own copy.
kit=/var/lib/stellarcortex/kit bundle=/var/lib/stellarcortex/bundle-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 755 /var/lib/stellarcortex
rm -rf "$kit"; install -d -m 700 "$kit"
tar -C "$app" -cf - src scripts deployment package.json package-lock.json update-keys.json | tar -C "$kit" --no-same-owner -xf -
chown -R root:root "$kit"; chmod -R go-w "$kit"
flag=
command -v nft >/dev/null || { apt-get update >/dev/null; apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold nftables </dev/null >/dev/null; }
found=
code=0
found=$(python3 -I -B "$kit/deployment/ubuntu-desktop/network-coexistence.py" --check) || code=$?
if [ "$code" = 10 ]; then
 printf '\n\n%s\n' '========== YOUR ANSWER IS NEEDED =========='
 echo "This host has a firewall ($found). The virtual computer needs DHCP, DNS and outbound traffic through it."
 echo 'The install can add rules for its bridge, virbr-scx, and nothing else: your rules, SSH and inbound access stay as they are.'
 read -r -p '>>> Add them? [y/N] ' answer </dev/tty || answer=
 [[ "$answer" =~ ^[Yy] ]] || exit 3
 flag=--firewall-reviewed
elif [ "$code" != 0 ]; then
 exit 6
fi
python3 -I -B "$kit/deployment/ubuntu-desktop/host-setup.py" --source "$kit" --output "$bundle" --app-uid "$uid" --app-service "$service" >/dev/null
# scripts/install-computer.mjs restarts the app next, so nobody has to.
code=0
STELLARCORTEX_APP_RESTARTS=1 "$bundle/install-approved.sh" "$(cat "$bundle/APPROVAL-SHA256")" "$flag" || code=$?
[ "$code" = 0 ] || { [ "$code" = 6 ] && exit 6; exit 5; }
# What the root step of a later update from Settings trusts and needs. None of it is the app user's to change.
install -m 644 "$kit/update-keys.json" /etc/stellarcortex/update-keys.json
node -p "require(process.argv[1]).version" "$kit/package.json" > /etc/stellarcortex/kit-version
printf '{"appUid":%s,"appService":"%s","flag":"%s"}\n' "$uid" "$service" "$flag" > /etc/stellarcortex/kit-update.json
chmod 644 /etc/stellarcortex/kit-version /etc/stellarcortex/kit-update.json
