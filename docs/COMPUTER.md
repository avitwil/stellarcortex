# Bot computers

Each bot has a computer mode. The owner sets it in **Settings → Computer**. A bot, `stellarcortex_team`, a template or an import cannot set it, and it can change only while the bot has no running, waiting or queued work.

To stop a bot in the middle of a task, press **Stop**. That interrupts the turn, ends its host processes and cancels a running guest command or typing. On a virtual computer, Take control also cancels them at once. The mode can change once the task has stopped.

| Mode | The bot gets | Runs as |
|---|---|---|
| **No computer** | Browser, memory, Library files, connections | No shell, no desktop, no native provider tools |
| **Virtual computer** | Shell, files, browser and desktop in a QEMU/KVM Ubuntu guest | A separate unprivileged user in the guest |
| **Host control** | Shell and screen on this machine | The server's OS user |

A bot with no setting has no computer, or a virtual one on an installation whose environment policy sets `defaultAccess`. Delegated work runs in the receiving bot's mode, not the sender's.

**No computer** is enforced at each layer: `stellarcortex_shell` and `stellarcortex_computer` are refused and not offered, Codex runs the guest configuration on a thread of its own, and Claude Code runs with no native tools. Existing bots are included, so a bot that needs a shell must be switched on. Kanban validation needs shell receipts, so the bot of a validation stage needs a computer.

**Virtual computer** comes with `bash install.sh --service` on a host with KVM. The chat does not depend on it: while it is not ready the bot still answers, and only its computer tools report that. It never falls back to the host.

**Host control** is shown with this warning, and the owner has to confirm it: a host bot runs as the server's OS user, so its shell can read `private/*.key`, `access-key` and browser cookies, and can call the app's API as the owner. No application setting can stop that. Code running as the same user is inside the boundary.

| Platform | Virtual computer | Host control |
|---|---|---|
| Linux on X11 | Yes, with `/dev/kvm` and the root bundle | Shell and one shared screen; the service needs `DISPLAY` and `XAUTHORITY` |
| Linux on Wayland | Yes | Shell only: `xdotool` cannot control Wayland. Log in to an X11 session for a screen |
| Docker | No | Shell inside the container, no screen |

The host has one screen, so one bot uses it at a time. A task claims the screen until it finishes, and human takeover pauses bot input. Model input goes through the app's approval flow, including after a screenshot. The app refuses coordinates from an expired screenshot or after a display geometry change.

The app has no sudo feature and no setting for one. `sudo`, `su`, `pkexec` and `doas` are refused for every bot, on the shell tool and in native requests. The refusal is best effort: a host with passwordless sudo can still be reached by native shell tricks. If a host applied the old `NoNewPrivileges=no` drop-in, remove it.

## Logging in to a site

A bot opens the login page, then calls `stellarcortex_secret {target:'browser-login'}`. The tool has no value parameter. It reads the page itself and opens a masked dialog outside the chat. The owner types there, the tool re-checks the target, fills, submits and clears, and the model gets only `{status, passwordFieldStillShown}`. `submitted` does not mean logged in: the bot reads the page next. The call adds no taint and lifts no block, so it works in a job that read external content.

The prompt holds no model text. It shows the bot, the conversation, the real host in ASCII, the submit host if it differs, an `xn--` warning, and whether the owner named the site in this task. A site the owner did not name gets a red warning. The navigation gate limits where a tricked bot can get before any prompt appears.

| Target | Result |
|---|---|
| Browser `input[type=password]`, visible, in the page's main frame, over HTTPS | Yes |
| Form with `method=get`, or with a plain-HTTP action | Refused. A form with no method is allowed, but any request carrying the password in its URL is blocked |
| Login in a frame from another site, desktop field, one-time code | Use Take control: the owner types on the live screen and the tool never handles the value |
| Process stdin | Not built. A bot-chosen command could print or send the value |

Two-step pages: the owner enters both values in the one dialog. The tool fills the username, presses Enter, and waits up to 5 seconds for a password field on the same origin. At delivery it re-checks the origin, field and submit host against what the prompt showed; any change refuses and wipes. While a request is open, that bot's browser tool and screenshots to the model are refused in all its jobs. There is one open request per bot and two per job, and none after a decline in that job. After `submitted`, the host joins the signed-in hosts, so account data read there cannot be carried elsewhere.

The value travels as raw bytes to `POST /api/secret-requests/:id`, with a 4 KiB limit and fixed error text. It never passes through an approval record, `state.json`, events or the JSON body parser. On a virtual computer it continues to the guest browser in the envelope field `transient`, which is left out of the broker journal, the guest ledger and their digests, so no hash of it exists to guess against. It does pass through the host broker's memory. The route needs a session and an `https:` or loopback `Origin`, so a password never crosses a plain-HTTP LAN link; the dialog says so instead of showing an input. The Linux user service, the broker and the guest services set `LimitCORE=0`, and Chromium is told not to offer saving the password.

The question box is not for passwords. A question that asks for one in plain words, or is marked secret, is refused, and the box tells the owner that the bot reads the answer. A bot can still reword the question, or ask in chat: the rule for the owner is that a password goes only into the login dialog.

What cannot be guaranteed:

- "Wiped" is best effort. Buffers are zeroed, but Playwright needs a JS string, which V8 cannot clear, and the value also sits in Chromium's memory and the owner's browser. Swap or hibernation could write it out.
- The site and its third-party scripts receive the password. That is what logging in means. A hacked real site can steal it, and a page can redraw the value from its own script.
- A bot with a shell shares an OS user with its browser. A malicious host bot could replace the Chromium binary. The same goes for the guest user on a virtual computer. Only a bot with no computer has no such route, and cookies are readable by any shell.
- The session persists in the profile, so the site stays logged in.
- The final defence against phishing is the owner reading the host.

## Watch and take control

1. Open a bot's conversation details and select **Computer**. The preview lets you follow its screen alongside the conversation.
2. Click the preview or its expand button. The screen fills the app window in **Watching** mode; opening it does not take control.
3. Choose **Take control**. Click the remote screen to focus input, then use your mouse and keyboard directly. Desktop mode supports ordinary clicks, right and middle clicks, double-clicks, dragging, pointer movement and vertical scrolling.
4. Type normally, including Hebrew, other Unicode text and input-method composition. Paste text with your browser's normal paste action. A small **More controls** section starts closed and provides text entry, explicit mouse modes and shortcut buttons when direct input is inconvenient.
5. Choose **I'm done** to return control to the bot while keeping the full-screen viewer open in Watching mode. Closing the viewer also releases control and returns to the preview; this close behavior is a StellarCortex implementation choice.

The expanded viewer uses a compact header and preserves the screenshot's aspect ratio. Opening it requests browser fullscreen directly from your click; if the browser does not support or permit that request, it fills the application viewport. Closing the viewer exits native fullscreen. Ctrl+Shift+Esc closes the viewer and returns control. Browser-driven fullscreen exits also trigger handback. Its layout is our implementation of the researched workflow, not a claim of pixel-identical Grok UI.

The account menu opens **General**, **Computer**, **Usage & Billing** and **Updates** settings. Bot details separately contain **Media**, **Computer** and **Routines**; the Computer tab controls the selected bot's screen.

## Docker

The image is server-only: no X packages, no desktop, entrypoint `node src/server.mjs`. Bots keep the headless browser, and API bots work. A bot set to host control gets a shell inside the container, and the status shows no display. QEMU needs root-owned configuration, libvirt and the broker on the host, so the virtual computer is not available here.

## Host screen on Linux

Start the app inside an X11 session, with the correct `DISPLAY` and `XAUTHORITY`, as the same user. `STELLARCORTEX_DESKTOP_DISPLAY` overrides `DISPLAY`. The packages are `xdotool`, `x11-utils` and `imagemagick`. Ubuntu GNOME defaults to Wayland, which cannot be controlled, so log in to an X11 session or go without the screen. An SSH connection without X11 is not a desktop.

## Keyboard and coordinates

The input adapter supports combinations including `Control+A`, `Control+C`, `Control+V`, `Alt+Tab`, `Shift+Enter`, `Meta+R`, arrows, Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp/PageDown and F1–F12. This does not mean that the local browser or operating system will deliver every shortcut to the page: reserved combinations can affect your local computer. Use **More controls** to send a supported remote shortcut explicitly.

Normal text, paste and IME composition use the browser's native text-input path, then send the resulting text to the remote computer. Command shortcuts use the physical key code so combinations such as Ctrl+A also work with a Hebrew keyboard layout. Input is queued in order, and ending a control session cancels remaining stale input.

The clipboards are not synchronized. Native Ctrl/Cmd+V pastes text from your local clipboard into the remote input path. Ctrl/Cmd+C sends a shortcut to the remote application and does not copy its selection back to your local clipboard; the remote application's platform determines which copy shortcut it accepts. The explicit **Ctrl+V** button in More controls sends the remote paste shortcut, using whatever clipboard content is available there. Image/file clipboard transfer is not implemented.

Clicking uses screenshot coordinates, not CSS coordinates. Screenshots scale down to a maximum 1600×1200 while retaining native geometry metadata. The UI maps the actual displayed image bounds to the returned width and height; surrounding empty space is not part of the remote screen.

## Technical references and verification scope


Automated tests verify permission gating, takeover exclusion, lock ownership, coordinate mapping, stale geometry and key validation through injected workers, and the tool lists of each mode on the real Claude Code and Codex binaries through a local stub. Live Linux desktop and installer verification, when performed, is recorded in VALIDATION.md. Docker build and platform-specific input should not be claimed tested solely because adapter unit tests pass.
