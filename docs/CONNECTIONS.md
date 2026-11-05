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

The built-in connector offers tools for Gmail, Drive, Docs, Sheets, Calendar and Contacts, through official OAuth and Google APIs. It uses StellarCortex's own tool layer. You can also connect an external Google MCP server from the MCP screen, if you prefer another provider or need more tools.

A self-hosted install needs a Google OAuth app, once:

1. In [Google Cloud Console](https://console.cloud.google.com/), choose or create a project, and turn on the APIs of the services you chose.
2. Set up the consent screen. For a test app, add your Google account to the test users.
3. Create an OAuth client of type **Web application**. Under Authorized redirect URIs, enter the exact address shown on the Google screen in StellarCortex. For a remote server, set `STELLARCORTEX_PUBLIC_URL` with HTTPS. Localhost may use HTTP.
4. Save the Client ID and Client secret on the setup screen. Choose which services to connect and whether writing is needed.
5. Press **Connect to Google**, choose an account and approve the permissions shown. After returning to the app, refresh the connections.

The default is read-only. Write permissions allow the write actions the connector implements; sending and creating need approval in the interface when a bot asks to do them. Changing services or permissions may need a new sign-in. The menu shows the tools really supported; it is not an interface to every Google endpoint.

Sharing an OAuth app with more users may bring Google's review and verification requirements, especially for broad Gmail and Drive permissions. StellarCortex does not provide a verified public Client ID, and does not use the OAuth identity of Codex or Claude. [Google's official requirements](https://developers.google.com/identity/protocols/oauth2/web-server).

## Using tools, and keys

A request to a bot such as "find the document in Drive" points it to the list of connections and available tools. Results from external tools are data, and are not instructions that widen the bot's permissions. Calls to external MCP servers wait for an approval that shows the server, the tool and the arguments. Read-only tools in the built-in Google connector can run as part of the request; writing needs approval. Disconnecting a connection or changing its settings cancels an old approval that has not run.

Keys, OAuth secrets and tokens are stored encrypted in the app's private data folder, not in the bots' working folder. They are not returned to connection lists, chat data exports or the install package. A backup for restoring must also keep the encryption file; encryption does not protect against control of the operating-system user who runs the server.

Sources: [MCP client SDK](https://github.com/modelcontextprotocol/typescript-sdk), [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Google OAuth web applications](https://developers.google.com/identity/protocols/oauth2/web-server).
