# Feature inventory and implementation status

This inventory compares StellarCortex with the publicly documented Grok Bot feature set ([official documentation](https://docs.x.ai/grok-bot/overview), checked October 2026).

StellarCortex is an independent, self-hosted implementation. It is not an exact clone or a complete replacement for every Grok Bot service. “Implemented” means the code exists; see [VALIDATION.md](VALIDATION.md) for what has been tested.

| Area | StellarCortex status | What it does / remaining difference |
|---|---|---|
| ChatGPT subscription | Implemented | Official Codex app-server auth; refuses API-key accounts for inference |
| API-key providers | Implemented | Multiple named API connections with discovered models in the per-bot picker; editable endpoint and Chat Completions, Responses or Anthropic Messages protocol. NVIDIA/OpenCode/OpenAI presets. Separate from subscriptions; keys stored outside workspace and never returned by settings APIs |
| Local model servers | Implemented integration | Ollama, llama.cpp, LM Studio, vLLM through configured OpenAI-compatible endpoints; no engine installation or model downloads; tool/vision support depends on model/server |
| Claude subscription | Implemented | Unmodified official Claude Code CLI; owner signs in using its own flow. Per-bot provider selection, separate sessions and mixed-provider handoffs. See CLAUDE.md |
| Separate provider usage meters | Implemented | Codex rate limits and Claude's native /usage report, with percentages, reset times, refresh, observation time and stale/error states. No inference call for quota retrieval |
| Linux installation | Implemented | Node + shell installer, optional systemd user unit |
| Server use | Implemented | Loopback service, SSH tunnel or configured HTTPS reverse proxy |
| Persistent named bots | Implemented | Name, role, instructions, color, private conversational context |
| Per-bot model, speed and reasoning | StellarCortex extension | Runtime-discovered models, including exact Claude versions separately from rolling aliases; model-specific effort levels and advertised speed tiers. Claude uses Standard speed. Choices apply to subsequent runs, delegation and routines. See MODELS.md |
| Bot-created teammates | Implemented | A bot can create or update real, persistent application bots and groups when the user requests it; no automatic fixed roster |
| Team coordination | Implemented | Manager relationships, delegation, task/result inspection, automatic return of results to the delegating bot |
| Avatars and presence | Implemented | Original SVG avatars, working/waiting indicators |
| Light/dark mode | Implemented | Dark, light, OS preference |
| Hebrew/English | Implemented | Localized core UI and direction-aware messages |
| Pin/sections/hide | Implemented | Sidebar grouping and non-destructive hiding |
| Delete and restore bots | Implemented, local Trash | Removal cancels work and pauses routines; history/files remain; restore returns the bot without automatically restarting routines |
| Bot templates | Implemented | JSON export/import; excludes memory, credentials and history |
| Public template marketplace | Not implemented | No hosted marketplace, public URLs or community moderation |
| Streaming conversation | Implemented | Agent text, tool records, failures and completion states |
| Group chats | Implemented, different routing | 2–6 bots, @name, @everyone and Reply-to-author routing. Untargeted requests select one coordinator deterministically instead of asking every member or reproducing Grok's internal respondent selection |
| Async handoffs | Implemented | Recipient wakes, works and returns its result; delegator resumes automatically, including with concurrency set to one. Duplicate/cycle/depth limits prevent unbounded exchanges |
| Visible bot conversations | Implemented | Collapsed message count and participant avatars inside the originating chat open the actual requests, streamed responses and coordinator follow-up; the expanded viewer is our design, not a verified pixel copy |
| Background queue | Implemented | Up to 4 concurrent jobs; one job per bot at a time |
| Mid-turn steering | Partial | New messages queue; Stop interrupts. No true turn/steer UI |
| Persistent memory | Implemented | Per-bot editable facts, agent save/list/remove tools |
| Automatic memory synthesis | Not implemented | Saving is explicit through the memory tool |
| Shared skills | Implemented | Create, list, invoke, agent save, delete |
| Teach by recording | Not implemented | No screen-recording-to-skill pipeline |
| Daily/interval routines | Implemented | Time zones, pause/resume, manual run, persisted schedule |
| Webhook routines | Implemented | Per-routine bearer key, 5-minute trigger throttle |
| Native Slack/GitHub triggers | Not bundled | External automation can invoke webhook; no event OAuth manager |
| Run history | Implemented | Jobs retained, latest 20 shown per routine |
| Approval cards | Implemented | Codex command/file/input requests and explicit browser, desktop-input and routine approval |
| Auto Review rules | Not implemented | No independent model reviewer or persistent auto-allow rules |
| Approval expiry | Implemented | 10-minute timeout; restart expires pending approvals |
| Headless browser workspace | Implemented | Shared persistent Chromium profile, per-bot pages; separate from the desktop browsers |
| Browser viewing/takeover | Implemented | Screenshots, manual click/type/keys/scroll/navigation |
| Browser agent tools | Implemented | Visible text + screenshots; action approval before interaction |
| OS desktop viewing/control | Implemented | Real screenshots, click/double-click/drag, Unicode typing, keys and scrolling; expanded viewer and human takeover. Screenshot transport is not a low-latency RDP/VNC video stream |
| Separate bot screens | Implemented on the QEMU virtual computer | Each bot has its own user, desktop and browser in one Ubuntu guest. See SHARED-DESKTOP.md |
| Isolated bot computer | Deployment support | The virtual computer mode on a Linux host with KVM. See COMPUTER.md and VALIDATION.md for requirements and verified scope |
| Host control | Per bot, off by default | The bot runs as the server's OS user. Screen on X11, shell only elsewhere. One screen, one bot at a time |
| Shell and file operations | Implemented for bots with a computer | Host control: Codex/Claude native tools and approved host processes, with the server user's OS permissions. Virtual computer: guest tools. No computer: no shell |
| Private networking | No built-in VPN/egress policy | Headless browser rejects private destinations; OS desktop applications follow their host/container network configuration |
| Per-user microVM isolation | Not implemented | One trusted owner per installation; use separate OS users/VMs |
| App connections | Implemented, external-account validation pending | Independent MCP registry and client, HTTP/SSE/stdio, API keys and OAuth, shared by all model providers; Google through an MCP service. See CONNECTIONS.md |
| OAuth plugin marketplace | Partial | Independent OAuth flows for MCP servers; no hosted marketplace, and no copied ChatGPT/Codex/Claude sessions |
| Uploads | Implemented | Up to 6 files, 25 MB each, 36 MB combined JSON request limit |
| Image/video/audio understanding | Model/tool dependent | Files are local inputs; processing depends on Codex's tools and installed programs |
| Library and downloads | Implemented | Bot publishes workspace files; pin, preview, download |
| Interactive HTML pages | Implemented locally | HTML artifacts render in sandboxed iframes with no network |
| Shared cloud Pages/real-time coediting | Not implemented | Local file previews, not shared cloud documents |
| Search | Implemented | Bots, conversations, message text, routines and artifacts |
| Clipboard and quoted reply | Implemented | Copy, visible quote context and stored reply reference; group replies route to the actual message author |
| Reactions/message branching | Not implemented | No reactions or separate threaded-branch interface |
| Draft preservation | Implemented | Browser-local composer drafts per conversation |
| Dictation | Partial | Browser SpeechRecognition when supported; may use browser vendor service |
| Read aloud | Partial | Browser speech synthesis, not OpenAI realtime voice |
| In-app voice conversations | Implemented, live audio verification pending | Browser speech or OpenAI Realtime WebRTC with a separately billed API key; transcripts run the selected bot, then its completed reply is spoken. Mute, interruption and end; browser capabilities/language voices vary. No telephone dialing or audio recordings. See VOICE.md |
| Notifications | Partial | Browser notifications while the client is open; no mobile push server |
| Mobile access | Responsive web UI | Connect to the same private host; not native iOS/Android apps |
| PWA | Manifest only | Standalone manifest; no offline mode or background push |
| Bot email inbox / forwarding | Not bundled | Requires separate email provider and connector |
| X @bot trigger | Not implemented | xAI-owned integration; cannot reuse its account or entitlement |
| Payment / Vault / X Money | Not implemented | No payment or credential-vault service |
| Image/video generation | Not bundled | Depends on separately available tools; no fake generation UI |
| Team Bots / RBAC / SSO | Not implemented | Single-owner install; group chats are between the owner's bots |
| Usage visibility | Implemented | Displays account rate-limit windows reported by Codex |
| Export/backup | Partial | JSON export; full backup requires stopping and copying data + Codex state |
| Projects and Kanban | Implemented | General and per-project boards with task and idea stages, bot routing, approval gates and pause/resume; bot work on a card starts only on an explicit action |
| Updates | Implemented | Signed GitHub releases, verified with a pinned key, applied with backup and rollback from Settings ([UPDATES.md](UPDATES.md)); Docker and root-owned services update manually |

## Architecture

Browser UI → authenticated local HTTP/SSE → durable state + queue → Codex app-server over stdio → ChatGPT subscription.

Dynamic tools route back through the engine to bot creation, memory, team handoffs, skills, routines, browser, desktop control and artifact publication. Parent/child task records carry results back to the delegating bot without requiring it to block a worker while waiting. User-visible bot exchanges remain linked to those actual task and message records.

The headless browser shares one persisted profile, with one page per bot. In isolated Linux desktop mode, each bot instead has its own X11 screen and GUI browser profile; files and the OS user are shared. The server must remain awake for scheduled work. See [computer deployment](COMPUTER.md) for the boundaries and [validation](VALIDATION.md) for what was tested.

## Priorities for further parity

1. Durable database with paging, streaming recovery and migration tests for large histories.
2. Lower-latency desktop streaming, stronger per-bot filesystem isolation and screen-recording teach mode.
3. A supported identity/connector registry, per-service event subscriptions and a secrets vault.
4. Account-aware native mobile/push and realtime voice, subject to supported OpenAI access.
5. Team tenancy, access controls, shared knowledge, audit policy and enterprise administration.
