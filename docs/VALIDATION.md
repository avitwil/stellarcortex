# Testing and validation

This page separates what the automated tests cover, what has been checked by hand against real accounts and hosts, and what has not been validated. A feature listed in [PARITY.md](PARITY.md) is not a claim that every platform or provider has been tested.

## Running the tests

```bash
npm ci
npm test                              # Node test suite
for f in test/*.test.py; do python3 "$f"; done   # Linux only
```

The Python tests and the desktop, guest and Unix-socket parts of the Node suite assume Linux. Run the full suite on Linux. The suite uses temporary data directories, fake provider processes and local protocol fixtures; it never uses real accounts, API keys or model inference.

The `scripts/check-*.mjs` and `scripts/*-check.mjs` files are manual checks. Most drive an isolated app instance with synthetic data in Chromium; some (for example `desktop-real-display-check.mjs` and `check-codex-guest-isolation.mjs`) need a configured Linux desktop host or the Linux Codex binary.

## Automated coverage

- **Core:** persistent state, corrupt-file protection, single-process ownership, schedules and missed runs, workspace path containment (including symlinks and junctions), private-address checks, session, CSRF and host checks, template privacy.
- **Engine and bots:** streaming, per-bot serialization, concurrency, team creation, asynchronous hand-offs and result return, duplicate and cycle prevention, group routing, deletion and restore, one-time approvals.
- **Providers:** Codex app-server, the official Claude Code CLI adapter (streaming, MCP tool and image results, denied native actions, process cleanup), exact Claude model IDs and effort levels, `/usage` parsing, per-bot model, effort and speed, provider switching, and refusal of silent API billing.
- **API and local models:** Chat Completions, Responses and Anthropic Messages streaming, tool round trips, session resume, credential isolation, origin-bound model catalogs and no redirects.
- **Connections:** the MCP client over Streamable HTTP, SSE and stdio, OAuth with browser-bound state, encrypted secret storage and credential redaction.
- **Computer control:** takeover and hand-back, input ordering, Unicode and shortcut handling, coordinate scaling, stale screenshots, fullscreen fallbacks, separate bot screens, the QEMU/KVM desktop provider, broker, guest channel, effect journal and teaching flow.
- **Permissions and updates:** Claude permission modes, signed release checks, the one-line install with a fake GitHub, the release tool, owner confirmation, release staging, backup, health check and rollback.
- **Voice:** WebRTC negotiation, transcription settings, cancellation, microphone cleanup and call-scoped replies (mocked).
- **Deployment helpers:** the firewall coexistence precheck and the desktop host bundle.

## Checked by hand

- Real ChatGPT/Codex and Claude subscription turns, mixed Codex and Claude delegation, and the Claude usage meters, with no API key involved.
- Bot creation through the team tool, delegation and return, visible bot-to-bot exchanges, delete and restore from Trash.
- The browser UI in Hebrew and English, light and dark themes, wide and narrow layouts, the model picker, Settings and Connect apps.
- The tool list of each computer mode on the real Claude Code and Codex binaries, through a local stub: a bot with no computer has no native tools, on a new thread, on resume and after a process restart.
- Clean ZIP and TAR.GZ packages from `npm run package`: identical contents, no private files, and a fresh start with a new access key and empty history.
- Upgrading an existing installation preserved its conversations, bots and settings, and kept existing sign-ins.

## Not validated

- A real signed GitHub release, and a service install running under the update supervisor on Linux.
- The "Ways to run it" steps in the README, end to end: the VPS example (new user, NodeSource, Tailscale, `tailscale serve`), the host check commands, the LAN install with its `ufw` rule, and changing settings on a running install. The server's listen address and `Host` check were run with `STELLARCORTEX_BIND` and `STELLARCORTEX_PUBLIC_URL` outside a service.
- **Docker build and Docker deployment.** The Dockerfile and Compose file are provided but have not been tested end to end.
- External MCP OAuth with a user account; paid API inference; every listed local engine; microphone recognition and audible playback end to end.
- QEMU virtual computers since the per-bot modes, host control on Linux X11, the Wayland status, locked or pre-login screens, Linux systemd activation and a remote TLS proxy.
- Fully model-driven replay of skills recorded through desktop teaching.
- Password pass-through on real sites: real logins, real two-step forms and real site scripts. A local fixture on real Chrome covers the flow, with a canary search of the data directory and output.
- `LimitCORE=0` under systemd, and the pass-through on a real KVM guest: `transient` is tested through the broker, journal and guest worker in process, not over a real vsock.
- Two Codex processes sharing one ChatGPT sign-in, on an installation with a virtual computer for Codex.
- Native Wayland input (not implemented), signed installers (the installers are source-based), mobile push, enterprise roles or SSO, and full Grok Bot parity.

See [COMPUTER.md](COMPUTER.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for the supported modes and their prerequisites.
