# Deployment

Version 0.1 supports Linux only, and a Windows version is planned.

## Host boundary

One installation is for one trusted owner. Bots share workspace files, and a bot with host control shares the server's operating-system account. Each bot has a computer mode, set in Settings: see [COMPUTER.md](COMPUTER.md). The modes do not provide multi-tenant isolation. Run under a dedicated unprivileged OS user for a server. Codex mediates shell/file sandbox permissions; browser and desktop input have the application's approval/takeover controls.

The app binds to `127.0.0.1:4317` by default. Sessions require an installation-specific 256-bit access key. HTTP cookies are HttpOnly and SameSite=Strict. Mutating API calls require a custom header; unconfigured hosts and cross-origin requests are rejected. Artifact HTML runs in a sandboxed iframe without network. Generated files must resolve inside the workspace, including through symlinks.

The headless browser blocks non-HTTP protocols and destinations that resolve to private IPs, including redirects and subresources. OS desktop applications use the host/container network configuration; that headless-browser check does not restrict every application. Use OS/network policies for strict egress isolation. Browser sessions and workspace contents are sensitive and are not encrypted by StellarCortex at rest.

## Server-only deployment with Docker

Docker Engine can run the included Compose configuration:

```bash
docker compose up -d --build
docker compose exec stellarcortex node node_modules/@openai/codex/bin/codex.js login --device-auth
docker compose exec stellarcortex cat /data/access-key
```

Complete the official OpenAI device login, then enter the installation key at the local web UI. Codex must be authenticated in this container; a host's login is not automatically inherited. This subscription connection does not require an API key and refuses a silent switch to API billing. Separate API providers are explicitly configured in Settings. Subscription entitlement and usage limits still apply.

The image defaults to `STELLARCORTEX_BIND=127.0.0.1`. `compose.yaml` is the only place that opts in to `0.0.0.0`, inside the container, because a published port cannot reach a loopback listener; its `127.0.0.1:4317:4317` mapping is what limits access on the host. The Compose configuration binds port 4317 to host loopback, keeps app data, Codex state and Claude state in three named volumes, and does not mount the Docker socket or arbitrary host directories. Stop a competing installation before reusing the same port. `docker compose stop` stops the service; `docker compose start` starts it again. Preserve all three named volumes when updating or backing up.

Docker build/deployment has **not** been verified in this environment. It is a portable deployment option, not a claim of a tested container image. The image is server-only: it has no desktop, so bots keep the headless browser and a bot set to host control gets a shell inside the container. See [COMPUTER.md](COMPUTER.md).

## Linux installation

Install Node, then run `bash install.sh` as the intended ordinary user. `bash start.sh --no-open` starts the server. For long-running deployment use the systemd configuration below. A host screen needs an X11 session; see [COMPUTER.md](COMPUTER.md). A separate computer for each bot needs the QEMU setup in [SHARED-DESKTOP.md](SHARED-DESKTOP.md).

## Remote access with SSH (recommended)

On the server, install and run StellarCortex under your own account. Authenticate Codex there with `npx codex login --device-auth`; complete the displayed OpenAI device flow in your local browser.

From your client:

```bash
ssh -N -L 4317:127.0.0.1:4317 your-user@your-server
```

Open http://127.0.0.1:4317 locally. Obtain the installation access key securely from the server's `~/.stellarcortex/access-key`. The SSH tunnel keeps the application loopback-only. Do not copy an entire local Codex home into the server blindly.

## Private access over a Tailscale tailnet (optional)

The server can also listen on a private Unix socket for a reverse proxy on the same host, such as Tailscale Serve:

```bash
STELLARCORTEX_TAILNET_UI_URL=https://your-machine.your-tailnet.ts.net/
```

The socket is `tailscale-ui.sock` in the data folder. On a service, see [Linux service](#linux-service). Then run `sudo tailscale serve --bg --https=443 unix:/your/data/tailscale-ui.sock`, with your data directory. If you move the data directory, run it again with the new socket, because the old one gives a 502. `STELLARCORTEX_UI_SOCKET` must be exactly `tailscale-ui.sock` inside the active data directory; the server creates it with mode 0600. `STELLARCORTEX_TAILNET_UI_URL` must be the exact HTTPS origin the proxy serves (no path, query or credentials). Only requests that arrive on that socket with matching `X-Forwarded-Host` and `X-Forwarded-Proto: https` are treated as coming from that origin, and the access key and session cookie are still required. Point the proxy at the socket following the [Tailscale Serve documentation](https://tailscale.com/kb/1312/serve). The TCP listener on `127.0.0.1` keeps working.

## HTTPS reverse proxy

Keep the backend on loopback and terminate TLS at a proxy. Set:

```bash
STELLARCORTEX_PUBLIC_URL=https://bots.example.com
```

The proxy must preserve `Host`, support SSE without buffering, and allow uploads up to 36 MB. An example Nginx location inside an existing correctly configured TLS server:

```nginx
location / {
    proxy_pass http://127.0.0.1:4317;
    proxy_set_header Host $http_host;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 36m;
}
```

The application does not trust forwarded headers to infer authorization. `STELLARCORTEX_PUBLIC_URL` supplies the allowed host and enables Secure cookies. Do not expose plain HTTP on a public network. `STELLARCORTEX_BIND` is available for an explicit deployment topology; binding to all interfaces does not configure TLS or a firewall.

## Linux service

The one-line install from the site ends in the same command, and `curl -fsSL https://stellarcortex.avitwil.io/install.sh | NAME=value bash` passes settings to it. The service runs `scripts/managed-launch.mjs`, which starts the server as its child and keeps its releases in `<data folder>-updates`. A running service keeps its old settings until `systemctl --user restart stellarcortex`. In a service install, `node scripts/open.mjs` cannot see the service's settings, so set `STELLARCORTEX_BIND` and `STELLARCORTEX_PUBLIC_URL` in its own shell, with the same values. To stop it, use `systemctl --user stop stellarcortex`: `npm stop` ends the server, and the service starts it again.

`bash install.sh --service` creates and enables a user systemd unit. Keep the application folder at its installed path. `sudo loginctl enable-linger "$USER"` lets user services continue after logout and start at boot.

```bash
systemctl --user status stellarcortex
journalctl --user -u stellarcortex -f
systemctl --user stop stellarcortex
systemctl --user restart stellarcortex
```

To choose settings, put them before the install command. It keeps them in `~/.config/systemd/user/stellarcortex.service.d/install.conf`, and a later run with no settings leaves them:

```bash
STELLARCORTEX_DATA_DIR=/your/existing/data \
STELLARCORTEX_BIND=192.168.1.50 STELLARCORTEX_PUBLIC_URL=http://192.168.1.50:4317 \
STELLARCORTEX_TAILNET_UI_URL=https://your-machine.your-tailnet.ts.net/ \
bash install.sh --service
```

Use only the ones you need. `STELLARCORTEX_DATA_DIR` can name a folder with existing data, and the virtual computer's setup follows it. `PORT` works the same way. `STELLARCORTEX_TAILNET_UI_URL` also sets the socket, and the install prints the link and the one `tailscale serve` command to run. For anything else, use `systemctl --user edit stellarcortex` and add a `[Service]` block with `Environment="NAME=value"`, then daemon-reload and restart. Authenticate Codex under the same OS user and make sure its home is available to the service.

For a host screen, give the service `DISPLAY` and `XAUTHORITY` from the X11 session of the same user in that block. The service helper does not install X11 packages or configure a new VM. Wayland cannot be controlled.

For a foreground run: `npm start`. For the background launcher: `node scripts/launch.mjs --no-open`. Its log is `<data-dir>/server.log`. Stop this installation with `npm stop`; it authenticates locally and requests graceful shutdown. Prefer a service manager for long-term production operation; stop the service through that manager to avoid automatic restart.

## Backups and updates

Settings checks the latest GitHub release for a newer signed version. A service from `bash install.sh --service` and `bash start.sh` apply it through the supervisor described in [UPDATES.md](UPDATES.md). Root-owned systemd and Docker installs update by hand; see [RECOVERY.md](RECOVERY.md).

1. Stop the server and wait for any browser/process shutdown.
2. Back up the complete active data directory, including `state.json`, `workspace` and `browser`. For Docker preserve its data volume.
3. Back up Codex state according to your credential-handling policy; reauthentication is preferable to distributing credentials.
4. Keep backups private. Browser profiles include website sessions.
5. Replace application files in the actual runtime location, run `npm ci` and browser installation if needed, then restart. For Docker rebuild the image while preserving volumes.

The UI JSON export contains configuration/history, not browser profiles, attachment bytes or Codex thread data. It is an inspection/export aid, not a complete restore archive. Restore a complete filesystem backup to the same data path with the server stopped. Pending approvals expire and in-progress tasks are marked interrupted on restart. Review completed side effects before retrying a job.

## Change the access key

Change it if it was seen, copied to a log or shared. Run this as the user that runs the server:

```bash
node scripts/rotate-key.mjs
```

It writes a new key to the `access-key` file in the data folder and restarts `stellarcortex.service`. Sign-ins normally survive a restart, because `sessions.json` keeps a hash of each one, but that hash depends on the key. So the old key and every sign-in stop working, and running tasks are interrupted. Virtual computers keep working, because their owner identity is saved in `owner-account`. Do not delete `access-key` by hand: without that saved identity, the app no longer recognises its computers.

The new key is not printed. Run `node scripts/open.mjs`, or read the file.

Without the service, run `npm stop` first, then the command, then start the server. In Docker:

```bash
docker compose exec stellarcortex node scripts/rotate-key.mjs
docker compose restart stellarcortex
```

A backup of the data folder still holds the old key, which no longer works. Keep `owner-account` in the backup.

## Known execution limitations

- Local sleep/shutdown stops work. A continuously running personal server solves client-laptop downtime.
- Runtime reconnection is manual. Failed jobs are visible and are not silently replayed.
- Daily schedules catch up once when the server returns later on that local date. Intervals resume from the actual scheduled attempt; missed executions are not replayed in a burst.
- JSON storage is suited to personal-scale usage; it is not a distributed database.
- Subscription access and tools depend on the actual Codex account, version and policy. App-server is an evolving interface.
- Application approvals cannot prevent all external side effects from independently configured MCP servers; use appropriate tool permissions.
- Full Grok parity, enterprise access control and a microVM per bot are not provided. See [PARITY.md](PARITY.md) and [VALIDATION.md](VALIDATION.md).
