#!/bin/sh
# Gets the pinned Chromium build and checks all of it before anything unpacks it. A try that ran out of time goes on with the same file.
set -eu
pin=deployment/ubuntu-desktop/guest/chromium-pin.json
field(){ sed -n 's/^ *"'"$1"'": *"\{0,1\}\([^",]*\)"\{0,1\},\{0,1\}$/\1/p' "$pin"; }
url=$(field url) sum=$(field sha256) bytes=$(field bytes)
target=/opt/stellarcortex-browsers/chromium-$(field revision)
zip=/var/lib/stellarcortex-firstboot/chrome-linux64.zip
good(){ echo "$sum  $zip" | sha256sum -c --status 2>/dev/null; }
if ! good;then
 # A whole file that failed has nothing left to resume.
 [ "$(wc -c < "$zip" 2>/dev/null || echo 0)" -lt "$bytes" ] || rm -f "$zip"
 curl -fsSL --retry 3 -C - -o "$zip" "$url"
 good || { rm -f "$zip";echo 'The downloaded Chromium does not match its pinned SHA-256, so it was not installed.';exit 1; }
fi
rm -rf "$target.new"
mkdir -p "$target.new"
unzip -q "$zip" -d "$target.new"
rm -rf "$target"
mv "$target.new" "$target"
rm -f "$zip"
