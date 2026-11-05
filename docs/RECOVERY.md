# Recovery

Updates normally need only the **Update now** button in **Settings → Updates**. Use this page when that button is not available, or an update stopped and needs attention.

## Update by hand

Use this for Docker and for system services.

1. Wait for work to finish, then stop the server: `npm stop`, or stop the service or container through its manager.
2. Back up the whole data folder.
3. Get the new source, then run:

   ```bash
   npm ci --no-audit --no-fund --omit=dev
   node node_modules/@openai/codex/bin/codex.js --version   # no version: run npm ci again
   node node_modules/playwright/cli.js install chromium
   bash start.sh
   ```

For Docker, run `docker compose up -d --build` and keep the volumes.

## An update reports `recovery-required`

1. Stop the service: `systemctl --user stop stellarcortex`.
2. In `<data folder>-updates/backups`, find the newest folder that is not named `failed-` or `interrupted-`. It holds the data from before the update.
3. Move the data folder aside, and copy that backup in its place.
4. In `<data folder>-updates/current.json`, check that `root` points to the release you want. Delete that file to go back to the install folder.
5. Start the service: `systemctl --user start stellarcortex`.

## The virtual computer's update failed

A failed root step restores the previous version by itself, and the app stays as it was. Its details are in `journalctl -u 'stellarcortex-kit-update@*'`, and backups are in `/var/lib/stellarcortex/desktops/backups`. To run the same step again, press **Update now**. To rebuild the root-owned parts from a clone, follow [the host guide](../deployment/ubuntu-desktop/README.md).

## The virtual computer never gets updates

The root step runs only on a host with `/etc/stellarcortex/kit-version`, which `deployment/ubuntu-desktop/host-install.sh` writes. A host set up by hand from a bundle does not have it, so its root-owned parts stay as they are. Run `host-install.sh` once to add it.

## The computer is off

Settings > Computer shows when the computer is off, with a **Start** button. You can also start it as root:

```bash
python3 -I /opt/stellarcortex-desktop-broker/deployment/ubuntu-desktop/boot.py --now
```

A plain `virsh start` skips the network guard check.
