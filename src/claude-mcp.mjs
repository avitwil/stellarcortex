import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PERMISSION_TOOL = 'approve';
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
export function mcpContent(items = []) {
  return items.map(item => {
    if (item.type === 'inputText') return { type: 'text', text: item.text || '' };
    if (item.type === 'inputImage') {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(
        item.imageUrl || '',
      );
      if (match) return { type: 'image', mimeType: match[1], data: match[2] };
    }
    return { type: 'text', text: 'Unsupported tool content was omitted.' };
  });
}

// One loopback MCP endpoint per turn. The bearer secret is unrelated to provider
// authentication; it never leaves the local Claude process or this server.
export async function createClaudeBridge({ tools = [], call, approve }) {
  const token = randomBytes(32).toString('hex'),
    secret = Buffer.from(`Bearer ${token}`);
  const available = new Map(tools.map(t => [t.name, t]));
  let closed = false;
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    if (closed || supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
      return json(res, 401, { error: 'Unauthorized' });
    if (req.url !== '/mcp') return json(res, 404, { error: 'Not found' });
    if (req.headers.origin) return json(res, 403, { error: 'Browser requests are not supported' });
    if (req.method === 'GET') return json(res, 405, { error: 'Streaming GET is not supported' });
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let message;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Request exceeds limit');
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        !message ||
        Array.isArray(message) ||
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string'
      )
        throw new Error('Invalid JSON-RPC request');
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stellarcortex', version: '0.1.1' },
        };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list')
        result = {
          tools: [...available.values()]
            .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
            .concat({
              name: PERMISSION_TOOL,
              description:
                'Ask the StellarCortex user whether a native Claude Code action may proceed. Only Claude Code permission handling should call this tool.',
              inputSchema: {
                type: 'object',
                properties: {
                  tool_name: { type: 'string' },
                  input: { type: 'object' },
                  tool_use_id: { type: 'string' },
                },
                required: ['tool_name', 'input'],
              },
            }),
        };
      else if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params || {};
        if (name === PERMISSION_TOOL) {
          if (
            typeof args.tool_name !== 'string' ||
            !args.input ||
            typeof args.input !== 'object' ||
            Array.isArray(args.input)
          )
            throw new Error('Invalid permission request');
          const decision = await approve(args),
            allowed = decision === true || decision?.allow === true;
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  allowed
                    ? { behavior: 'allow', updatedInput: args.input }
                    : {
                        behavior: 'deny',
                        message:
                          typeof decision?.message === 'string'
                            ? decision.message
                            : 'The user declined this action. Do not retry or bypass it.',
                      },
                ),
              },
            ],
          };
        } else {
          if (!available.has(name)) throw new Error('Unknown StellarCortex tool');
          const response = await call(name, args);
          result = { content: mcpContent(response.contentItems), isError: !response.success };
        }
      } else
        return json(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
      if (!res.destroyed) json(res, 200, { jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (!res.destroyed)
        json(res, 200, {
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: { code: -32603, message: error.message },
        });
    }
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    config: {
      mcpServers: {
        stellarcortex: {
          type: 'http',
          url: `http://127.0.0.1:${server.address().port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    permissionTool: 'mcp__stellarcortex__approve',
    close: async () => {
      closed = true;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
