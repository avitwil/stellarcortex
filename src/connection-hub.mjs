// Provider-independent access to application connectors. Authentication belongs
// to each connector; model runtimes only receive safe metadata and tool results.
export class ConnectionHub {
  constructor({ mcp, google }) {
    this.mcp = mcp;
    this.google = google;
  }
  googleRecord() {
    const status = this.google.status();
    return {
      ...status,
      id: 'google',
      name: 'Google',
      kind: 'google',
      status: status.status || (status.connected ? 'connected' : 'disconnected'),
    };
  }
  list() {
    const records = this.mcp.list();
    return [
      ...(Array.isArray(records) ? records : records.connections).map(record => ({
        ...record,
        kind: 'mcp',
      })),
      ...(this.google.status().configured ? [this.googleRecord()] : []),
    ];
  }
  describe(id) {
    return id === 'google' ? this.googleRecord() : { ...this.mcp.getPublic(id), kind: 'mcp' };
  }
  getPublic(id) {
    return this.describe(id);
  }
  async tools(id) {
    return id === 'google' ? this.google.listTools() : this.mcp.listTools(id);
  }
  async listTools(id) {
    return this.tools(id);
  }
  async requiresApproval(id, toolName) {
    if (id !== 'google') return true;
    const catalog = await this.google.listTools();
    const selected = catalog.tools.find(tool => tool.name === toolName);
    return !selected || selected.annotations?.readOnlyHint !== true;
  }
  async call(id, name, args, options) {
    return id === 'google'
      ? this.google.callTool(name, args, options)
      : this.mcp.callTool(id, name, args, options);
  }
  async callTool(id, name, args, options) {
    return this.call(id, name, args, options);
  }
}
