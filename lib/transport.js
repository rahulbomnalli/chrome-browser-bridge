// Shared by the CLI and MCP adapter. Never retry mutations automatically.
const http = require('node:http');
const https = require('node:https');

function actionTimeout(params = {}, action) {
  const defaultBudget = ['whatsapp_send', 'whatsapp_send_message'].includes(action) ? 150000
    : ['wait_for_user', 'checkpoint'].includes(action) ? 120000
      : action === 'watch' ? 20000 : 30000;
  const budget = params.timeoutSec !== undefined ? Number(params.timeoutSec) * 1000
    : params.timeoutMs !== undefined ? Number(params.timeoutMs) : defaultBudget;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) {
    throw new Error('Timeout must be between 1 and 600000 milliseconds');
  }
  return budget;
}

function createTransport(baseUrl = process.env.BRIDGE_URL || 'http://127.0.0.1:8765') {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('BRIDGE_URL must use HTTP or HTTPS');
  const client = base.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
  function request(route, payload, timeoutMs = 35000) {
    return new Promise((resolve, reject) => {
      const data = payload === undefined ? null : JSON.stringify(payload);
      const req = client.request(new URL(route, base), {
        method: data ? 'POST' : 'GET', agent,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Bridge response interrupted; inspect state before retrying')));
        res.on('end', () => {
          clearTimeout(deadline);
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode < 200 || res.statusCode >= 300 || parsed.success === false) {
              reject(new Error(parsed.error || `Bridge HTTP ${res.statusCode}`));
            } else resolve(parsed);
          } catch { reject(new Error('Invalid JSON response from Chrome Bridge')); }
        });
      });
      // Wall-clock deadline, including connection establishment and stalled responses.
      const deadline = setTimeout(() => req.destroy(new Error('Bridge deadline exceeded; action may still be running. Inspect state before retrying.')), timeoutMs);
      req.on('socket', socket => socket.setNoDelay(true));
      req.on('error', reject);
      req.on('close', () => clearTimeout(deadline));
      req.end(data);
    });
  }
  return {
    async postAction(action, params = {}, timeoutMs) {
      const budget = actionTimeout(params, action);
      return (await request('/action', { action, params }, timeoutMs || budget + 10000)).result;
    },
    getStatus: () => request('/status', undefined, 5000),
    getMetrics: () => request('/metrics', undefined, 5000),
    close: () => agent.destroy()
  };
}
module.exports = { createTransport, actionTimeout };
