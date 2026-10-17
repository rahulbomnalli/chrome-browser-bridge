const path = require('node:path');
function clientConfig(client) {
  const entry = path.resolve(__dirname, '..', 'mcp-server.js');
  const server = { command: process.execPath, args: [entry], env: { BRIDGE_TOOL_PROFILE: client === 'antigravity' ? 'fast' : 'compact' } };
  if (client === 'codex') {
    return `[mcp_servers.chrome-browser-bridge]\ncommand = ${JSON.stringify(server.command)}\nargs = [${JSON.stringify(entry)}]\ntool_timeout_sec = 180\n\n[mcp_servers.chrome-browser-bridge.env]\nBRIDGE_TOOL_PROFILE = "compact"`;
  }
  if (['claude', 'antigravity'].includes(client)) return JSON.stringify({ mcpServers: { 'chrome-browser-bridge': server } }, null, 2);
  throw new Error('Usage: bridge config <codex|claude|antigravity>');
}
module.exports = { clientConfig };
