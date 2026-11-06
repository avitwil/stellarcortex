# Ubuntu desktop provider deployment

This directory contains administrator-reviewed setup and lifecycle components for the Linux QEMU/KVM desktop provider. It is source, not a preconfigured installation or permission grant.

Prerequisites: a Debian or Ubuntu host (the bundle uses `apt-get` and the `libvirt-qemu` user) with usable `/dev/kvm`, Node.js 22.16+, an existing StellarCortex service under an unprivileged account (the user service from `bash install.sh --service`, or a system service), enough memory/disk for the selected guest plan, and the Ubuntu Server ISO described below. The computer gets half of the host's memory and CPUs, at least 4 GiB and 2 CPUs, and an 80 GiB sparse disk. All bots share it, so the renderer checks that the host keeps 6 GiB for itself. Use `--vm-memory-mib` and `--vm-vcpus` to choose other sizes.

**Which ISO, if you give your own:** Ubuntu Server 26.04 LTS for amd64, from [releases.ubuntu.com](https://releases.ubuntu.com/). The file is named `ubuntu-<version>-live-server-amd64.iso`. Not the Desktop ISO: the installer checks this and stops. Download `SHA256SUMS` and `SHA256SUMS.gpg` from the same page, and verify them:

```sh
gpg --keyserver hkps://keyserver.ubuntu.com --recv-keys 843938DF228D22F7B3742BC0D94AA3F0EFE21092
gpg --keyid-format long --verify SHA256SUMS.gpg SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

The first line gets Ubuntu's image signing key by its full fingerprint, so gpg accepts no other key. It needs `dirmngr`, which you can add with `sudo apt-get install dirmngr`. Look for `Good signature` from "Ubuntu CD Image Automatic Signing Key (2012)". The warning that the key is not certified is normal.

Nothing in the code is tied to one point release, but an older release is refused before anything is installed, because first boot needs the Node.js that 26.04 packages. The bundle records the hash of the file you give it. The computer adds its own screen software on first boot: Xfce, TigerVNC, D-Bus, xauth, the browser and fonts including Hebrew. That step needs internet access.

## Install

**You normally do not need this section.** `bash install.sh --service` does all of it: it copies the kit to a root-owned folder, renders the bundle, installs it and starts the build. The build downloads the Ubuntu Server ISO, checks it against Ubuntu's signed hash list with the key pinned by fingerprint, and installs the computer in the background. Run it from a fresh clone: its root step uses that folder once, and later updates never do.

The steps below are for a host with a hand-made service, or to give your own ISO with `--iso`. The app must already be installed and started once. With your own values for the user, the service, the app folder and the ISO:

```sh
sudo git clone https://github.com/avitwil/stellarcortex.git /root/stellarcortex-kit
sudo git -C /root/stellarcortex-kit checkout "$(git -C /path/to/your/app rev-parse HEAD)"
sudo bash /root/stellarcortex-kit/install.sh --desktop-host-bundle --output /root/stellarcortex-bundle \
  --app-uid "$(id -u your-app-user)" --app-service stellarcortex.service --iso /path/to/ubuntu-live-server-amd64.iso
sudo /root/stellarcortex-bundle/install-approved.sh "$(sudo cat /root/stellarcortex-bundle/APPROVAL-SHA256)"
```

Then restart the app so that it reads the new settings. The renderer finds which kind of service it is, and the script prints the right command. For a user service, run `systemctl --user restart stellarcortex.service` as the app user, and `sudo loginctl enable-linger your-app-user` once so that the app comes back after a reboot. For a system service, run `sudo systemctl restart stellarcortex.service`.

Rendering runs `npm ci` in that clone, so root needs Node.js and npm. The renderer also looks in `/usr/local/bin`, which `sudo` often leaves out of PATH. If `install-approved.sh` stops partway, fix the cause and run it again. Do not render from the app's own folder: the app user can change it, and root would run what it holds. To update a host later, pull the clone, render into a new folder, and run that bundle's `upgrade-approved.sh` the same way. Then set a bot to a virtual computer in Settings > Computer.

`bash install.sh --desktop-host-bundle --help` describes the portable bundle renderer. **Render as root, from a root-owned clone of this repository, into a folder only root can reach.** Root runs what the bundle holds, and a host-mode bot runs as the app user, so the renderer refuses a source that user owns and the bundle scripts refuse files or folders others can change. Rendering does not install packages or activate services. Supply the actual app UID, service name, a new output directory, and `--iso` with the path of your verified Ubuntu Server ISO. The bundle records that file's hash, not a fixed version, and the installer copies it to `/var/lib/stellarcortex/desktops/media/`, next to the guest payload. Start the app once first: the renderer derives the owner identity from the access key in its data folder, unless you give `--account-id`. It writes the app data folder into `desktop-provider.json`: it reads `--data-dir` or `STELLARCORTEX_DATA_DIR` from the service and its environment files, then falls back to `.stellarcortex` in the owner's home. Review the generated manifest, exact package/network changes and approval hash before running the generated privileged installer. `install-approved.sh` also writes `provisioningPolicy` with those values, and it refuses an existing desktop configuration. For a host that is already set up, render a bundle from the new code and run `upgrade-approved.sh` with the same hash: it stops if a computer is being prepared, backs up the configuration, units and runtime under `/var/lib/stellarcortex/desktops/backups/`, replaces the runtime and units, restarts the broker, and refreshes only `provisioningPolicy` and `dataDir`. Registrations, sessions and your boot choice stay, and it does not touch the firewall or network. Computers that already exist keep the guest code they were installed with. Keep generated bundles and deployment configs out of Git.

The components use private Unix VNC/QMP and guest-session sockets with an authenticated existing-origin WebSocket display, not public VNC/debugging ports. The example network is dedicated NAT, with no LAN bridge or public inbound access. See [Firewall](#firewall) for how it works with a host firewall. No broad sudo or libvirt group access is necessary for the application.

## Firewall

The computer needs DHCP and DNS from the host, and outbound traffic, on its bridge `virbr-scx`. When a host firewall could block that, the install names it and asks once. With a yes, `network-coexistence.py` finds the firewall and adds what the bridge needs. There is nothing to configure.

| Firewall | What is added |
|---|---|
| nftables | Three commented rules at the top of each base `input` filter chain that can drop traffic, and two in each such `forward` chain |
| ufw | Three `allow in on virbr-scx` rules and one `route allow in on virbr-scx` rule |
| firewalld | Nothing when the `libvirt` zone exists, otherwise a zone named `scx-desktops` that holds only the bridge |
| iptables, including Docker's forward policy | The same five rules, with comments |

Every rule names the bridge. Existing rules, chains, policies and SSH are not changed, and host inbound access does not widen. The guard table runs first and allows the computer only DHCP and DNS to the host and public addresses, so the forward rules name no uplink and keep working when the host changes network.

`stellarcortex-desktop-network-coexistence.service` applies the rules at every boot. It keeps running and checks every 30 seconds, so a firewall reload, restart or stop from any tool leaves the rules off for 30 seconds at most, and a firewall that loads after it gets them too. If a rule cannot be put back, the reason is in the service's journal. To put them back at once, run `sudo systemctl reload stellarcortex-desktop-network-coexistence.service`.

The guard table has its own check on every host with a computer, with or without those rules. `stellarcortex-desktop-guard-check.timer` looks for the table every 10 seconds and reloads the guard if a flush took it, so a full flush by a tool other than `nftables.service` leaves the computer unguarded for 10 seconds at most. It touches nothing else, needs no firewall answer, and leaves a guard you stopped stopped. `sudo systemctl disable --now stellarcortex-desktop-guard-check.timer` turns it off, and it stays off after a reboot or an upgrade.

To remove the rules, run this. They stay removed after a reboot, and the computer has no network until your firewall allows it another way:

```sh
sudo systemctl disable --now stellarcortex-desktop-network-coexistence.service
```

With a no, nothing changes and the install finishes without a computer. Chat keeps working. To add the computer later, run the install again and answer yes.

If a firewall arrives after the install, or the install could not see one, the build stops with "no network address" after 15 minutes without a lease. Run this on the host, then press Retry in Settings > Computer:

```sh
sudo python3 /var/lib/stellarcortex/kit/deployment/ubuntu-desktop/network-coexistence.py --install
```

A run of `install-approved.sh` by hand stops on such a firewall. Run it again with the hash and `--firewall-reviewed`.

`stellarcortex-computer-build@.service` builds the computer: the install starts it, Settings > Computer shows its progress, and Retry there goes on from the step that stopped if first boot failed, and otherwise clears the failed try and starts again. If a built computer is off, Settings > Computer says so and offers **Start**, which runs `stellarcortex-computer-start.service`. Only this unit can install a computer. All bots use that one computer, each with its own user and screen. A bot's session is created by itself once the computer is ready, by `stellarcortex-session-provision@.service`, and a deleted bot's session is removed by `stellarcortex-session-remove@.service`. The installer writes `sessionProvisioning` and `environmentComputer` when the computer is ready. All bots share one virtual computer, and it comes back by itself after a host reboot, once the network guard is up. To keep it off after a reboot, turn off "Start after a reboot" in Settings > Computer. To start it then, run this as root: `python3 -I /opt/stellarcortex-desktop-broker/deployment/ubuntu-desktop/boot.py --now`. A plain `virsh start` skips the network guard check. `stellarcortex-session-provision@.service`, which the bundle installs and the broker starts, and the guest installer support separate non-sudo bot users on a shared environment VM, with per-user browser profile, D-Bus session and display. Preserve old VMs, accounts, files and effect journals. Do not copy browser credentials into new bot sessions. Guest autologin and no-idle-lock policies have physical/console-access implications and require deliberate administrator configuration.

`desktop-provider.example.json` starts disabled with no registrations. Actual registrations, account identities, bot membership, environment policy and session allocations belong in protected deployment configuration. Enabling default bot access in the app does not install the privileged helper or grant host access.

## Removing a computer

To install a computer again, or to clear one that failed, run this as root. It deletes the computer and its disk, and every record of it, so copy out anything you need first:

```sh
python3 -I /opt/stellarcortex-desktop-broker/deployment/ubuntu-desktop/installer.py remove-computer --vm-id 02 --confirm-delete scx-desktop-02
```

The next bot set to a virtual computer installs a new one.

**How many bots fit.** All bots share the computer's memory, and each one runs its own desktop and browser. The computer's memory sets the limit: 1 GiB for the system and 1.5 GiB for each bot, which is a safe estimate, so 15 GiB holds 9 bots. A bot past the limit chats as usual, has no desktop and is told so, and it gets one when another bot is deleted. A bot moved off the computer keeps its desktop and its place until it is deleted, because its files are there. To set another limit, add `"maxSessions": <number>` inside `sessionProvisioning` in `/etc/stellarcortex/desktop-broker.json`.

**The browser on the computer.** First boot downloads the Chromium build of the app's pinned Playwright into `/opt/stellarcortex-browsers`, from Playwright's download servers, and refuses it unless it matches the SHA-256 in `guest/chromium-pin.json`. After a Playwright update a test fails until that file has the new build's values, taken from a real download. Every bot runs that one copy as its own user, with the sandbox on. Each computer fetches its own, so StellarCortex redistributes no browser.

**Claude and Codex on a virtual computer.** The bundle enables them with the API and local models. Their programs run on the host as the app user, with their own tools off, and every tool call goes to the bot's user on the computer. So a subscription login stays in the app user's home on the host and never enters the computer: connect it once in Settings, as for any bot. The bundle installs each program under `/opt/stellarcortex-runners`, owned by root, and pins its SHA-256 in `desktop-isolation.json`.

The Update button in Settings updates them with the app. After an update by hand, these programs stay at the pinned version. If a pin stops matching, or a new app version changes the Codex tool policy, only that provider is off on virtual computers. The app still starts, nothing falls back to the host, and the bot's error says what to do: render a new bundle and run `upgrade-approved.sh`.

**Removing one bot from the computer.** Each bot takes one Unix user and one screen number, and the app says when none is free. To free one, remove the bot's row from `desktops` in `/etc/stellarcortex/desktop-broker.json`, from `records` in `/etc/stellarcortex/desktop-provider.json`, and from `sessions` in `/etc/stellarcortex/session-registry.json` inside the computer. Then delete its user and home inside the computer, and delete `/var/lib/stellarcortex/desktops/sessions/<bot id>.json` on the host.

See [shared desktop behavior and teaching](../../docs/SHARED-DESKTOP.md). Use local regression/fixture tests first; real installation, reboot and model acceptance require their own controlled verification. Source publication does not apply any host or guest changes.
