// Chrome Browser Bridge Server
// Bridges Antigravity AI Agent with Google Chrome
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const { actionTimeout } = require('./lib/transport');
const PORT = process.env.PORT || 8765;
let extensionSocket = null;
let pendingRequests = new Map();
let requestIdCounter = 1;

const latencySamples = [];
let completedActions = 0;
function allowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'chrome-extension:' || (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === String(PORT));
  } catch { return false; }
}

// HTTP Server — fast-path routing avoids URL parsing for common routes
const server = http.createServer(async (req, res) => {
  // CORS & connection headers
  if (!allowedOrigin(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Origin not allowed' }));
    return;
  }
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Connection", "keep-alive");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url;

  // Fast-path: /action POST (most frequent)
  if (path === "/action" && req.method === "POST") {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        if (!res.writableEnded) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Request body too large' }));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
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
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Fast-path: /status or /health GET
  if ((path === "/health" || path === "/status") && req.method === "GET") {
    const isConnected = !!(extensionSocket && extensionSocket.readyState === 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      connected: isConnected,
      port: PORT,
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
  if (path === "/tabs" && req.method === "GET") {
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

  // Serve Web GUI Dashboard
  if (path === "/" || path === "/dashboard") {
    const fs = require("fs");
    const pathMod = require("path");
    const indexPath = pathMod.join(__dirname, "public", "index.html");
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
const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, verifyClient: info => allowedOrigin(info.origin) });

server.on("connection", (socket) => {
  socket.setNoDelay(true);
});

wss.on("connection", (ws, req) => {
  if (req.socket) req.socket.setNoDelay(true);
  console.log(`[Bridge Server] Chrome client connected from ${req.socket.remoteAddress}`);
  extensionSocket = ws;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello") {
        console.log(`[Bridge Server] Extension handshake: ${msg.client} v${msg.version}`);
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.id && pendingRequests.get(msg.id)?.socket === ws) {
        const { resolve, reject, timer, started } = pendingRequests.get(msg.id);
        clearTimeout(timer);
        pendingRequests.delete(msg.id);
        completedActions++;
        latencySamples.push(Math.round((performance.now() - started) * 100) / 100);
        if (latencySamples.length > 512) latencySamples.shift();

        if (msg.durationMs !== undefined) {
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
    // Reject any pending requests
    for (const [id, req] of pendingRequests.entries()) {
      if (req.socket !== ws) continue;
      clearTimeout(req.timer);
      req.reject(new Error("Chrome client disconnected while awaiting response"));
      pendingRequests.delete(id);
    }

  });

  ws.on("error", (err) => {
    console.error("[Bridge Server] WebSocket client error:", err);
  });
});

async function executeAction(action, params = {}, timeoutMs) {
  const dynamicTimeout = timeoutMs || actionTimeout(params, action) + 5000;
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    throw new Error(
      "Chrome browser is not connected to Bridge. " +
      "Make sure Chrome has the 'Chrome Browser Bridge' extension loaded from: " +
      path.join(__dirname, "extension") +
      " and Developer Mode is enabled at chrome://extensions."
    );
  }

  // Monotonic counter — no string concat, no Date.now() overhead
  const id = requestIdCounter++;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout (${dynamicTimeout}ms) waiting for Chrome to execute '${action}'`));
    }, dynamicTimeout);

    pendingRequests.set(id, { resolve, reject, timer, socket: extensionSocket, started: performance.now() });

    extensionSocket.send(JSON.stringify({ id, action, params }), (err) => {
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
  console.log(`🚀 Chrome Browser Bridge Server Running`);
  console.log(`----------------------------------------------------`);
  console.log(`HTTP API:      http://127.0.0.1:${PORT}`);
  console.log(`WebSocket:     ws://127.0.0.1:${PORT}`);
  console.log(`Extension Dir: ${path.join(__dirname, "extension")}`);
  console.log(`====================================================`);
});
