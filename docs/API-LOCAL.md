# API keys and local models

[עברית](API-LOCAL.he.md)

**Before you connect a provider:** check the provider's current terms of use yourself. Following them is your responsibility. Terms can change, and a connection that works today may stop working. StellarCortex does not say that using any provider's account or subscription is permitted, and it is not affiliated with any provider. See [provider terms](../README.md#provider-terms).

StellarCortex supports several personal API connections, alongside the OpenAI API, Claude API and local engine connections. ChatGPT/Codex and Claude Code subscription connections keep working separately. You choose a provider and model for each bot, and tasks can pass between different providers.

## Set up a connection

Open **Settings → Models & connections → Add API provider**. Choose a provider, name the connection and paste the key it gave you. For a known provider the address fills in by itself; for any other, enter the API address from its documentation. Saving loads the model list, and the provider joins the picker at the bottom of the bot's chat. Choose the provider and model there. You do not need to type a model name when adding a provider.

You can add several connections, including several accounts with the same provider. Each has its own name, key, model list and usage. A manual model ID stays available as an advanced option for a provider that publishes no list. Leaving the key empty while editing keeps the existing one; removing a key has its own button. Do not paste keys into chats with bots.

The key authenticates the account; the **server address and request format** decide how to connect. No format fits every API. The general connection supports three streaming formats: Chat Completions, Responses and Anthropic Messages. A format's name does not limit it to the company of that name.

| Provider | Base address | Format |
| --- | --- | --- |
| NVIDIA | `https://integrate.api.nvidia.com/v1` | Chat Completions |
| OpenCode · Chat / GPT | `https://opencode.ai/inference/openai/v1` | Chat Completions or Responses, by the preset you chose |
| OpenCode · Claude | `https://opencode.ai/inference/anthropic/v1` | Anthropic Messages |
| OpenAI | `https://api.openai.com/v1` | Responses |
| Other provider | The base address in its documentation | One of the three supported formats |

On OpenCode, for example, GPT models use Responses and Claude models use Messages. Separate presets fill in the right format and address, and you can add several connections with the same key. The model list loads from `https://opencode.ai/inference/v1/models`. In the advanced settings of another provider you can set a different catalog address, on the same server only. A provider's published list can include models that do not fit the chosen format, so check the format in its documentation. The connection does not guess it from the model name. The Gemini and SystemOne formats are not supported. According to OpenCode's current documentation, some free chat models require the OpenCode client itself; outside use depends on your permissions and plan with the provider.

An API connection is billed by the API provider, separately from a subscription. StellarCortex does not switch to it by itself when a subscription reaches its limit. A connection test reads the model list and generates nothing. Being on the list does not guarantee permission, balance or support for every option during a task.

## Local engines

Choose an engine and enter the address of the API service you already run. Local connections and custom API providers can use loopback, LAN and tailnet addresses. Cloud metadata services are blocked in both, in every address form and through DNS.

| Engine | Default address |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| llama.cpp | `http://127.0.0.1:8080/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

The connection uses `GET /v1/models` and `POST /v1/chat/completions` with streamed output. You can change the address and port, and set a key if the server requires one. On a server that lists no models, you can enter an ID by hand. It is marked unverified until it runs, and the list check is not shown as passed.

**StellarCortex does not install an engine, download a model or start a model server.** Run the service yourself. There is no automatic switch to a cloud model. If your engine routes to a cloud, its own settings decide that routing and its billing.

The address is opened from the machine that runs the StellarCortex server. `127.0.0.1` inside Docker means that container, not the machine that shows the browser. If the model engine is on another machine, enter an address reachable from the server's environment. Docker Desktop usually offers the name `host.docker.internal`. You do not need to expose a model server to the internet.

## Bot abilities

Tools, task handoff, memory, routines and the browser all go through the shared StellarCortex engine. For the model to use them it must support tool calling, and the model server must use the matching template and parser. You can turn tools off for a connection meant only for chat. Viewing images and the screen needs a vision model; turn images on only when the model and server support them.

Effort and speed levels appear only when support for them is known. The speed of a local model depends mainly on the model, quantization, hardware and engine settings. No button promises Priority service for a local engine.

API models share file and command tools. Reading and listing are limited to the working folder; writing and commands need approval. An approved command runs as the server's user. The working folder does not isolate commands at the operating-system level. For isolated use, run StellarCortex in a dedicated Linux, container or VM environment.

## Usage and key storage

Subscription meters stay separate. For API and local models, the app shows counts of tokens and requests seen through this install, as far as the provider reported them. They are not a credit balance, a subscription quota or a whole-account report. No price estimate appears when the provider gives no reliable figure.

Keys are sent to the StellarCortex server only when saved, and are stored encrypted in the `private` data folder, outside `workspace` and the chat state file. The decryption key is in a separate file in the same folder, protected by user permissions as far as the operating system allows. Encryption does not protect against someone who already controls the operating-system user. Protect the data folder and remote access to the interface. A backup for restoring must include both private connection files.

Keys are never returned to the browser, to template exports or to install packages. On the built-in OpenAI and Anthropic cards the official address is fixed. On a personal API connection, the key and bot messages go to the address you set. Changing a connection's address requires entering the key again, so a saved key is never sent to another server by itself. HTTP redirects are not followed. Switching connections applies to new tasks; a task that already started finishes with the connection it began with.

Sources for general connections: [NVIDIA LLM API](https://docs.api.nvidia.com/nim/reference/llm-apis), [OpenCode Console models and endpoints](https://opencode.ai/v2/docs/console/models/).

Interface sources: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Claude Messages](https://platform.claude.com/docs/en/claude_api_primer), [Ollama](https://docs.ollama.com/api/openai-compatibility), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [LM Studio](https://lmstudio.ai/docs/developer/openai-compat), [vLLM](https://docs.vllm.ai/en/latest/serving/openai_compatible_server/).

## Permission and update endpoints

Every route needs the install's authenticated session. Actions that change state also need the client header and a same-origin check.

- `GET /api/claude-permissions`: the workspace default, each bot's own setting, the effective setting, and the reason for a block, if any.
- `PATCH /api/claude-permissions`: a mode (`manual`, `automatic`, `free`, or `inherit` for a bot), an optional `botId`, and `confirmDangerous:true` for a dangerous choice. The change is refused during active work.
- `GET /api/software-update`: the installed version, the last check, whether this install can update, the update's progress and the supervisor's last result.
- `POST /api/software-update/check`: an empty JSON body. Only the latest release of the fixed repository is checked.
- `POST /api/software-update/apply`: the checked `version` and `confirm:true`. Returns 202 after supervised preparation, or 409 during active work, a second update, or an unmet administrator requirement. No address or command is accepted from the caller.

The supported layout, confirmation, recovery and security limits are in [UPDATES.md](UPDATES.md).
