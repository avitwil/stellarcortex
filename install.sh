#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "$(uname -s)" != Linux ]]; then
  echo "StellarCortex 0.1 supports Linux only, and this system is $(uname -s). A Windows version is planned."
  exit 1
fi
if [[ "${1:-}" == '--desktop-host-bundle' ]]; then
  shift
  exec python3 -B deployment/ubuntu-desktop/host-setup.py --source "$PWD" "$@"
fi
node_ready(){ command -v node >/dev/null && command -v npm >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<16))process.exit(1)'; }
if ! node_ready && command -v apt-get >/dev/null; then
  echo 'Installing Node.js and npm. This needs root.'
  sudo apt-get update && sudo apt-get install -y nodejs npm || true
fi
node_ready || { echo 'Node.js 22.16+ and npm are required. Install them from https://nodejs.org, then run this again.'; exit 1; }
codex_ready(){ node node_modules/@openai/codex/bin/codex.js --version >/dev/null 2>&1; }
npm ci --no-audit --no-fund --omit=dev
# npm skips an optional package that fails to download without an error, and Codex's program is one.
codex_ready || npm ci --no-audit --no-fund --omit=dev
codex_ready || { echo 'The Codex program did not install. Check the network, then run this again.'; exit 1; }
node node_modules/playwright/cli.js install chromium
echo 'Installed. Start with: bash start.sh'
echo 'For Claude bots, sign in with: bash claude-login.sh, then refresh the Claude connection in Settings.'
echo 'If Chromium reports missing system libraries on Debian/Ubuntu: sudo npx playwright install-deps chromium'
if [[ "${1:-}" == '--service' ]]; then
  node scripts/linux-service.mjs
  systemctl --user daemon-reload
  systemctl --user enable stellarcortex.service
  # Restart, not start: a later run may have changed the settings.
  systemctl --user restart stellarcortex.service
  node scripts/install-computer.mjs
  node scripts/first-link.mjs
fi
