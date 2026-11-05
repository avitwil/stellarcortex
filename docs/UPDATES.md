# Permission modes and software updates

## Claude permissions

Settings → General → Claude permissions contains a workspace default and a
separate override for each Claude bot. Existing installations migrate to Manual;
bot templates and agent tools cannot enable dangerous permission settings. Changes
are rejected while the affected bots have queued, running or approval-waiting work.
An override remains independent of later changes to the workspace default.

| Choice | Claude Code argument | Behavior in this integration |
| --- | --- | --- |
| Manual | `--permission-mode default` | Existing native Bash/write/edit approval prompts are retained. |
| Automatic | `--permission-mode auto` | Claude's classifier reviews native actions. Account, model and managed-policy support are checked by the CLI; failures are reported without retrying in another mode. |
| Free (Dangerous) | `bypassPermissions` | Requires confirmation to save, but **cannot run** under the existing `--restricted` boundary. The task fails before authentication/inference; choose a supported mode to resume work. |

In every mode, instructions come only from the owner and other bots in the tool.
Gmail, Google, MCP output, webhook payloads, web pages, desktop screens and other
external tool results are data. Once a job reads such content, it cannot run shell
commands or change files, and there is no approval path. The block covers the rest of
the conversation, because later jobs reuse its threads and messages, and it follows
hand-offs and results to other bots and chats. A blocked job also cannot change memory,
skills, routines or the team. Claude and Codex never receive external content in a turn
that has shell tools: the read is refused and the job restarts without them, on the same
session for Claude and on a new thread for Codex. Claude also has a PreToolUse hook as a
second layer. Codex's own web search, connectors and MCP servers are off so that external
content goes through tracked tools; add those servers under Connect apps instead. API and local providers are checked in the engine. Content a clean job fetches through its own shell
cannot be tracked.

Browsing is not limited by itself. The harm needs untrusted content, private data and a
way out together, so a way out is limited only once private data is in the task. Reading
a connection, a workspace file or a signed-in page, receiving an attachment, or receiving a
result from a task that did, marks the task as sensitive. A sensitive task can open only
the sites the owner named in that task, or opened before it read anything external. If
private data arrives after a web page, the task opens no more pages. A task started by a
webhook opens no pages and cannot click or type in one. A refusal never prompts: the bot says which site it needs, and the
owner names it in the next message.

In a task with no private data, browser clicks, typing and form fills do not prompt on a
site the owner named or on a site that is not signed in. With private data in the task,
they are free only on a signed-in site the owner named; anywhere else they keep their
approval. After private data arrives behind a web page, they are
refused like opening a page, on any site, with no prompt, so the data cannot leave through
a form. Scrolling never prompts.

Risks that remain:
- **Text inside a logged-in account can steer a click that runs as the owner.** On a
  signed-in site the owner named in the task, clicks and typing have no prompt. A message
  in webmail, for example, could lead the bot to click Delete or Pay.
- An injected page can steer browsing among public sites, so results can be wrong, and
  visits reveal the server's address.
- Data that is not marked can leave a task with no private data: the owner's message,
  bot instructions and memory.
- A site the bot opened before reading anything external counts as named, even though the
  bot picked it. If the task already read a private file, that site can receive it later.
- If the owner names an attacker's site in the same request as a mail read, that site can
  receive the mail text. Open redirects and shared domains widen "same site".
- Sites logged in before this feature count as signed in only after the next Take control.

OS elevation is not a feature. Bots have no managed sudo tool, and recognized elevation
commands are refused in every mode. That check is best effort: on a host with passwordless
sudo, shell tricks can get past it. If you applied a `NoNewPrivileges=no` drop-in for the
old sudo feature, remove it.

**Clear conversation** in a conversation's menu is the only way to lift the block. It deletes
the saved messages and forgets the provider threads, so nothing carries the content
forward, and clears the block in the same step. It is refused while a job runs in that
conversation and for Kanban conversations. Bot memory and workspace files are kept.
Transcripts the provider CLIs store themselves stay on disk, but are never resumed.

The UI shows the selected effective setting and whether it is inherited, overridden
or blocked. It does not promise account eligibility for Automatic. An explicit
different mode reported by CLI initialization fails the turn. Application MCP tools
still use StellarCortex's own approvals, scope checks and takeover controls in all
modes. No OS sandbox, managed policy, tool allowlist or application scope is removed.

Claude's official [CLI reference](https://code.claude.com/docs/en/cli-reference)
and [permissions documentation](https://code.claude.com/docs/en/permissions), checked
2026-10-27, specify both the mapping and that `--restricted` refuses bypass. Enabling
native Free mode would require a separate approved security design; removing this
boundary is not part of this release.

## Check from Settings

Opening Settings → Updates checks the latest GitHub release of `avitwil/stellarcortex` through the anonymous API, fetches that release's signed manifest, verifies it, and compares the version with the installed one. Nothing follows the `main` branch, and drafts and prereleases are not offered.

- Newer: the version, its notes and **Update now**.
- Not newer: a statement that the install is up to date.
- The check failed: the reason and **Check for updates**. GitHub limits anonymous API calls per address, so the reason says when to try again. No network, a release with no manifest and no published release each have their own reason.

Checks need the normal login, use bounded requests, share concurrent checks, and cache for 30 seconds. They do not interrupt work.

The update request accepts only a recently checked version and explicit confirmation. It cannot accept a URL or a shell command. A changed offer needs a new confirmation.

## Signed releases

Each GitHub release carries three assets: the tarball, `release.json` and `release.json.sig`. `release.json` is the manifest, with the tarball's SHA-256 and size. `release.json.sig` is an Ed25519 signature over it, made with an offline key. The public keys are pinned in `update-keys.json`, which ships inside each release.

```json
{
  "schema": 1,
  "version": "0.2.0",
  "date": "2026-11-05",
  "notes": {"en": "...", "he": "..."},
  "file": "stellarcortex-0.2.0.tar.gz",
  "sha256": "...",
  "size": 12345678,
  "updateProtocol": 1,
  "kitVersion": "0.2.0",
  "commit": "..."
}
```

GitHub and HTTPS are only transport. The API answer only says which tag to fetch. An update is refused, and the running release stays as it is, when:

- The signature fails, or the key is not pinned. An install with no pinned key trusts nothing.
- The manifest's version differs from the release's tag.
- The offered version is not above the installed one.
- `updateProtocol` does not match the supervisor.
- The tarball's size or SHA-256 differs from the manifest.
- The extracted `package.json` holds another version, or the release pins no key.

Download addresses are built from the fixed repository and the version. The manifest cannot point anywhere else.

The one-line install fetches the latest release and applies the same checks, with keys embedded in `install.sh`. That script is served over HTTPS and is not itself signed, so the first install trusts the website. After that, the app trusts only its pinned keys.

### What signing does not cover

A manifest has no expiry and no serial number, because an expiring manifest would turn every check into a failure on a project with no recent release. So someone who controls the repository but not the key can hide newer releases from installed copies. They cannot offer an unsigned release, or one older than the installed version.

A new install has no installed version to compare with, so `install.sh` holds a minimum version, set when it was built, and refuses anything older. Between two copies of `install.sh`, the same attacker can still serve the signed releases in that range. There is no revocation: a signed release stays valid, so a bad release is fixed by publishing a newer one.

To publish a release, see [RELEASING.md](RELEASING.md).

## Applying an update

A service from `bash install.sh --service`, and `bash start.sh`, run `scripts/managed-launch.mjs`, the update supervisor, which runs the server as its child. It needs no root, and its releases and backups are in `<data folder>-updates`. If that layout is not possible, such as for root or when the data folder is its own mount point, the service logs why and runs the plain server, and Settings shows that this install cannot update itself.

The supervisor can also run in the foreground with explicit folders:

```sh
node scripts/managed-launch.mjs --manager-dir /home/you/stellarcortex-updates --data-dir /home/you/.stellarcortex
```

Application, manager and data folders must be separate, with no nesting or symlinks, and manager and data must share a filesystem. Use one supervisor per data folder.

After **Update now** and confirmation, the server rejects active or queued tasks, pending operations and recently created Realtime voice sessions. It freezes new API mutations, webhooks and scheduled work. The supervisor repeats the signature checks, downloads the release, and runs `npm ci --ignore-scripts`, `playwright install chromium` and a syntax check in a separate folder. A Git checkout with local changes refuses to update.

Only after staging succeeds does the server stop. The supervisor backs up the whole data folder. Provider home folders outside it stay untouched, and symlinked data is rejected. A candidate starts with tasks and mutations disabled, and its identity and HTTP health must match the release. The pointer commits before tasks are enabled. A failed check before that restores the previous release and the backup, and keeps the failed data for inspection. A staging failure keeps the current server running.

The browser may need to sign in again after the restart. Reopen Settings → Updates to see `updated`, `rolled-back` or `recovery-required`. A journal supports recovery if the supervisor stops during the health probe. Once tasks are enabled, automatic rollback is off, because replaying tasks could repeat external actions. After a successful update, the three newest releases and backups stay, with the running release, and older ones are removed. Failed and interrupted backups stay for inspection. Protect all of them like live credentials.

The supervisor file itself stays at the install path, and `updateProtocol` guards against a mismatch.

## The root-owned parts of the virtual computer

The manifest's `kitVersion` names the last release that changed anything the root step packs or pins: `src`, `scripts`, `deployment`, the lockfile and the keys. So most releases run it. When that is above `/etc/stellarcortex/kit-version`, including on a host that skipped that release, the supervisor asks the broker to run the root step, after staging and before the app switches. The app can pass only a version, and the broker only starts `stellarcortex-kit-update@<version>.service`. That service runs root-owned code. It reads its keys from `/etc/stellarcortex/update-keys.json`, fetches the release itself from the fixed repository, repeats every check above against `/etc/stellarcortex/kit-version`, renders a new bundle and runs `upgrade-approved.sh`. So the app user, or a bot running as that user, can only ask for a signed, newer release.

If the root step fails, `upgrade-approved.sh` restores the previous version, and the app does not switch. If the root step succeeds and the app then fails its health check, the app rolls back and the root parts stay on the new version. So a release must keep the broker compatible with the release before it.

A host without `/etc/stellarcortex/kit-version`, which `host-install.sh` writes, gets no root updates: see [RECOVERY.md](RECOVERY.md). After a root step the two newest bundles and three newest backups stay. A computer already built keeps its guest worker until it is rebuilt.

## Root-owned systemd and containers

These installs can check, and show that they cannot update themselves. See [RECOVERY.md](RECOVERY.md).

## Validation scope

Tests use fake Claude processes and temporary data only. They cover permission
mapping, migration, overrides, confirmation, unsupported auto, authenticated routes,
CSRF, active work, concurrent requests, signed release checks, backup and rollback faults,
and the English/Hebrew UI. No real bot is placed in bypass mode. Health checks confirm
application startup, not every provider's external account or future task behavior.
