// Shared by the CLI and MCP adapter. Never retry mutations automatically.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { getAuthToken } = require('./token');

function findServerScript() {
  const candidates = [
    process.env.BRIDGE_SERVER_PATH,
    path.resolve(__dirname, '..', 'server.js'),
    path.resolve(__dirname, 'server.js'),
    'C:\\Users\\91973\\Desktop\\chrome-browser-bridge\\server.js'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

let autoStartingServer = null;
async function ensureBridgeServer(baseUrl) {
  if (autoStartingServer) return autoStartingServer;
  autoStartingServer = (async () => {
    const script = findServerScript();
    if (!script) return false;
    try {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env }
      });
      child.unref();

      const base = new URL(baseUrl);
      const client = base.protocol === 'https:' ? https : http;
      const started = Date.now();
      while (Date.now() - started < 3500) {
        await new Promise(r => setTimeout(r, 60));
        const ok = await new Promise(res => {
          const check = client.request(new URL('/status', base), { method: 'GET', timeout: 300 }, r => {
            res(r.statusCode === 200);
          });
          check.on('error', () => res(false));
          check.on('timeout', () => { check.destroy(); res(false); });
          check.end();
        });
        if (ok) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      autoStartingServer = null;
    }
  })();
  return autoStartingServer;
}

function actionTimeout(params = {}, action) {
  const defaultBudget = ['wait_for_user', 'checkpoint'].includes(action) ? 120000
      : action === 'watch' ? 20000 : 30000;
  const configuredDefault = process.env.BRIDGE_DEFAULT_TIMEOUT_MS;
  const fallback = configuredDefault === undefined ? defaultBudget : Number(configuredDefault);
  const budget = params.timeoutSec !== undefined ? Number(params.timeoutSec) * 1000
    : params.timeoutMs !== undefined ? Number(params.timeoutMs) : fallback;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) {
    throw new Error('Timeout must be between 1 and 600000 milliseconds');
  }
  return budget;
}

function createTransport(baseUrl = process.env.BRIDGE_URL || 'http://127.0.0.1:8765') {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('BRIDGE_URL must use HTTP or HTTPS');
  if (base.hostname === 'localhost') base.hostname = '127.0.0.1';
  const client = base.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, keepAliveMsecs: 60000 });
  function request(route, payload, timeoutMs = 35000, hasRetried = false) {
    return new Promise((resolve, reject) => {
      const data = payload === undefined ? null : JSON.stringify(payload);
      const token = getAuthToken();
      const headers = {
        'Host': base.host,
        'Authorization': `Bearer ${token}`
      };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = client.request(new URL(route, base), {
        method: data ? 'POST' : 'GET', agent,
        headers
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
      if (req.socket) req.socket.setNoDelay(true);
      else req.on('socket', socket => socket.setNoDelay(true));
      req.on('error', async (err) => {
        clearTimeout(deadline);
        if (!hasRetried && ['ECONNREFUSED', 'ECONNRESET'].includes(err.code) && ['127.0.0.1', 'localhost'].includes(base.hostname)) {
          const recovered = await ensureBridgeServer(baseUrl);
          if (recovered) {
            try {
              const res = await request(route, payload, timeoutMs, true);
              resolve(res);
              return;
            } catch (retryErr) {
              reject(retryErr);
              return;
            }
          }
        }
        reject(err);
      });
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
