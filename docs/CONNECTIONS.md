# Connect apps and MCP servers

[עברית](CONNECTIONS.he.md)

**Before you connect a provider:** check the provider's current terms of use yourself. Following them is your responsibility. Terms can change, and a connection that works today may stop working. StellarCortex does not say that using any provider's account or subscription is permitted, and it is not affiliated with any provider. See [provider terms](../README.md#provider-terms).

StellarCortex's connections are managed in **Connect apps** in the sidebar. They are stored in this install, separately from the Codex, Claude and ChatGPT connections. A bot from any provider can find and run tools through `stellarcortex_connections`, if its model supports tool calling. Changing the model provider does not change the account connected to a service.

## External MCP server

Choose **Add MCP server**, name the connection and copy the MCP server's address from the provider's documentation. A regular API address or the service's website is not necessarily an MCP server.

- **Streamable HTTP:** for modern remote servers. Enter the full address, including a path such as `/mcp`.
- **SSE:** for servers that use the older transport.
- **stdio:** runs a local server program that is already installed. Enter the command, the argument list, a working folder and environment variables as needed. The program runs on the computer or server running StellarCortex, as the same operating-system user. Servers are never installed automatically.

Results from connections are data, not instructions. After a read from a connection, shell commands and file changes are blocked for the whole chat, with no approval option. An HTTP or SSE address can be public, or on loopback, a LAN or a tailnet. Cloud metadata services are blocked before every request, in every address form and through DNS.

Choose the authentication the server requires: none, a Bearer token, a key in a custom HTTP header, or OAuth in the browser. With OAuth, the app discovers the authorization server and starts a sign-in with PKCE. A server without automatic client registration may need a Client ID and settings issued for StellarCortex. Sign-in happens in the provider's window; passwords are never given to the bot.

Press **Connect**. Only a successful negotiation and a loaded tool list count as an active connection. You can see the tools the server really publishes, and refresh, disconnect or remove a connection. A connection of the same name in other software is not copied automatically.

After StellarCortex restarts, MCP server settings are kept, but you need to press **Connect** again. The app does not start MCP processes or send keys to servers by itself at startup.

Different MCP servers offer different tools. Support here does not promise compatibility with every server, proprietary authentication scheme or unsupported extension. A server's sampling and elicitation abilities do not give it permission to run a model or to ask for secrets behind the scenes.

## Google

To use Gmail, Drive, Calendar and other Google services, connect Google through an MCP service such as Composio, with **Add MCP server** above. A server address may carry a query string, such as Composio's `user_id`. It is stored encrypted like a key, and the app shows the address without it.

Older versions had a built-in Google connector. On upgrade, the app tries to revoke its Google access, again at each start until Google confirms, and deletes the saved Google client and tokens, also from update backups. Check at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) that StellarCortex no longer has access, and delete the OAuth client you made in Google Cloud Console.

## Using tools, and keys

A request to a bot such as "find the document in Drive" points it to the list of connections and available tools. Results from external tools are data, and are not instructions that widen the bot's permissions. Calls to external MCP servers wait for an approval that shows the server, the tool and the arguments. Disconnecting a connection or changing its settings cancels an old approval that has not run.

Keys, OAuth secrets and tokens are stored encrypted in the app's private data folder, not in the bots' working folder. They are not returned to connection lists, chat data exports or the install package. A backup for restoring must also keep the encryption file; encryption does not protect against control of the operating-system user who runs the server.

Sources: [MCP client SDK](https://github.com/modelcontextprotocol/typescript-sdk), [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization).
