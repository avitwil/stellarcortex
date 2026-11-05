# Model, speed and effort for each bot

[עברית](MODELS.he.md)

The **provider** picker includes Codex and Claude through a subscription, the OpenAI API, the Claude API, a local model, and any personal API connection you added in Settings. Each personal provider has its own name and a model list from its server; adding one needs no model name. Claude Code shows exact versions apart from moving aliases, and its models and effort levels are read from the official CLI. Changing provider resets the model, effort and speed choices, and keeps the visible chat. [Claude details and usage meters](CLAUDE.md) · [API connections and local engines](API-LOCAL.md).

Next to the message box each bot has a picker: the effort level above the slider, a selectable model name, a lightning button for speed, and a reset button for the defaults. The same options appear when creating and editing a bot:

- **Model:** a choice from the list the connected Codex account returns. The default uses StellarCortex's general model; if none is set, Codex's default model.
- **Reasoning effort:** the list follows the chosen model, in the order Codex publishes. The default is that model's effort level.
- **Speed:** standard, or further tiers the model publishes for the account, such as Fast. The default is the model's speed. Fast mode and high effort may use more of the subscription quota, and real speed also depends on the task and the service.

Settings are kept separately for each bot and apply to the next task that starts. An active task continues with the settings it began with. The same choice applies in group chats, in routines, when passing a task to a bot, and when the coordinating bot collects the result. A bot that receives work uses its own settings.

You can return any field to its default. Changing a model or resetting settings does not delete the chat. A run also sends explicit choices when continuing an existing chat, so that an earlier speed or effort level does not linger by mistake.

Availability depends on the account, the model and the Codex version; no model list is fixed in the code. A saved choice that is no longer available is shown as such, and is not silently replaced with another model. A template export includes model choices, and importing checks them against the receiving account.

This keeps using the connected ChatGPT/Codex subscription; nothing switches to API billing by itself.

Sources: [model discovery and per-run settings](https://learn.chatgpt.com/docs/app-server), [speed in Codex](https://learn.chatgpt.com/docs/agent-configuration/speed). It was also checked against the protocol schema of the installed Codex package. Test results are in [VALIDATION.md](VALIDATION.md).
