# Claude alongside Codex

[עברית](CLAUDE.he.md)

**Before you connect a provider:** check the provider's current terms of use yourself. Following them is your responsibility. Terms can change, and a connection that works today may stop working. StellarCortex does not say that using any provider's account or subscription is permitted, and it is not affiliated with any provider. See [provider terms](../README.md#provider-terms).

StellarCortex lets you choose a provider for each bot: Codex or Claude. Bots from both providers share the same chats, groups, task handoff, memory, routines, library and bot computer. Each bot uses its own subscription's quota. A provider change applies to the next task; a task that already started stays with its original provider.

## Sign in

The installer downloads the official, unmodified Claude Code package as an optional dependency. If that fails, Codex stays available and the Claude settings show the problem. You need a system Claude Code supports and an account with access to it.

1. Press **Connect Claude** in Settings. The server runs the official sign-in, the app shows the sign-in link, and if a code appears you paste it there. You can also run `bash claude-login.sh`, or copy the sign-in command from the Claude settings: it holds the full path and the service's environment, and works from any folder.
2. Complete the sign-in in Claude Code's own window and the browser that opens. StellarCortex receives no password or OAuth token. A sign-in code pasted in Settings passes through the app to Claude Code and is not stored.
3. Return to StellarCortex's settings and refresh the Claude connection.
4. Create or edit a bot and choose Claude. The picker next to the message box can also change the provider and model.

On a remote server, sign in **on the server, as the user who runs StellarCortex**. An account signed in on another machine is not signed in on the server or in a container. See [DEPLOYMENT.md](DEPLOYMENT.md).

In Docker:

```bash
docker compose exec stellarcortex node scripts/claude-auth.mjs
```

Compose keeps Claude's official config folder in a separate volume. Do not move sign-in credentials through a bot export or an install package. A new deployment needs the owner's own sign-in.

## Models, effort and speed

The picker shows **exact versions**, such as `claude-sonnet-5-5`, apart from moving aliases such as `sonnet`. You can pin a version, or choose an alias that lets Claude Code move to a newer model later. The list is read from Claude Code's startup protocol without sending a user message or a model request. The answer includes the version ID and the effort levels the CLI publishes. If discovery fails, a list of versions from the official documentation appears, marked as unverified; Claude Code still checks eligibility when the task starts.

The default is the Claude account's default. The general Codex model does not affect Claude bots. An eligibility error is shown to the user, and nothing switches by itself to another model or account.

Effort options depend on the model and the Claude Code version. The speed mode supported in this integration is Standard. Claude's Fast mode is not offered here, because its documentation ties it to extra usage billing beyond the subscription quota. Nothing switches to API billing by itself.

Changing provider resets model, effort and speed choices that do not belong to the new provider. The chat history in the interface stays, and the new provider receives context from the latest messages. Sessions of the two providers are stored separately; one model's full internal history is not copied to the other.

## Running and permissions

The integration runs unmodified Claude Code in programmatic mode with streamed output. StellarCortex tools reach it through a local MCP server for each task. Tool calls and conversations between bots go through the shared engine and appear in the interface. Approvals for Claude Code actions go to StellarCortex's approval box. Stopping a task also closes the Claude Code process and its tool connection.

File tools run in `--restricted` mode, and the working folder is the install's `workspace` folder. System commands and writes need approval. This is not a VM or operating-system user separation: an approved system command has the server user's permissions. To separate it from a personal computer, use a dedicated Linux, container or VM environment, as the deployment guide describes. Claude's personal MCP connections, plugins and user settings are not loaded automatically in this restricted integration.

## Diagnostics

The account menu and the usage settings have separate meters for Codex and Claude. The Claude meter reads the official `claude -p "/usage" --output-format json` command, a local Claude Code command that runs no model. It shows the use of the current window and the weekly quota, reset times and the last update. Percentages are not calculated from token counts. A manual refresh asks for a new report; regular reads can use a short cache. When a read fails, saved data is marked as old, and missing data is not shown as zero.

The app keeps only the quota data the meters need. It does not store the raw report, account tokens or the breakdown of local conversations' use.

```bash
node scripts/claude-auth.mjs --status
npm run doctor
```

A sign-in check makes no model request and does not prove eligibility for every model. To confirm an account in practice, send a short message to a Claude bot after signing in.

Sources: [official sign-in](https://code.claude.com/docs/en/authentication), [programmatic use](https://code.claude.com/docs/en/headless), [CLI flags](https://code.claude.com/docs/en/cli-reference), [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance). This version's test results are in [VALIDATION.md](VALIDATION.md).

## Permission modes

In Settings you can choose manual, automatic or free (dangerous) mode, with a separate setting for each bot. Automatic mode uses Claude's own check and does not bypass permissions. Free mode needs confirmation to save, but is blocked in practice under `--restricted`; workspace limits are not removed. [Details and limits](UPDATES.md).
