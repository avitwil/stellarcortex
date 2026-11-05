# Shared environment computer and teaching

The Linux desktop provider uses QEMU/KVM with an Ubuntu Server guest. One environment computer can host separate non-sudo bot users, Xfce/TigerVNC desktops, browser profiles and private session sockets. Each bot sees its own screen. This is shared VM infrastructure with per-user isolation, not a VM boundary between these bots. Existing files and browser credentials are not copied into new sessions.

The interface embeds authenticated noVNC display, with side-panel, expanded browser-window and device-fullscreen modes. Display modes preserve the connection. Server-side ownership coordinates human and agent input, revokes stale control, and releases held input on disconnect. Screens and private browser sessions refer to the same visible desktop. New bot access defaults to the environment policy and can be disabled per bot; provisioning additionally requires an installed, administrator-approved policy.

## Teaching

1. Use the bot desktop, then choose **Teach from screen** and state the intended result.
2. Capture a reference image explicitly; review/crop/mask it before retaining it.
3. Collapse the non-modal teaching panel and demonstrate actions on the desktop.
4. Stop and review the recorded action outline. Explain targets and success checks rather than relying on coordinates.
5. Save the skill for that bot. Saving does not start a model or replay input.
6. Ask the bot explicitly to use the saved skill. It reads the reviewed instructions, action outline and images, observes current targets, and uses the normal action authorization path.

Authorized forwarded clicks/drags, scrolls and command keys are recorded. Forwarding is not proof that an application accepted an action. Printable typing becomes a manual-input placeholder and pauses recording; raw keystrokes and clipboard contents are not retained. In review, each text step can remain manual or contain exact ordinary text explicitly supplied and confirmed by the user (up to 4096 characters, including Unicode). Approved text is stored in the existing skill store and transmitted to the chosen model provider when used. Do not enter passwords, tokens or private text. Pattern checks reject obvious secret-like input but cannot guarantee detection; the graphical display stream cannot identify all password fields. Screenshots require their own review and masking.

Tool cards display commands, arguments, status and output in readable fields while retaining complete approval context and underlying records. Codex visual tool results are forwarded as native images rather than base64 text.

## Installation and compatibility

See [the desktop installation guide](../deployment/ubuntu-desktop/README.md). Installation of the app alone does not modify host virtualization, networking, privileges or guest lock policies. Existing installations require backed-up upgrades and explicit infrastructure configuration. Do not run a fresh installer over an existing deployment.

The new provider is Linux/KVM-specific. It is the virtual computer mode in Settings > Computer; host control is the separate mode. This publication contains the web/server interface and desktop source, not Android development or artifacts.

## Verification and limits

Automated Node and Python tests and the desktop/mobile teaching-panel fixtures cover the provider, display modes, ownership hand-back and the teaching flow. Live capture, action recording, review and saving with two bots, and model interpretation of reviewed images, have been checked on a configured KVM host. Fully model-driven replay of recorded action and text skills has not been validated. Fixture checks are not a substitute for a fresh-host installation test or for accepting autonomous tasks.

The repository contains only portable fixtures. Deployment-specific IDs, endpoints, audit records, screenshots, keys, VM disks and user state are not included.
