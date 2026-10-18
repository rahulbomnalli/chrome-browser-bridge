// Chrome Browser Bridge Server
// Bridges Antigravity AI Agent with Google Chrome
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const { actionTimeout } = require('./lib/transport');
const { getAuthToken, verifyToken } = require('./lib/token');
const { BridgeError, ErrorCode } = require('./lib/errors');

const PORT = process.env.PORT || 8765;
let extensionSocket = null;
let sessionGeneration = 0;
let pendingRequests = new Map();
let requestIdCounter = 1;

const latencySamples = [];
const recentActions = []; // Names and timings only; never inputs, URLs, page content, or credentials.
let completedActions = 0;

// Write token for the local unpacked extension
const activeToken = getAuthToken();
try {
  const extTokenPath = path.join(__dirname, 'extension', 'bridge-token.js');
  fs.writeFileSync(extTokenPath, `self.__BRIDGE_TOKEN = ${JSON.stringify(activeToken)};\n`, 'utf8');
} catch (_) {}

function allowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'chrome-extension:' || (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === String(PORT));
  } catch { return false; }
}

function isAuthorized(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return verifyToken(auth.slice(7));
  }
  return false;
}

// HTTP Server — fast-path routing with strict security checks
const server = http.createServer(async (req, res) => {
  // 1. Host header verification
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: invalid Host header' }));
    return;
  }

  // 2. Request timeout (30 seconds)
  req.setTimeout(30000, () => {
    if (!res.writableEnded) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Request timeout' }));
    }
    req.destroy();
  });

  // 3. CORS & Origin validation
  if (req.headers.origin) {
    if (!allowedOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Origin not allowed' }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Connection", "keep-alive");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathName = req.url;

  if (pathName === '/metrics' && req.method === 'GET') {
    const successful = recentActions.filter(action => action.ok).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      scope: 'Last 128 completed bridge actions; excludes model/client time',
      totals: { completed: completedActions, sampled: recentActions.length, successful,
        failed: recentActions.length - successful, sampledSuccessRate: recentActions.length ? successful / recentActions.length : null },
      actions: recentActions
    }));
    return;
  }

  // Fast-path: /action POST (mutation capable endpoint requires Bearer token)
  if (pathName === "/action" && req.method === "POST") {
    // Media type check
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unsupported media type: expected application/json' }));
      return;
    }

    // Bearer token authentication
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid bearer token' }));
      return;
    }

    // Early size check
    const declaredSize = parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(declaredSize) && declaredSize > 2 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Request body too large' }));
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        if (!res.writableEnded) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Request body too large' }));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try {
        const rawBody = chunks.length === 1 ? chunks[0].toString() : (chunks.length ? Buffer.concat(chunks).toString() : "{}");
        const payload = JSON.parse(rawBody || "{}");
        const action = payload.action;
        const params = payload.params || {};

        if (typeof action !== 'string' || !action || !params || typeof params !== 'object' || Array.isArray(params)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"success":false,"error":"Missing action parameter"}');
          return;
        }

        const result = await executeAction(action, params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message, code: err.code }));
      }
    });
    return;
  }

  // Fast-path: /status or /health GET
  if ((pathName === "/health" || pathName === "/status") && req.method === "GET") {
    const isConnected = !!(extensionSocket && extensionSocket.readyState === 1 && extensionSocket.authenticated);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      connected: isConnected,
      port: PORT,
      sessionGeneration,
      client: isConnected ? "chrome-extension" : "none",
      pending: pendingRequests.size, completedActions,
      latencyMs: (() => {
        const sorted = [...latencySamples].sort((a, b) => a - b);
        const at = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
        return { samples: sorted.length, p50: at(0.5), p95: at(0.95) };
      })()
    }));
    return;
  }

  // /tabs GET
  if (pathName === "/tabs" && req.method === "GET") {
    try {
      const tabs = await executeAction("tabs", {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, tabs }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // /memory GET (Recall all or by key)
  if (pathName?.startsWith("/memory") && req.method === "GET") {
    try {
      const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const key = urlObj.searchParams.get("key");
      const memRes = await executeAction("get_memory", key ? { key } : {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, memory: memRes }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Serve Web GUI Dashboard
  if (pathName === "/" || pathName === "/dashboard") {
    const indexPath = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(indexPath));
      return;
    }
  }

  // Fallback 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end('{"error":"Endpoint not found"}');
});

// WebSocket Server attached to same HTTP Server
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024,
  verifyClient: (info) => {
    const origin = info.origin || info.req.headers.origin;
    // Check if token is provided in query params or headers
    try {
      const urlObj = new URL(info.req.url, 'http://127.0.0.1');
      const queryToken = urlObj.searchParams.get('token');
      const authHeader = info.req.headers.authorization?.startsWith('Bearer ') ? info.req.headers.authorization.slice(7) : null;
      if ((queryToken && verifyToken(queryToken)) || (authHeader && verifyToken(authHeader))) {
        return true;
      }
    } catch (_) {}

    if (!origin) return false; // Do not accept unauthenticated client with omitted Origin
    try {
      const url = new URL(origin);
      return url.protocol === 'chrome-extension:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    } catch { return false; }
  }
});

server.on("connection", (socket) => {
  socket.setNoDelay(true);
});

wss.on("connection", (ws, req) => {
  if (req.socket) req.socket.setNoDelay(true);

  ws.authenticated = false;
  ws.sessionGeneration = null;

  // Check if token was provided during handshake (e.g. query param or header)
  let preAuthenticated = false;
  try {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const queryToken = urlObj.searchParams.get('token');
    const authHeader = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if ((queryToken && verifyToken(queryToken)) || (authHeader && verifyToken(authHeader))) {
      preAuthenticated = true;
    }
  } catch (_) {}

  if (preAuthenticated) {
    ws.authenticated = true;
    sessionGeneration++;
    ws.sessionGeneration = sessionGeneration;
    extensionSocket = ws;
    console.log(`[Bridge Server] Chrome client authenticated via handshake credentials (session #${sessionGeneration})`);
    ws.send(JSON.stringify({ type: "auth_ok", sessionGeneration }));
  } else {
    // Challenge/response handshake binding installed extension identity and secret
    const nonce = crypto.randomBytes(16).toString('hex');
    ws.challengeNonce = nonce;
    ws.send(JSON.stringify({ type: "challenge", nonce }));
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // If socket is not yet authenticated, require auth or hello with valid token
      if (!ws.authenticated) {
        if (msg.type === "auth" || msg.type === "hello") {
          if (verifyToken(msg.token)) {
            ws.authenticated = true;
            sessionGeneration++;
            ws.sessionGeneration = sessionGeneration;
            extensionSocket = ws;
            console.log(`[Bridge Server] Chrome extension authenticated (session #${sessionGeneration}): ${msg.extensionId || msg.client || 'ok'}`);
            ws.send(JSON.stringify({ type: "auth_ok", sessionGeneration }));
            return;
          } else {
            console.error("[Bridge Server] Extension authentication failed: invalid token");
            ws.send(JSON.stringify({ type: "auth_error", error: "Unauthorized: invalid secret token" }));
            ws.close(4401, "Unauthorized");
            return;
          }
        }
        ws.send(JSON.stringify({ type: "auth_error", error: "Unauthorized: handshake required" }));
        ws.close(4401, "Unauthorized");
        return;
      }

      if (msg.type === "hello") {
        console.log(`[Bridge Server] Extension hello: ${msg.client} v${msg.version}`);
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.id && pendingRequests.get(msg.id)?.socket === ws) {
        const { resolve, reject, timer, started, action, requestBytes, startedAt } = pendingRequests.get(msg.id);
        clearTimeout(timer);
        pendingRequests.delete(msg.id);
        completedActions++;
        latencySamples.push(Math.round((performance.now() - started) * 100) / 100);
        if (latencySamples.length > 512) latencySamples.shift();
        recentActions.push({ action, startedAt, roundTripMs: Math.round((performance.now() - started) * 100) / 100,
          browserMs: msg.durationMs ?? null, requestBytes, responseBytes: raw.length, ok: !!msg.success && msg.result?.ok !== false && msg.result?.success !== false });
        if (recentActions.length > 128) recentActions.shift();

        if (process.env.BRIDGE_TRACE === '1' && msg.durationMs !== undefined) {
          console.log(`[Bridge Server] Action completed in ${msg.durationMs}ms`);
        }

        if (msg.success) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error || "Action failed in browser"));
        }
      }
    } catch (err) {
      console.error("[Bridge Server] Error parsing client message:", err);
    }
  });

  ws.on("close", () => {
    console.log("[Bridge Server] Chrome client disconnected");
    if (extensionSocket === ws) {
      extensionSocket = null;
    }
    // Reject any pending requests for this socket
    for (const [id, req] of pendingRequests.entries()) {
      if (req.socket !== ws) continue;
      clearTimeout(req.timer);
      const isMutation = ['act', 'execute_plan', 'click', 'type', 'upload', 'download', 'whatsapp_send'].includes(req.action);
      const err = isMutation
        ? new BridgeError(ErrorCode.MUTATION_UNCERTAIN, `Chrome client disconnected during mutation '${req.action}'; outcome is uncertain. Inspect page state before retrying.`)
        : new BridgeError(ErrorCode.NETWORK_TRANSIENT, "Chrome client disconnected while awaiting response");
      req.reject(err);
      pendingRequests.delete(id);
    }
  });

  ws.on("error", (err) => {
    console.error("[Bridge Server] WebSocket client error:", err);
  });
});

async function executeAction(action, params = {}, timeoutMs) {
  const dynamicTimeout = timeoutMs || actionTimeout(params, action) + 5000;
  if (!extensionSocket || extensionSocket.readyState !== 1 || !extensionSocket.authenticated) {
    throw new Error(
      "Chrome browser is not connected to Bridge. " +
      "Make sure Chrome has the 'Chrome Browser Bridge' extension loaded from: " +
      path.join(__dirname, "extension") +
      " and Developer Mode is enabled at chrome://extensions."
    );
  }

  // Monotonic counter — no string concat, no Date.now() overhead
  const id = requestIdCounter++;
  const activeSocket = extensionSocket;
  const activeGeneration = extensionSocket.sessionGeneration;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout (${dynamicTimeout}ms) waiting for Chrome to execute '${action}'`));
    }, dynamicTimeout);

    const wire = JSON.stringify({ id, action, params });
    pendingRequests.set(id, {
      resolve,
      reject,
      timer,
      socket: activeSocket,
      generation: activeGeneration,
      started: performance.now(),
      action,
      startedAt: Date.now(),
      requestBytes: Buffer.byteLength(wire)
    });

    activeSocket.send(wire, (err) => {
      if (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error(`Failed to send command to Chrome: ${err.message}`));
      }
    });
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`====================================================`);
  console.log(`🚀 Chrome Browser Bridge Server Running (Authenticated)`);
  console.log(`----------------------------------------------------`);
  console.log(`HTTP API:      http://127.0.0.1:${PORT}`);
  console.log(`WebSocket:     ws://127.0.0.1:${PORT}`);
  console.log(`Extension Dir: ${path.join(__dirname, "extension")}`);
  console.log(`Auth Token:    Configured (${activeToken.slice(0, 8)}...[active])`);
  console.log(`====================================================`);
});
