#!/bin/bash
# The root step of `bash install.sh --service`, run once. A later update goes through the root-owned kit, never this folder.
# Exit 3: the owner said no to the firewall question. Exit 4: root has no Node.js. Exit 5: a step failed; sudo itself worked.
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
# The firewall check needs nft, and ufw on the legacy backend leaves no nft ruleset.
command -v nft >/dev/null || { apt-get update >/dev/null; apt-get install -y nftables >/dev/null; }
ruleset=$(nft list ruleset 2>/dev/null || true)
ufw_status=$(ufw status 2>/dev/null || true)
if grep -q 'hook' <<<"$ruleset" || grep -q 'Status: active' <<<"$ufw_status"; then
 echo 'This host has a firewall. The virtual computer needs DHCP, DNS and outbound traffic through it, on the new bridge virbr-scx.'
 read -r -p 'Allow that? [y/N] ' answer </dev/tty || answer=
 [[ "$answer" =~ ^[Yy] ]] || exit 3
 flag=--firewall-reviewed
fi
python3 -I -B "$kit/deployment/ubuntu-desktop/host-setup.py" --source "$kit" --output "$bundle" --app-uid "$uid" --app-service "$service" >/dev/null
# scripts/install-computer.mjs restarts the app next, so nobody has to.
STELLARCORTEX_APP_RESTARTS=1 "$bundle/install-approved.sh" "$(cat "$bundle/APPROVAL-SHA256")" "$flag"
# What the root step of a later update from Settings trusts and needs. None of it is the app user's to change.
install -m 644 "$kit/update-keys.json" /etc/stellarcortex/update-keys.json
node -p "require(process.argv[1]).version" "$kit/package.json" > /etc/stellarcortex/kit-version
printf '{"appUid":%s,"appService":"%s","flag":"%s"}\n' "$uid" "$service" "$flag" > /etc/stellarcortex/kit-update.json
chmod 644 /etc/stellarcortex/kit-version /etc/stellarcortex/kit-update.json
if [ -n "$flag" ] && grep -q 'Status: active' <<<"$ufw_status"; then
 uplink=$(ip -o route show default)
 uplink=${uplink#* dev }
 uplink=${uplink%% *}
 ufw allow in on virbr-scx to any port 67 proto udp
 ufw allow in on virbr-scx to any port 53
 ufw route allow in on virbr-scx out on "$uplink"
elif [ -n "$flag" ]; then
 echo 'If the computer cannot reach the internet, see "Firewall coexistence" in deployment/ubuntu-desktop/README.md.'
fi
