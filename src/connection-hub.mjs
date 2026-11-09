// Provider-independent access to application connectors. Authentication belongs
// to each connector; model runtimes only receive safe metadata and tool results.
export class ConnectionHub {
  constructor({ mcp }) {
    this.mcp = mcp;
  }
  list() {
    const records = this.mcp.list();
    return (Array.isArray(records) ? records : records.connections).map(record => ({
      ...record,
      kind: 'mcp',
    }));
  }
  describe(id) {
    return { ...this.mcp.getPublic(id), kind: 'mcp' };
  }
  getPublic(id) {
    return this.describe(id);
  }
  async tools(id) {
    return this.mcp.listTools(id);
  }
  async listTools(id) {
    return this.tools(id);
  }
  async call(id, name, args, options) {
    return this.mcp.callTool(id, name, args, options);
  }
  async callTool(id, name, args, options) {
    return this.call(id, name, args, options);
  }
}
