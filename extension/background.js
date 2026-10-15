// Antigravity Chrome Agent Bridge - Ultra-Fast v4.0 Engine
const BRIDGE_WS_URL = "ws://127.0.0.1:8765";

let socket = null;
let isConnected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let activeSandboxWindowId = null;
let activeSandboxTabId = null;
let activeAgentWindowId = null;
let activeAgentTabId = null;
let activeDesignatedTabId = null;
const MAX_RECONNECT_DELAY = 3000;

const attachedTabs = new Set();
const networkBuffers = new Map();
const consoleBuffers = new Map();
const elementCache = new Map();
// O(1) index: requestId -> entry for instant network correlation
const networkIndexes = new Map();

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === activeSandboxWindowId) {
    activeSandboxWindowId = null;
    activeSandboxTabId = null;
  }
  if (windowId === activeAgentWindowId) {
    activeAgentWindowId = null;
    activeAgentTabId = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeDesignatedTabId) {
    activeDesignatedTabId = null;
  }
  if (tabId === activeAgentTabId) {
    activeAgentTabId = null;
  }
  if (tabId === activeSandboxTabId) {
    activeSandboxTabId = null;
    activeSandboxWindowId = null;
  }
  attachedTabs.delete(tabId);
  networkBuffers.delete(tabId);
  consoleBuffers.delete(tabId);
  networkIndexes.delete(tabId);
  _enabledDomains.delete(tabId);
});

// Ensure bridge tasks run in a dedicated agent window without disturbing user window
async function getOrCreateAgentWindow(url = "about:blank") {
  if (activeAgentWindowId) {
    try {
      const win = await chrome.windows.get(activeAgentWindowId, { populate: true });
      if (win) {
        return { windowId: win.id, existing: true, tabs: win.tabs || [] };
      }
    } catch {
      activeAgentWindowId = null;
      activeAgentTabId = null;
    }
  }

  // Get user's current window so we never disturb their focus if desired
  let userFocusedWindowId = null;
  try {
    const lastFocused = await chrome.windows.getLastFocused();
    userFocusedWindowId = lastFocused?.id;
  } catch {}

  const newWin = await chrome.windows.create({
    url,
    type: "normal",
    width: 1280,
    height: 900,
    focused: true
  });
  activeAgentWindowId = newWin.id;
  const winTabs = await chrome.tabs.query({ windowId: newWin.id });
  const firstTab = (winTabs && winTabs.length > 0) ? winTabs[0] : null;
  if (firstTab) {
    activeAgentTabId = firstTab.id;
    activeDesignatedTabId = firstTab.id;
  }
  return { windowId: newWin.id, existing: false, tabs: winTabs || [] };
}

// Update designated tab when user or agent switches active tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (activeSandboxTabId) return;

  // If bridge has a designated agent window, only track tabs inside the agent window
  if (activeAgentWindowId) {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.windowId === activeAgentWindowId) {
        activeAgentTabId = tab.id;
        activeDesignatedTabId = tab.id;
      }
      return;
    } catch {}
  }

  activeDesignatedTabId = activeInfo.tabId;
});

async function waitForPageLoad(tabId, maxTimeout = 2000) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.status === "complete") {
      return;
    }
  } catch {}

  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, maxTimeout);

    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === "complete") {
        if (!done) {
          done = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const MAX_BUFFER_SIZE = 200;

// High-perf ring buffer: no .shift() copies, O(1) push/read
class RingBuffer {
  constructor(capacity) {
    this._buf = new Array(capacity);
    this._cap = capacity;
    this._head = 0;
    this._len = 0;
  }
  push(item) {
    const idx = (this._head + this._len) % this._cap;
    if (this._len === this._cap) {
      this._buf[this._head] = item;
      this._head = (this._head + 1) % this._cap;
    } else {
      this._buf[idx] = item;
      this._len++;
    }
  }
  toArray() {
    if (this._len === 0) return [];
    const out = new Array(this._len);
    for (let i = 0; i < this._len; i++) {
      out[i] = this._buf[(this._head + i) % this._cap];
    }
    return out;
  }
  get length() { return this._len; }
  filter(fn) { return this.toArray().filter(fn); }
}

function getNetworkBuffer(tabId) {
  if (!networkBuffers.has(tabId)) networkBuffers.set(tabId, new RingBuffer(MAX_BUFFER_SIZE));
  return networkBuffers.get(tabId);
}

function getConsoleBuffer(tabId) {
  if (!consoleBuffers.has(tabId)) consoleBuffers.set(tabId, new RingBuffer(MAX_BUFFER_SIZE));
  return consoleBuffers.get(tabId);
}

function getNetworkIndex(tabId) {
  if (!networkIndexes.has(tabId)) networkIndexes.set(tabId, new Map());
  return networkIndexes.get(tabId);
}

function pushNetworkEntry(tabId, entry) {
  getNetworkBuffer(tabId).push(entry);
  if (entry.requestId) getNetworkIndex(tabId).set(entry.requestId, entry);
}

function pushConsoleEntry(tabId, entry) {
  const buf = getConsoleBuffer(tabId);
  // Deduplicate consecutive identical messages to reduce memory and token noise
  if (buf._len > 0) {
    const lastIdx = (buf._head + buf._len - 1) % buf._cap;
    const last = buf._buf[lastIdx];
    if (last && last.text === entry.text && last.level === entry.level) {
      last.count = (last.count || 1) + 1;
      last.timestamp = entry.timestamp;
      return;
    }
  }
  buf.push(entry);
}

function updateBadge(connected) {
  isConnected = connected;
  if (connected) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  } else {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  }
}

// 5s Persistent Heartbeat
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping", time: Date.now() }));
    }
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connectToBridge() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(BRIDGE_WS_URL);

    socket.onopen = () => {
      console.log("[Chrome Bridge v3.0] Ultra-Fast Engine Connected.");
      updateBadge(true);
      startHeartbeat();
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket.send(JSON.stringify({
        type: "hello",
        client: "chrome-extension-v3",
        version: "3.0.0",
        features: ["token_compression", "pipeline", "native_cdp", "network", "console", "storage"]
      }));
    };

    socket.onmessage = async (event) => {
      const raw = event.data;
      if (!raw || raw[0] !== '{') return;
      if (raw.charCodeAt(9) === 112) return; // fast check for {"type":"pong"}
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        return;
      }

      if (data.type === "pong") return;

      const { id, action, params = {} } = data;
      if (!action) return;

      const startTime = performance.now();
      try {
        const result = await handleAction(action, params);
        const durationMs = Math.round((performance.now() - startTime) * 10) / 10;
        socket.send(JSON.stringify({ id, success: true, result, durationMs }));
      } catch (err) {
        const durationMs = Math.round((performance.now() - startTime) * 10) / 10;
        socket.send(JSON.stringify({ id, success: false, error: err.message || String(err), durationMs }));
      }
    };

    socket.onclose = () => {
      updateBadge(false);
      stopHeartbeat();
      scheduleReconnect();
    };

    socket.onerror = () => {
      updateBadge(false);
      stopHeartbeat();
      try { socket.close(); } catch (_) {}
    };
  } catch (err) {
    updateBadge(false);
    stopHeartbeat();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(250 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToBridge();
  }, delay);
}

// DevTools CDP Event Listener — hot path, no allocations except entry objects
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  // Fast method dispatch via first char discrimination
  const c0 = method.charCodeAt(0); // P=80, N=78, R=82, C=67

  // Page domain (P)
  if (c0 === 80 && method === "Page.javascriptDialogOpening") {
    chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    return;
  }

  const now = Date.now();

  // Network domain (N)
  if (c0 === 78) {
    if (method === "Network.requestWillBeSent") {
      pushNetworkEntry(tabId, {
        requestId: params.requestId,
        timestamp: now,
        type: "request",
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData || null,
        status: "pending"
      });
    } else if (method === "Network.responseReceived") {
      // O(1) lookup via index instead of O(n) linear scan
      const idx = getNetworkIndex(tabId);
      const item = idx.get(params.requestId);
      if (item && item.status === "pending") {
        item.status = params.response.status;
        item.statusText = params.response.statusText;
        item.mimeType = params.response.mimeType;
        item.responseTime = now;
      } else {
        pushNetworkEntry(tabId, {
          requestId: params.requestId,
          timestamp: now,
          type: "response",
          url: params.response.url,
          status: params.response.status,
          statusText: params.response.statusText,
          mimeType: params.response.mimeType
        });
      }
    } else if (method === "Network.loadingFailed") {
      const idx = getNetworkIndex(tabId);
      const item = idx.get(params.requestId);
      if (item) {
        item.status = "FAILED";
        item.errorText = params.errorText;
        item.canceled = params.canceled;
      }
    }
    return;
  }

  // Runtime domain (R)
  if (c0 === 82) {
    if (method === "Runtime.consoleAPICalled") {
      const args = params.args;
      let text;
      if (args.length === 1) {
        text = args[0].value !== undefined ? String(args[0].value) : (args[0].description || "");
      } else {
        text = args.map(a => a.value !== undefined ? String(a.value) : (a.description || "")).join(" ");
      }
      pushConsoleEntry(tabId, {
        timestamp: now,
        level: params.type,
        text,
        stack: params.stackTrace?.callFrames?.[0] ? `${params.stackTrace.callFrames[0].url}:${params.stackTrace.callFrames[0].lineNumber}` : null
      });
    } else if (method === "Runtime.exceptionThrown") {
      pushConsoleEntry(tabId, {
        timestamp: now,
        level: "error",
        text: params.exceptionDetails.text + (params.exceptionDetails.exception?.description ? ": " + params.exceptionDetails.exception.description : ""),
        url: params.exceptionDetails.url,
        lineNumber: params.exceptionDetails.lineNumber,
        stack: params.exceptionDetails.stackTrace?.callFrames?.map(f => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber}:${f.columnNumber})`).join("\n")
      });
    }
    return;
  }

  // Console domain (C)
  if (c0 === 67 && method === "Console.messageAdded") {
    pushConsoleEntry(tabId, {
      timestamp: now,
      level: params.message.level,
      text: params.message.text,
      source: params.message.source,
      url: params.message.url,
      line: params.message.line
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    _enabledDomains.delete(source.tabId);
  }
});

// Track which CDP domains are enabled per tab to avoid redundant enable calls
const _enabledDomains = new Map();

async function ensureDebuggerAttached(tabId, domains) {
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.add(tabId);
    } catch (err) {
      return false;
    }
  }
  // Enable core domains on first attach, then only requested domains on subsequent calls
  let enabled = _enabledDomains.get(tabId);
  if (!enabled) {
    enabled = new Set();
    _enabledDomains.set(tabId, enabled);
    // Core domains always needed: Network, Runtime, Page, Console
    const core = [
      chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxPostDataSize: 65536 }),
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Page.enable"),
      chrome.debugger.sendCommand({ tabId }, "Console.enable")
    ];
    await Promise.allSettled(core);
    enabled.add("Network"); enabled.add("Runtime"); enabled.add("Page"); enabled.add("Console");
  }
  // Lazy-enable additional domains only when explicitly requested
  if (domains) {
    const pending = [];
    for (const d of domains) {
      if (!enabled.has(d)) {
        pending.push(chrome.debugger.sendCommand({ tabId }, `${d}.enable`).then(() => enabled.add(d)).catch(() => {}));
      }
    }
    if (pending.length) await Promise.allSettled(pending);
  }
  return true;
}

async function getTargetTab(tabId) {
  if (tabId) {
    const specifiedTab = await chrome.tabs.get(Number(tabId));
    if (specifiedTab) {
      activeDesignatedTabId = specifiedTab.id;
      return specifiedTab;
    }
  }

  // 1. Prioritize activeAgentTabId (dedicated bridge window)
  if (activeAgentTabId) {
    try {
      const agentTab = await chrome.tabs.get(activeAgentTabId);
      if (agentTab) return agentTab;
    } catch {
      activeAgentTabId = null;
      activeAgentWindowId = null;
    }
  }

  // 2. Fall back to any active tab in the dedicated bridge window
  if (activeAgentWindowId) {
    try {
      const agentWinTabs = await chrome.tabs.query({ windowId: activeAgentWindowId });
      if (agentWinTabs && agentWinTabs.length > 0) {
        const activeWinTab = agentWinTabs.find(t => t.active) || agentWinTabs[0];
        activeAgentTabId = activeWinTab.id;
        activeDesignatedTabId = activeWinTab.id;
        return activeWinTab;
      }
    } catch {
      activeAgentWindowId = null;
    }
  }

  if (activeSandboxTabId) {
    try {
      const sandboxTab = await chrome.tabs.get(activeSandboxTabId);
      if (sandboxTab) return sandboxTab;
    } catch {
      activeSandboxTabId = null;
      activeSandboxWindowId = null;
    }
  }

  if (activeDesignatedTabId) {
    try {
      const designatedTab = await chrome.tabs.get(activeDesignatedTabId);
      if (designatedTab) return designatedTab;
    } catch {
      activeDesignatedTabId = null;
    }
  }

  const isUnrestricted = (t) => t && t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("edge://") && !t.url.startsWith("about:");

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab && isUnrestricted(activeTab)) {
    activeDesignatedTabId = activeTab.id;
    return activeTab;
  }
  const anyActiveTabs = await chrome.tabs.query({ active: true });
  const validActiveTab = anyActiveTabs.find(isUnrestricted);
  if (validActiveTab) {
    activeDesignatedTabId = validActiveTab.id;
    return validActiveTab;
  }
  const allTabs = await chrome.tabs.query({});
  const validTab = allTabs.find(isUnrestricted);
  if (validTab) {
    activeDesignatedTabId = validTab.id;
    return validTab;
  }
  if (activeTab) return activeTab;
  if (allTabs.length > 0) return allTabs[0];
  throw new Error("No browser tabs available.");
}

// LIVE AUTONOMOUS AGENT HUD - Realtime on-page status, live timer, and breadcrumbs
async function showAgentOverlay(tabId, actionLabel, startTime, isPipeline = false, stepCurrent = 1, stepTotal = 1) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: inPageUpdateAgentHud,
      args: [{
        label: actionLabel,
        isPipeline,
        stepCurrent,
        stepTotal,
        startTime: startTime || Date.now()
      }]
    });
  } catch {}
}

async function completeAgentOverlay(tabId, isSuccess, label, durationMs) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: inPageCompleteAgentHud,
      args: [{
        isSuccess,
        label,
        durationMs
      }]
    });
  } catch {}
}

function inPageUpdateAgentHud(opts) {
  try {
    const { label, isPipeline, stepCurrent, stepTotal, startTime } = opts;
    let hud = document.getElementById('__bridge_live_hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = '__bridge_live_hud';
      hud.style.cssText = `
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%) translateY(-10px);
        z-index: 2147483647;
        background: rgba(11, 15, 25, 0.94);
        border: 1px solid rgba(99, 102, 241, 0.45);
        color: #f1f5f9; padding: 7px 18px; border-radius: 9999px;
        font: 500 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 10px 32px rgba(0,0,0,0.65), 0 0 0 1px rgba(99, 102, 241, 0.25), 0 0 18px rgba(99, 102, 241, 0.25);
        backdrop-filter: blur(16px);
        display: flex; align-items: center; gap: 10px;
        pointer-events: none;
        transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s ease, background 0.2s ease, border-color 0.2s ease;
        opacity: 0;
        white-space: nowrap;
      `;
      document.body.appendChild(hud);

      if (!document.getElementById('__bridge_hud_style')) {
        const style = document.createElement('style');
        style.id = '__bridge_hud_style';
        style.textContent = `
          @keyframes __bridge_pulse {
            0%, 100% { transform: scale(1); opacity: 1; filter: drop-shadow(0 0 6px #818cf8); }
            50% { transform: scale(0.8); opacity: 0.45; filter: drop-shadow(0 0 1px #818cf8); }
          }
          @keyframes __bridge_ripple {
            0% { transform: scale(0.2); opacity: 0.9; }
            100% { transform: scale(2.6); opacity: 0; }
          }
        `;
        document.head.appendChild(style);
      }
    }

    if (window.__bridge_hud_dismiss_timer) {
      clearTimeout(window.__bridge_hud_dismiss_timer);
      window.__bridge_hud_dismiss_timer = null;
    }

    if (!window.__bridge_hud_session_start || (Date.now() - window.__bridge_hud_last_update > 5000)) {
      window.__bridge_hud_session_start = startTime || Date.now();
    }
    window.__bridge_hud_last_update = Date.now();

    const elapsed = ((Date.now() - window.__bridge_hud_session_start) / 1000).toFixed(1);

    const stepBadge = (isPipeline && stepTotal > 1) 
      ? `<span style="background:rgba(99, 102, 241, 0.25); border:1px solid rgba(129, 140, 248, 0.5); color:#c7d2fe; font-size:10.5px; font-weight:700; padding:1px 7px; border-radius:9999px;">Step ${stepCurrent}/${stepTotal}</span>` 
      : '';

    hud.innerHTML = `
      <span style="display:inline-flex; width:8px; height:8px; border-radius:50%; background:#818cf8; box-shadow:0 0 8px #a5b4fc; animation:__bridge_pulse 0.9s infinite;"></span>
      <span style="font-weight:700; color:#e0e7ff; letter-spacing:-0.2px;">Agent</span>
      ${stepBadge}
      <span style="color:#cbd5e1; font-weight:500;">${label}</span>
      <span style="display:inline-block; width:1px; height:12px; background:rgba(255,255,255,0.18);"></span>
      <span id="__bridge_hud_timer" style="font-size:11px; font-variant-numeric:tabular-nums; color:#94a3b8; font-weight:600;">⏱️ ${elapsed}s</span>
      <span style="background:rgba(16, 185, 129, 0.15); color:#6ee7b7; font-size:10.5px; font-weight:600; padding:1px 6px; border-radius:9999px;">⚡ Ultra-Fast</span>
    `;

    hud.style.background = 'rgba(11, 15, 25, 0.94)';
    hud.style.borderColor = 'rgba(99, 102, 241, 0.45)';
    hud.style.opacity = '1';
    hud.style.transform = 'translateX(-50%) translateY(0)';

    if (!window.__bridge_hud_interval) {
      window.__bridge_hud_interval = setInterval(() => {
        const timerEl = document.getElementById('__bridge_hud_timer');
        if (timerEl && window.__bridge_hud_session_start) {
          const s = ((Date.now() - window.__bridge_hud_session_start) / 1000).toFixed(1);
          timerEl.textContent = `⏱️ ${s}s`;
        }
      }, 100);
    }
  } catch {}
}

function inPageCompleteAgentHud(opts) {
  try {
    const { isSuccess, label, durationMs } = opts;
    const hud = document.getElementById('__bridge_live_hud');
    if (!hud) return;

    if (window.__bridge_hud_interval) {
      clearInterval(window.__bridge_hud_interval);
      window.__bridge_hud_interval = null;
    }

    const durSec = durationMs ? (durationMs / 1000).toFixed(1) : ((Date.now() - (window.__bridge_hud_session_start || Date.now())) / 1000).toFixed(1);

    if (isSuccess) {
      hud.style.background = 'rgba(6, 78, 59, 0.94)';
      hud.style.borderColor = 'rgba(16, 185, 129, 0.6)';
      hud.style.boxShadow = '0 8px 30px rgba(0,0,0,0.6), 0 0 16px rgba(16, 185, 129, 0.35)';
      hud.innerHTML = `
        <span style="font-size:12px; color:#34d399; font-weight:700;">✓</span>
        <span style="color:#d1fae5; font-weight:600;">${label || 'Done'}</span>
        <span style="display:inline-block; width:1px; height:12px; background:rgba(255,255,255,0.18);"></span>
        <span style="font-size:11px; color:#a7f3d0; font-weight:600;">⚡ Finished in ${durSec}s</span>
      `;
    } else {
      hud.style.background = 'rgba(127, 29, 29, 0.94)';
      hud.style.borderColor = 'rgba(239, 68, 68, 0.6)';
      hud.innerHTML = `
        <span style="font-size:12px; color:#f87171; font-weight:700;">✕</span>
        <span style="color:#fee2e2; font-weight:600;">${label || 'Error'}</span>
      `;
    }

    // Keep visible for 1.2s so user gets immediate confirmation without lingering
    window.__bridge_hud_dismiss_timer = setTimeout(() => {
      hud.style.opacity = '0';
      hud.style.transform = 'translateX(-50%) translateY(-8px)';
      setTimeout(() => {
        try { hud.remove(); } catch {}
        window.__bridge_hud_session_start = null;
      }, 200);
    }, 1200);
  } catch {}
}

function buildActionCompletionSummary(action, params, result) {
  if (!result) return 'Action Completed';
  switch (action) {
    case 'whatsapp_send':
    case 'whatsapp_send_message': {
      return result.dryRun ? `Prepared WhatsApp to ${result.contact || params.contact} (dry run)` : `Sent WhatsApp to ${result.contact || params.contact}`;
    }
    case 'smart_navigate':
    case 'navigate': {
      let title = result.title;
      if (!title && params.url) {
        try { title = new URL(params.url).hostname.replace('www.', ''); } catch { title = params.url; }
      }
      return result.reused ? `Reused tab: "${(title || '').slice(0, 28)}"` : `Navigated to "${(title || '').slice(0, 28)}"`;
    }
    case 'extract_data': {
      return `Extracted ${result.count || 0} items for "${(params.selector || '').slice(0, 20)}"`;
    }
    case 'click': {
      const clicked = result.clicked || params.target || params.text || (result.selector ? result.selector : 'element');
      return `Clicked "${String(clicked).slice(0, 28)}"`;
    }
    case 'type': {
      const field = result.selector ? ` into ${result.selector}` : '';
      return `Typed "${String(params.text).slice(0, 20)}"${field}`;
    }
    case 'batch_fill': {
      const count = result.filled?.length || Object.keys(params.fields || {}).length;
      const names = Object.keys(params.fields || {}).slice(0, 3).join(', ');
      return `Filled ${count} fields (${names})`;
    }
    case 'batch_form': {
      return `Filled form (${result.filledCount || Object.keys(params.fields || {}).length} inputs)`;
    }
    case 'pipeline': {
      const count = result.count || (params.steps || []).length;
      const stepNames = (params.steps || []).map(s => {
        if (s.action === 'click') return `Click ${s.params?.target || s.params?.text || ''}`.trim();
        if (s.action === 'type') return `Type "${(s.params?.text || '').slice(0, 10)}"`;
        return s.action;
      }).slice(0, 3).join(' ➔ ');
      return `Executed ${count} steps: ${stepNames}`;
    }
    case 'snap': {
      return `Indexed ${result.count || 0} page elements`;
    }
    case 'visual_grounding': {
      return `Grounded ${result.count || 0} elements with visual tags`;
    }
    case 'read_page': {
      return `Extracted text: "${(result.title || '').slice(0, 25)}"`;
    }
    case 'screenshot': {
      return 'Captured high-res screenshot';
    }
    case 'wait_for_user': {
      return `User unlocked / authorized (${result.clearedBy || 'confirmed'})`;
    }
    case 'parallel_scrape': {
      return `Scraped ${result.total || (params.urls || []).length} tabs simultaneously`;
    }
    case 'run_macro': {
      return `Executed macro "${result.macro || params.name}"`;
    }
    default:
      return `${action} completed`;
  }
}

// Highlight clicked/typed element briefly for 1 second with luminous glow
async function highlightElement(tabId, selector) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = sel ? document.querySelector(sel) : null;
        if (!el) return;
        const prevOutline = el.style.outline;
        const prevShadow = el.style.boxShadow;
        const prevOffset = el.style.outlineOffset;
        const prevTransition = el.style.transition;

        el.style.transition = 'all 0.15s ease-out';
        el.style.outline = '2px solid #818cf8';
        el.style.outlineOffset = '2px';
        el.style.boxShadow = '0 0 0 4px rgba(129, 140, 248, 0.25), 0 0 14px rgba(129, 140, 248, 0.5)';

        setTimeout(() => {
          el.style.outline = prevOutline;
          el.style.outlineOffset = prevOffset;
          el.style.boxShadow = prevShadow;
          el.style.transition = prevTransition;
        }, 1000);
      },
      args: [selector]
    });
  } catch {}
}

async function handleAction(action, params) {
  const startTime = Date.now();
  const overlayActions = {
    whatsapp_send: params.contact ? `WhatsApp: ${params.contact}` : 'Sending WhatsApp message',
    whatsapp_send_message: params.contact ? `WhatsApp: ${params.contact}` : 'Sending WhatsApp message',
    smart_navigate: params.url ? `Navigating to ${params.url.slice(0, 32)}` : 'Smart Navigating',
    extract_data: params.selector ? `Extracting ${params.selector}` : 'Extracting data',
    snap: 'Scanning page elements',
    click: params.target || params.text ? `Clicking ${params.target || params.text}` : 'Clicking element',
    type: params.text ? `Typing "${String(params.text).slice(0, 18)}..."` : 'Typing text',
    navigate: params.url ? `Navigating to ${params.url.slice(0, 32)}` : 'Navigating',
    screenshot: 'Capturing snapshot',
    batch_fill: 'Smart form fill',
    batch_form: 'Filling form',
    pipeline: `Executing pipeline (${(params.steps || []).length} steps)`,
    reload: 'Reloading page',
    eval: 'Running script',
    read_page: 'Reading page content',
    highlight_elements: 'Highlighting interactive elements',
    wait_for_user: 'Waiting for user authorization / unlock'
  };

  let overlayTabId = null;
  if (overlayActions[action]) {
    try {
      const tab = await getTargetTab(params.tabId);
      overlayTabId = tab.id;
      showAgentOverlay(overlayTabId, overlayActions[action] + '...', startTime);
    } catch {}
  }

  try {
    const result = await handleActionInner(action, params);
    const durationMs = Date.now() - startTime;
    // For navigation / new tab actions, update overlay tab to the target result tab
    if (result && result.id && (action === 'navigate' || action === 'smart_navigate' || action === 'new_tab')) {
      overlayTabId = result.id;
    }
    if (overlayTabId) {
      const summary = buildActionCompletionSummary(action, params, result);
      completeAgentOverlay(overlayTabId, true, summary, durationMs);
    }
    return result;
  } catch (err) {
    if (overlayTabId) {
      completeAgentOverlay(overlayTabId, false, err.message || 'Error');
    }
    throw err;
  }
}

async function handleActionInner(action, params) {
  switch (action) {
    case "ping":
      return { pong: true, time: Date.now(), attachedTabs: Array.from(attachedTabs) };

    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({
        id: t.id,
        index: t.index,
        windowId: t.windowId,
        title: t.title,
        url: t.url,
        active: t.active,
        status: t.status
      }));
    }

    case "active_tab": {
      const tab = await getTargetTab(params.tabId);
      return { id: tab.id, title: tab.title, url: tab.url, active: tab.active, status: tab.status };
    }

    case "switch_tab": {
      const tabId = Number(params.tabId);
      if (!tabId) throw new Error("Missing tabId");
      activeDesignatedTabId = tabId;
      const updatedTab = await chrome.tabs.update(tabId, { active: true });
      if (updatedTab.windowId) await chrome.windows.update(updatedTab.windowId, { focused: true });
      return { id: updatedTab.id, title: updatedTab.title, url: updatedTab.url };
    }

    case "new_tab": {
      const agentWin = await getOrCreateAgentWindow(params.url || "about:blank");
      let newTab;
      if (agentWin.existing) {
        newTab = await chrome.tabs.create({
          windowId: agentWin.windowId,
          url: params.url || "about:blank",
          active: params.active !== false
        });
      } else {
        newTab = agentWin.tabs[0];
      }
      activeAgentTabId = newTab.id;
      activeDesignatedTabId = newTab.id;
      if (params.url && params.url !== "about:blank" && params.waitForLoad !== false) {
        await waitForPageLoad(newTab.id, params.timeoutMs || 2500);
      }
      const loaded = await chrome.tabs.get(newTab.id);
      let snap = null;
      if (params.returnSnap !== false && params.url && params.url !== "about:blank") {
        try {
          const snapRes = await handleActionInner("snap", { tabId: loaded.id });
          snap = snapRes.compact;
        } catch {}
      }
      return { id: loaded.id, title: loaded.title, url: loaded.url, isNewTab: true, snapshot: snap };
    }

    case "new_window": {
      const newWin = await chrome.windows.create({
        url: params.url || "about:blank",
        type: "normal",
        width: params.width || 1280,
        height: params.height || 900,
        focused: params.focused !== false
      });
      activeAgentWindowId = newWin.id;
      const winTabs = await chrome.tabs.query({ windowId: newWin.id });
      const winTab = (winTabs && winTabs.length > 0) ? winTabs[0] : null;
      if (winTab) {
        activeAgentTabId = winTab.id;
        activeDesignatedTabId = winTab.id;
        if (params.url && params.url !== "about:blank" && params.waitForLoad !== false) {
          await waitForPageLoad(winTab.id, params.timeoutMs || 2500);
        }
      }
      const loaded = winTab ? await chrome.tabs.get(winTab.id) : {};
      let snap = null;
      if (params.returnSnap !== false && params.url && params.url !== "about:blank" && winTab) {
        try {
          const snapRes = await handleActionInner("snap", { tabId: winTab.id });
          snap = snapRes.compact;
        } catch {}
      }
      return {
        windowId: newWin.id,
        tabId: winTab ? winTab.id : null,
        title: loaded.title || "",
        url: loaded.url || params.url || "about:blank",
        isNewWindow: true,
        snapshot: snap
      };
    }

    case "close_tab": {
      const tab = await getTargetTab(params.tabId);
      if (tab.id === activeAgentTabId) {
        activeAgentTabId = null;
        activeAgentWindowId = null;
      }
      await chrome.tabs.remove(tab.id);
      return { closedTabId: tab.id };
    }

    case "smart_navigate":
    case "navigate": {
      if (!params.url) throw new Error("Missing url");

      let tab = null;
      let isReusedTab = false;
      let openedNewWindow = false;

      // 1. Explicit tabId specified: use that tab
      if (params.tabId) {
        tab = await chrome.tabs.get(Number(params.tabId));
        if (tab.url !== params.url) {
          await chrome.tabs.update(tab.id, { url: params.url, active: true });
          if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
      } else {
        // 2. Default & Dedicated Window Mode: Always execute in the dedicated agent window
        const agentWin = await getOrCreateAgentWindow(params.url);
        if (agentWin.existing) {
          // If dedicated window already exists, navigate its active tab or create tab in it
          const winTabs = await chrome.tabs.query({ windowId: agentWin.windowId, active: true });
          tab = (winTabs && winTabs.length > 0) ? winTabs[0] : null;
          if (tab) {
            if (tab.url !== params.url) {
              await chrome.tabs.update(tab.id, { url: params.url, active: true });
            }
          } else {
            tab = await chrome.tabs.create({ windowId: agentWin.windowId, url: params.url, active: true });
          }
        } else {
          tab = agentWin.tabs[0];
          openedNewWindow = true;
        }
        if (!tab) throw new Error("Failed to find tab in agent window");
        activeAgentTabId = tab.id;
      }

      if (!isReusedTab && params.waitForLoad !== false) {
        await waitForPageLoad(tab.id, params.timeoutMs || 2500);
      }
      const loadedTab = await chrome.tabs.get(tab.id);
      activeDesignatedTabId = loadedTab.id;

      let snapCompact = null;
      if (params.returnSnap !== false) {
        try {
          const snapRes = await handleActionInner("snap", { tabId: loadedTab.id });
          snapCompact = snapRes.compact;
        } catch {}
      }

      return {
        id: loadedTab.id,
        windowId: loadedTab.windowId,
        title: loadedTab.title,
        url: loadedTab.url,
        isNewWindow: openedNewWindow,
        reused: isReusedTab,
        snapshot: snapCompact
      };
    }

    case "reload": {
      const tab = await getTargetTab(params.tabId);
      await chrome.tabs.reload(tab.id);
      return { id: tab.id, reloaded: true };
    }

    // TOKEN-OPTIMIZED COMPACT SNAPSHOT (Saves 90% AI Tokens!)
    case "snap":
    case "compact_snapshot": {
      const tab = await getTargetTab(params.tabId);

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inPageGetCompactSnapshot
        });
        const snap = results[0]?.result || {};
        
        // Cache elements for instant index lookups (@1, @2)
        if (snap.items) {
          const tabCache = new Map();
          snap.items.forEach(item => tabCache.set(`@${item.i}`, item));
          elementCache.set(tab.id, tabCache);
        }

        // Ultra-compact token-efficient string
        let out = `[${snap.title}] ${snap.url}\n`;
        snap.items.forEach(el => {
          let line = `@${el.i}[${el.t}`;
          if (el.y) line += `:${el.y}`;
          if (el.s) line += `${el.s}`;
          line += `]`;
          if (el.n) line += ` "${el.n}"`;
          if (el.v) line += ` val="${el.v}"`;
          out += line + '\n';
        });

        // Universal Autonomous In-Tab Checkpoint: Never halt agent or return lock to LLM
        const pwItem = snap.items.find(i => i.y === 'password' || (i.n && /password|enter pin|unlock code/i.test(i.n)));
        if (pwItem) {
          const userWaitRes = await handleActionInner("wait_for_user", {
            tabId: tab.id,
            reason: "Screen Lock / Password Required: Enter password or unlock to continue",
            timeoutSec: 120
          });
          // If user provided password in prompt, automatically enter it and submit
          if (userWaitRes.value) {
            try {
              await handleActionInner("type", {
                tabId: tab.id,
                target: `@${pwItem.i}`,
                text: userWaitRes.value,
                pressEnter: true
              });
              await new Promise(r => setTimeout(r, 1200));
            } catch {}
          }
          // Refresh snapshot after unlock
          const refreshedRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageGetCompactSnapshot
          });
          const freshSnap = refreshedRes[0]?.result || snap;
          let freshOut = `[${freshSnap.title}] ${freshSnap.url}\n`;
          (freshSnap.items || []).forEach(el => {
            let line = `@${el.i}[${el.t}`;
            if (el.y) line += `:${el.y}`;
            if (el.s) line += `${el.s}`;
            line += `]`;
            if (el.n) line += ` "${el.n}"`;
            if (el.v) line += ` val="${el.v}"`;
            freshOut += line + '\n';
          });
          return { tabId: tab.id, compact: freshOut, count: (freshSnap.items || []).length, unlocked: true };
        }

        return { tabId: tab.id, compact: out, count: snap.items.length };
      } catch (err) {
        return { tabId: tab.id, compact: `[URL: ${tab.url}] [Restricted Page: ${err.message}]`, count: 0 };
      }
    }

    // MULTI-ACTION PIPELINE (Executes multiple steps in 1 single fast round trip with live HUD)
    case "pipeline": {
      const steps = params.steps || [];
      const tab = await getTargetTab(params.tabId);
      const results = [];
      const startTime = Date.now();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        step.params = step.params || {};
        step.params.tabId = tab.id;
        step.params.returnSnap = false;

        const stepName = step.action === 'click' ? `Clicking ${step.params.target || step.params.text || 'element'}`
          : step.action === 'type' ? `Typing "${String(step.params.text || '').slice(0, 16)}"`
          : step.action === 'wait' ? `Waiting ${step.ms || 50}ms`
          : step.action;

        showAgentOverlay(tab.id, stepName, startTime, true, i + 1, steps.length);

        if (step.action === "wait") {
          await new Promise(r => setTimeout(r, step.ms || 50));
          results.push({ action: "wait", ok: true });
        } else {
          const res = await handleActionInner(step.action, step.params);
          results.push({ action: step.action, ok: true, result: res });
        }
      }

      let snapCompact = null;
      if (params.returnSnap !== false) {
        try {
          const snapRes = await handleActionInner("snap", { tabId: tab.id });
          snapCompact = snapRes.compact;
        } catch {}
      }

      return { ok: true, count: steps.length, results, snapshot: snapCompact };
    }

    // INSTANT ELEMENT CLICK + Highlight + Auto-Snap
    case "click": {
      const tab = await getTargetTab(params.tabId);
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inPageClick,
          args: [params]
        });
      } catch (err) {
        // Automatic Obstruction/Overlay Recovery: Dismiss popups, consent banners, dialogs and retry
        try {
          await handleActionInner("dismiss_overlays", { tabId: tab.id });
          await new Promise(r => setTimeout(r, 200));
          results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageClick,
            args: [params]
          });
        } catch {
          throw err;
        }
      }
      const clickResult = results[0]?.result || {};
      if (clickResult.selector) highlightElement(tab.id, clickResult.selector);

      if (params.returnSnap !== false) {
        try {
          const snapRes = await handleActionInner("snap", { tabId: tab.id });
          clickResult.snapshot = snapRes.compact;
        } catch {}
      }
      return clickResult;
    }

    // NATIVE CDP COORDINATE / SELECTOR CLICK (Hardware-level trusted event)
    case "native_click": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);

      let x = params.x;
      let y = params.y;

      // If selector provided, get center coordinates
      if (params.selector || params.target) {
        const coords = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          },
          args: [params.selector || params.target]
        });
        if (coords[0]?.result) {
          x = coords[0].result.x;
          y = coords[0].result.y;
        }
      }

      if (x === undefined || y === undefined) throw new Error("Could not determine click coordinates");

      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1
      });

      return { success: true, native: true, x, y };
    }

    // INSTANT INPUT TYPING + Highlight + Auto-Snap on Submit
    case "type": {
      const tab = await getTargetTab(params.tabId);
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inPageType,
          args: [params]
        });
      } catch (err) {
        // Automatic Obstruction/Overlay Recovery: Dismiss popups, consent banners, dialogs and retry
        try {
          await handleActionInner("dismiss_overlays", { tabId: tab.id });
          await new Promise(r => setTimeout(r, 200));
          results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageType,
            args: [params]
          });
        } catch {
          throw err;
        }
      }
      const typeResult = results[0]?.result || {};
      if (typeResult.selector) highlightElement(tab.id, typeResult.selector);

      if (params.pressEnter && params.returnSnap !== false) {
        try {
          const snapRes = await handleActionInner("snap", { tabId: tab.id });
          typeResult.snapshot = snapRes.compact;
        } catch {}
      }
      return typeResult;
    }

    // SMOOTH SCROLL (up / down / element)
    case "scroll": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (direction, amount) => {
          const dy = direction === "up" ? -Math.abs(amount || 400) : Math.abs(amount || 400);
          window.scrollBy({ top: dy, behavior: "smooth" });
          return { scrollX: window.scrollX, scrollY: window.scrollY + dy, direction };
        },
        args: [params.direction || "down", params.amount || 400]
      });
      return results[0]?.result || { scrolled: true };
    }

    // NATIVE SELECT DROPDOWN OPTION
    case "select": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (selector, value) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`Select element not found: ${selector}`);
          if (el.tagName.toLowerCase() !== "select") throw new Error(`Target is not a <select> element: ${selector}`);
          let matched = false;
          let selectedText = "";
          for (let opt of el.options) {
            if (opt.value === value || opt.text.trim().toLowerCase() === String(value).trim().toLowerCase()) {
              el.value = opt.value;
              selectedText = opt.text;
              matched = true;
              break;
            }
          }
          if (!matched) {
            el.value = value;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { selectedValue: el.value, selectedText: selectedText || el.value };
        },
        args: [params.selector, params.value]
      });
      return results[0]?.result || {};
    }

    // NATIVE KEY PRESS (Enter, Escape, Tab, Backspace, shortcuts)
    case "press": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      const key = params.key || "Enter";

      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: key, windowsVirtualKeyCode: key === "Enter" ? 13 : (key === "Escape" ? 27 : 9)
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "keyUp", key: key
      });

      return { success: true, pressed: key };
    }

    // BATCH FORM FILLING
    case "batch_form": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageBatchForm,
        args: [params]
      });
      return results[0]?.result || {};
    }

    // HIGH-RES SCREENSHOT
    case "screenshot": {
      const tab = await getTargetTab(params.tabId);
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });

      if (attachedTabs.has(tab.id)) {
        try {
          const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", { format: "png", quality: 90 });
          if (res?.data) return { dataUrl: "data:image/png;base64," + res.data, length: res.data.length };
        } catch (_) {}
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, length: dataUrl.length };
    }

    // DEVTOOLS: NETWORK
    case "network": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      const buf = getNetworkBuffer(tab.id);
      const entries = buf.toArray();
      const filter = params.filter ? String(params.filter).toLowerCase() : null;
      const limit = params.limit ? Number(params.limit) : 40;
      const compact = params.compact !== false; // default to token-optimized compact output

      let results = entries;
      if (filter) results = results.filter(r => (r.url && r.url.toLowerCase().includes(filter)) || (r.method && r.method.toLowerCase().includes(filter)));
      
      const sliced = results.slice(-limit);
      if (compact) {
        // High token efficiency: trim verbose HTTP headers and return concise request/response tuples
        const compactEntries = sliced.map(r => ({
          reqId: r.requestId,
          t: r.timestamp,
          m: r.method,
          url: r.url ? (r.url.length > 120 ? r.url.slice(0, 117) + '...' : r.url) : null,
          status: r.status,
          type: r.mimeType || r.type
        }));
        return { tabId: tab.id, total: buf.length, count: compactEntries.length, logs: compactEntries };
      }
      return { tabId: tab.id, totalCaptured: buf.length, returned: sliced };
    }

    // DEVTOOLS: CONSOLE
    case "console": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      const buf = getConsoleBuffer(tab.id);
      const entries = buf.toArray();
      const level = params.level ? String(params.level).toLowerCase() : null;
      const limit = params.limit ? Number(params.limit) : 40;
      const compact = params.compact !== false;

      let results = entries;
      if (level) results = results.filter(l => l.level && l.level.toLowerCase() === level);
      const sliced = results.slice(-limit);

      if (compact) {
        // Strip heavy multi-line stack traces to save 75% tokens
        const compactLogs = sliced.map(l => ({
          lvl: l.level,
          txt: l.text ? (l.text.length > 150 ? l.text.slice(0, 147) + '...' : l.text) : '',
          cnt: l.count || 1,
          loc: l.stack ? l.stack.split('\n')[0] : (l.url ? `${l.url}:${l.lineNumber || l.line || ''}` : null)
        }));
        return { tabId: tab.id, total: buf.length, count: compactLogs.length, logs: compactLogs };
      }
      return { tabId: tab.id, totalLogs: buf.length, logs: sliced };
    }

    // DEVTOOLS: RAW CDP
    case "cdp": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      return await chrome.debugger.sendCommand({ tabId: tab.id }, params.method, params.params || {});
    }

    // STORAGE & COOKIES
    case "cookies": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      return await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getCookies", { urls: [tab.url] });
    }

    case "clear_cookies": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.clearBrowserCookies");
      return { success: true };
    }

    // NOTIFICATION: Smooth audio chime + screen flash overlay
    case "notify":
    case "alert_user": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageNotifyUser,
        args: [params.message || "Action required in browser", params.title || "User Input Needed"]
      });
      return results[0]?.result || { success: true };
    }

    case "clear_cache": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.clearBrowserCache");
      return { success: true };
    }

    case "eval": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);
      if (attachedTabs.has(tab.id)) {
        try {
          const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: params.code || "",
            returnByValue: true,
            awaitPromise: true
          });
          if (res.exceptionDetails) {
            return { success: false, error: res.exceptionDetails.text };
          }
          return { success: true, result: res.result?.value !== undefined ? res.result.value : res.result };
        } catch (_) {}
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageEval,
        args: [params.code || ""]
      });
      return results[0]?.result || {};
    }

    // IN-SESSION HTTP FETCH: Execute fetch() directly inside active authenticated page session
    case "fetch":
    case "page_fetch": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (fetchOpts) => {
          try {
            const { url, method = 'GET', headers = {}, body } = fetchOpts;
            const res = await window.fetch(url, {
              method,
              headers,
              body: body ? (typeof body === 'object' ? JSON.stringify(body) : body) : undefined,
              credentials: 'include'
            });
            const text = await res.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (_) {}
            return {
              ok: res.ok,
              status: res.status,
              statusText: res.statusText,
              data: parsed !== null ? parsed : (text.length > 500 ? text.slice(0, 500) + '...' : text),
              isJson: parsed !== null
            };
          } catch (err) {
            return { ok: false, error: err.message || String(err) };
          }
        },
        args: [params]
      });
      return results[0]?.result || { ok: false, error: "Execution failed" };
    }

    case "reload_extension": {
      setTimeout(() => chrome.runtime.reload(), 50);
      return { success: true, message: "Extension reload initiated" };
    }

    // Standard snapshot (kept for backward compatibility)
    case "snapshot": {
      const tab = await getTargetTab(params.tabId);
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inPageGetSnapshot
        });
        const snap = results[0]?.result || {};

        // Universal Autonomous In-Tab Checkpoint: Check if snapshot found password fields or lock screen
        const hasPassword = (snap.interactiveElements || []).some(el => el.type === 'password' || /password|enter pin|unlock code/i.test(el.placeholder || el.text || ''));
        if (hasPassword) {
          const userWaitRes = await handleActionInner("wait_for_user", {
            tabId: tab.id,
            reason: "Screen Lock / Password Required: Enter password or unlock to continue",
            timeoutSec: 120
          });
          if (userWaitRes.value) {
            const pwEl = (snap.interactiveElements || []).find(el => el.type === 'password');
            if (pwEl) {
              try {
                await handleActionInner("type", {
                  tabId: tab.id,
                  selector: pwEl.selector || `@${pwEl.index}`,
                  text: userWaitRes.value,
                  pressEnter: true
                });
                await new Promise(r => setTimeout(r, 1200));
              } catch {}
            }
          }
          const retryRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageGetSnapshot
          });
          return retryRes[0]?.result || snap;
        }

        return snap;
      } catch (err) {
        return { title: tab.title, url: tab.url, interactiveElementsCount: 0, interactiveElements: [], isRestricted: true };
      }
    }

    // SANDBOX WINDOW - Launch isolated agent browser window (avoids user interruption)
    case "sandbox_window":
    case "launch_sandbox": {
      const url = params.url || "about:blank";
      let userFocusedWindowId = null;
      try {
        const lastFocused = await chrome.windows.getLastFocused();
        userFocusedWindowId = lastFocused?.id;
      } catch {}

      const newWindow = await chrome.windows.create({
        url,
        type: "normal",
        width: params.width || 1280,
        height: params.height || 900,
        focused: false
      });

      // Safely query the tab in the new window (newWindow.tabs can be undefined in MV3)
      const windowTabs = await chrome.tabs.query({ windowId: newWindow.id });
      const sandboxTab = (windowTabs && windowTabs.length > 0) ? windowTabs[0] : null;

      if (!sandboxTab) {
        throw new Error("Failed to find tab in newly created sandbox window");
      }

      activeSandboxWindowId = newWindow.id;
      activeSandboxTabId = sandboxTab.id;
      activeDesignatedTabId = sandboxTab.id;

      // Keep user's personal window focused so browsing is uninterrupted
      if (params.focus !== true && userFocusedWindowId && userFocusedWindowId !== newWindow.id) {
        chrome.windows.update(userFocusedWindowId, { focused: true }).catch(() => {});
      }

      if (url !== "about:blank") {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 8000);
          function listener(tabId, info) {
            if (tabId === sandboxTab.id && info.status === "complete") {
              clearTimeout(timeout);
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          }
          chrome.tabs.onUpdated.addListener(listener);
        });
      }
      await ensureDebuggerAttached(sandboxTab.id);
      return {
        windowId: newWindow.id,
        tabId: sandboxTab.id,
        url: sandboxTab.url || url,
        isolated: true,
        message: "Dedicated sandbox window active. AI agent will execute here without interrupting personal tabs."
      };
    }

    case "close_sandbox": {
      if (activeSandboxWindowId) {
        try { await chrome.windows.remove(activeSandboxWindowId); } catch {}
        activeSandboxWindowId = null;
        activeSandboxTabId = null;
        return { success: true, closed: true };
      }
      return { success: true, closed: false, message: "No active sandbox window" };
    }

    // VISUAL ELEMENT PICKER / HIGHLIGHT ALL DETECTED ELEMENTS
    case "highlight_elements":
    case "inspect_elements": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const existing = document.querySelectorAll('.__bridge_el_badge');
          if (existing.length > 0) {
            existing.forEach(e => e.remove());
            return { count: 0, removed: true };
          }

          const query = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"]';
          const nodes = Array.from(document.querySelectorAll(query)).filter(el => {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 4 && r.height > 4;
          }).slice(0, 50);

          nodes.forEach((el, idx) => {
            const badge = document.createElement('div');
            badge.className = '__bridge_el_badge';
            const num = idx + 1;
            badge.textContent = `@${num}`;
            const r = el.getBoundingClientRect();
            badge.style.cssText = `
              position: absolute;
              top: ${window.scrollY + r.top - 8}px;
              left: ${window.scrollX + r.left}px;
              z-index: 2147483646;
              background: #6366f1;
              color: white;
              font: 700 10px -apple-system, sans-serif;
              padding: 2px 5px;
              border-radius: 4px;
              box-shadow: 0 2px 6px rgba(0,0,0,0.4);
              pointer-events: none;
              transition: opacity 0.3s;
            `;
            document.body.appendChild(badge);

            const prevOutline = el.style.outline;
            el.style.outline = '2px dashed rgba(99, 102, 241, 0.7)';
            el.style.outlineOffset = '2px';
            setTimeout(() => {
              el.style.outline = prevOutline;
              badge.style.opacity = '0';
              setTimeout(() => badge.remove(), 300);
            }, 3000);
          });

          return { count: nodes.length, highlighted: true };
        }
      });
      return results[0]?.result || {};
    }

    // SMART BATCH FORM FILL - Matches by label, placeholder, name, id
    case "batch_fill":
    case "fill_form": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageSmartBatchFill,
        args: [params]
      });
      return results[0]?.result || {};
    }

    // READ PAGE - Extract clean readable text
    case "read_page": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const main = document.querySelector('article, main, #content, .content') || document.body;
          const headings = Array.from(main.querySelectorAll('h1, h2, h3')).map(h => h.innerText.trim()).filter(Boolean);
          const paras = Array.from(main.querySelectorAll('p')).map(p => p.innerText.trim()).filter(t => t.length > 25);
          return {
            title: headings[0] || document.title,
            headings: headings.slice(0, 8),
            content: paras.slice(0, 10).join('\n\n'),
            url: location.href
          };
        }
      });
      return results[0]?.result || {};
    }

    // 1. VISION-ENHANCED GROUNDING (Numbered Bounding Box Overlays)
    case "visual_grounding":
    case "grounding": {
      const tab = await getTargetTab(params.tabId);
      await ensureDebuggerAttached(tab.id);

      // Inject visual bounding boxes with tags [1], [2], [3]
      const groundRes = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageAddGroundingTags
      });
      const data = groundRes[0]?.result || { count: 0, elements: [] };

      // Capture screenshot with overlays visible
      let dataUrl = "";
      try {
        if (attachedTabs.has(tab.id)) {
          const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", { format: "png", quality: 85 });
          if (res?.data) dataUrl = "data:image/png;base64," + res.data;
        }
        if (!dataUrl) {
          dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        }
      } catch (err) {
        dataUrl = "";
      }

      // Remove overlay immediately so page remains clean
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageRemoveGroundingTags
      });

      return {
        tabId: tab.id,
        count: data.count,
        elements: data.elements,
        screenshotDataUrl: dataUrl
      };
    }

    // 2. PARALLEL MULTI-TAB DATA SCRAPING PIPELINE
    case "parallel_scrape": {
      const urls = params.urls || [];
      if (!urls.length) throw new Error("Missing urls array parameter");

      const results = await Promise.all(urls.map(async (url) => {
        let workerTab = null;
        try {
          workerTab = await chrome.tabs.create({ url, active: false });
          await waitForPageLoad(workerTab.id, params.timeoutMs || 2500);

          const scriptRes = await chrome.scripting.executeScript({
            target: { tabId: workerTab.id },
            func: () => {
              const main = document.querySelector('article, main, #content, .content') || document.body;
              const headings = Array.from(main.querySelectorAll('h1, h2')).map(h => h.innerText.trim()).filter(Boolean).slice(0, 5);
              const paras = Array.from(main.querySelectorAll('p')).map(p => p.innerText.trim()).filter(t => t.length > 20).slice(0, 4);
              return {
                title: document.title,
                url: location.href,
                headings,
                snippet: paras.join(' ').slice(0, 250)
              };
            }
          });
          return { ok: true, data: scriptRes[0]?.result || {} };
        } catch (err) {
          return { ok: false, url, error: err.message };
        } finally {
          if (workerTab && params.keepOpen !== true) {
            try { await chrome.tabs.remove(workerTab.id); } catch {}
          }
        }
      }));

      return { total: urls.length, results };
    }

    // 3. SMART HUMAN-IN-THE-LOOP (CAPTCHA / 2FA DETECTION & HAND-OFF)
    case "detect_challenge":
    case "check_challenge": {
      const tab = await getTargetTab(params.tabId);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageDetectSecurityChallenge
      });
      const check = res[0]?.result || { challengeDetected: false };

      if (check.challengeDetected) {
        // Smooth Hand-off: bring tab forward and display alert banner
        try {
          if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageShowHumanHandOffBanner,
            args: [check.type]
          });
        } catch {}
      }

      return { tabId: tab.id, ...check };
    }

    // 4. SESSION MACROS (RECORDING & INSTANT REPLAY)
    case "save_macro": {
      if (!params.name || !params.steps) throw new Error("Missing macro name or steps");
      const macros = await chrome.storage.local.get("agent_macros").then(r => r.agent_macros || {});
      macros[params.name] = {
        name: params.name,
        description: params.description || "",
        steps: params.steps,
        savedAt: new Date().toISOString()
      };
      await chrome.storage.local.set({ agent_macros: macros });
      return { success: true, name: params.name, stepsCount: params.steps.length };
    }

    case "run_macro": {
      if (!params.name) throw new Error("Missing macro name");
      const macros = await chrome.storage.local.get("agent_macros").then(r => r.agent_macros || {});
      const macro = macros[params.name];
      if (!macro) throw new Error(`Macro "${params.name}" not found`);

      const steps = JSON.parse(JSON.stringify(macro.steps));
      if (params.variables) {
        for (const step of steps) {
          for (const [k, v] of Object.entries(params.variables)) {
            if (step.params) {
              if (typeof step.params.text === "string") step.params.text = step.params.text.replace(new RegExp(`{{${k}}}`, 'g'), v);
              if (typeof step.params.url === "string") step.params.url = step.params.url.replace(new RegExp(`{{${k}}}`, 'g'), v);
            }
          }
        }
      }

      const tab = await getTargetTab(params.tabId);
      const pipelineRes = await handleActionInner("pipeline", { steps, tabId: tab.id });
      return { success: true, macro: params.name, pipeline: pipelineRes };
    }

    case "list_macros": {
      const macros = await chrome.storage.local.get("agent_macros").then(r => r.agent_macros || {});
      return { macros: Object.keys(macros).map(k => ({ name: k, description: macros[k].description, stepsCount: macros[k].steps.length })) };
    }

    // ADAPTIVE TASK & PROBLEM MEMORY SYSTEM
    case "set_memory":
    case "remember": {
      const { key, value } = params;
      if (!key) throw new Error("Missing 'key' for memory storage");
      const mem = await chrome.storage.local.get("agent_memory").then(r => r.agent_memory || {});
      mem[key] = { value, updatedAt: new Date().toISOString() };
      await chrome.storage.local.set({ agent_memory: mem });
      return { success: true, key, stored: true };
    }

    case "get_memory":
    case "recall": {
      const { key } = params;
      const mem = await chrome.storage.local.get("agent_memory").then(r => r.agent_memory || {});
      if (key) {
        return { key, found: mem[key] !== undefined, entry: mem[key] || null };
      }
      return { memory: mem };
    }

    case "clear_memory": {
      const { key } = params;
      if (key) {
        const mem = await chrome.storage.local.get("agent_memory").then(r => r.agent_memory || {});
        delete mem[key];
        await chrome.storage.local.set({ agent_memory: mem });
        return { success: true, deletedKey: key };
      }
      await chrome.storage.local.remove("agent_memory");
      return { success: true, cleared: true };
    }

    // AUTOMATIC SCREEN OVERLAY & MODAL DISMISSER
    case "dismiss_overlays":
    case "close_modal": {
      const tab = await getTargetTab(params.tabId);
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageDismissOverlays
      });
      return results[0]?.result || { dismissed: 0 };
    }

    case "wait_for_user":
    case "checkpoint": {
      const tab = await getTargetTab(params.tabId);
      const reason = params.reason || "Action or password input required";
      const timeoutSec = Math.min(Math.max(Number(params.timeoutSec) || 60, 5), 300);

      // Bring window and tab forward so user can immediately take action
      try {
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
      } catch {}

      // Inject interactive checkpoint prompt with dual-tone chime
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageShowCheckpointPrompt,
        args: [reason, timeoutSec]
      });

      // Poll until user resolves or timeout expires
      const startTime = Date.now();
      const maxMs = timeoutSec * 1000;
      let reasonCleared = "timeout";

      let enteredValue = null;

      while (Date.now() - startTime < maxMs) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const checkRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: inPageCheckCheckpointStatus
          });
          const st = checkRes[0]?.result;
          if (st && st.cleared) {
            reasonCleared = st.reason || "user_action";
            enteredValue = st.value || null;
            break;
          }
        } catch {
          // Navigated or page context refreshed -> likely unlocked/submitted
          reasonCleared = "navigation_or_page_refresh";
          break;
        }
      }

      // Cleanup banner
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inPageDismissCheckpoint
        });
      } catch {}

      return {
        success: true,
        resumed: true,
        clearedBy: reasonCleared,
        value: enteredValue,
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000)
      };
    }

    case "whatsapp_send":
    case "whatsapp_send_message": {
      const { contact, message, dryRun = false, tabId } = params;
      if (!contact || !message) {
        throw new Error("Missing 'contact' or 'message' parameter");
      }

      let tab = null;
      if (tabId) {
        tab = await chrome.tabs.get(Number(tabId));
      } else {
        // Look for WhatsApp Web inside the dedicated agent window first, then overall
        if (activeAgentWindowId) {
          const agentTabs = await chrome.tabs.query({ windowId: activeAgentWindowId });
          tab = agentTabs.find(t => t.url && t.url.includes("web.whatsapp.com"));
        }
        if (!tab) {
          const tabs = await chrome.tabs.query({});
          tab = tabs.find(t => t.url && t.url.includes("web.whatsapp.com"));
        }
      }

      if (!tab) {
        const agentWin = await getOrCreateAgentWindow("https://web.whatsapp.com/");
        if (agentWin.existing) {
          tab = await chrome.tabs.create({ windowId: agentWin.windowId, url: "https://web.whatsapp.com/", active: true });
        } else {
          tab = agentWin.tabs[0];
        }
        activeAgentTabId = tab.id;
        await waitForPageLoad(tab.id, 8000);
      } else {
        await chrome.tabs.update(tab.id, { active: true });
      }

      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageWhatsAppSendMessage,
        args: [{
          contact,
          message,
          dryRun: !!dryRun
        }]
      });

      let outcome = res[0]?.result || { success: false, error: "Execution returned no result" };

      // Automatic In-Tab Lock Recovery: If locked, immediately prompt user in-tab with chime and auto-resume
      if (outcome.isLocked) {
        await handleActionInner("wait_for_user", {
          tabId: tab.id,
          reason: "Please enter your WhatsApp Web password to unlock",
          timeoutSec: 120
        });
        // Retry sending message after user unlock
        const retryRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: inPageWhatsAppSendMessage,
          args: [{ contact, message, dryRun: !!dryRun }]
        });
        outcome = retryRes[0]?.result || outcome;
      }

      return { tabId: tab.id, ...outcome };
    }

    case "extract_data": {
      const tab = await getTargetTab(params.tabId);
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inPageExtractData,
        args: [params]
      });
      return res[0]?.result || { count: 0, data: [] };
    }

    // UNIVERSAL DYNAMIC ELEMENT WAITER: Wait until an element matching a selector or text appears
    case "wait_for_element": {
      const tab = await getTargetTab(params.tabId);
      const timeoutMs = Number(params.timeoutMs) || 10000;
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (selector, text, timeout) => {
          const start = performance.now();
          const targetStr = selector || text;
          while (performance.now() - start < timeout) {
            let el = null;
            if (selector) {
              try { el = document.querySelector(selector); } catch {}
            }
            if (!el && text) {
              const query = String(text).toLowerCase();
              const all = Array.from(document.querySelectorAll('*'));
              el = all.find(e => (e.innerText || e.textContent || '').trim().toLowerCase().includes(query));
            }
            if (el) {
              const s = window.getComputedStyle(el);
              if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
                return { found: true, elapsedMs: Math.round(performance.now() - start), tag: el.tagName, id: el.id };
              }
            }
            await new Promise(r => setTimeout(r, 100));
          }
          return { found: false, timeout: true };
        },
        args: [params.selector, params.text, timeoutMs]
      });
      return results[0]?.result || { found: false };
    }

    // UNIVERSAL FILE DOWNLOAD TRIGGER (Base64, blob, or remote URL)
    case "download_file": {
      const { url, filename, conflictAction = "uniquify" } = params;
      if (!url) throw new Error("Missing 'url' parameter for download_file");
      const downloadId = await chrome.downloads.download({
        url,
        filename: filename || undefined,
        conflictAction
      });
      return { success: true, downloadId, url, filename };
    }

    case "reload_extension": {
      setTimeout(() => chrome.runtime.reload(), 150);
      return { success: true, reloaded: true };
    }

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

// IN-PAGE ULTRA-TOKEN-EFFICIENT SNAPSHOT
function inPageGetCompactSnapshot() {
  const query = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(query));

  function isVis(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  const tagMap = { button: 'btn', a: 'link', input: 'inp', textarea: 'txt', select: 'sel' };

  // Filter out invisible and completely blank elements
  const actionable = nodes.filter(el => {
    if (!isVis(el)) return false;
    const txt = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const hasMeaningfulId = el.id && !['button', 'btn', 'icon', 'root', 'app'].includes(el.id.toLowerCase());
    const hasName = !!el.getAttribute('name');
    const isInput = el.matches('input, textarea, select, [contenteditable="true"]');
    return txt.length > 0 || hasMeaningfulId || hasName || isInput;
  });

  // Prioritize elements in current viewport
  actionable.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const aInView = ra.top >= 0 && ra.top <= window.innerHeight;
    const bInView = rb.top >= 0 && rb.top <= window.innerHeight;
    if (aInView && !bInView) return -1;
    if (!aInView && bInView) return 1;
    return ra.top - rb.top;
  });

  const items = actionable.slice(0, 45).map((el, idx) => {
    const itemIdx = idx + 1;
    el.setAttribute('data-bridge-idx', String(itemIdx));
    const txt = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 36);
    const id = el.id && !['button', 'btn', 'icon'].includes(el.id.toLowerCase()) ? `#${CSS.escape(el.id)}` : null;
    const tag = tagMap[el.tagName.toLowerCase()] || el.tagName.toLowerCase();
    const type = el.type && !['submit', 'text', 'button'].includes(el.type) ? el.type : null;
    return {
      i: itemIdx,
      t: tag,
      y: type,
      n: txt || null,
      s: id,
      v: el.value ? String(el.value).slice(0, 25) : null
    };
  });

  return {
    title: document.title,
    url: window.location.href,
    items
  };
}

function inPageClick(params) {
  const { selector, text, index, target } = params;
  let el = null;

  // Support @index or #index notation via data-bridge-idx or direct query
  const targetStr = String(target || selector || text || '');
  if ((targetStr.startsWith('@') || targetStr.startsWith('#')) && !isNaN(Number(targetStr.slice(1)))) {
    const idx = targetStr.slice(1);
    el = document.querySelector(`[data-bridge-idx="${idx}"]`);
    if (!el) {
      const query = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
      const visible = Array.from(document.querySelectorAll(query)).filter(e => {
        const s = window.getComputedStyle(e);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      });
      el = visible[Number(idx) - 1];
    }
  }

  // 1. Direct CSS Selector
  const cssCandidate = selector || (target && (target.startsWith('.') || target.startsWith('#') || target.includes('[') || target.includes('>')) ? target : null);
  if (!el && cssCandidate) {
    try { el = document.querySelector(cssCandidate); } catch {}
  }
  if (!el && target) {
    try { el = document.querySelector(target); } catch {}
  }

  // 2. High-precision semantic attribute matching: data-testid, id, name, placeholder, aria-label
  if (!el && (target || selector || text)) {
    const rawVal = String(target || selector || text).trim();
    const cleanVal = rawVal.replace(/^["']|["']$/g, '');
    try {
      el = document.querySelector(`[data-testid="${CSS.escape(cleanVal)}"], [aria-label="${CSS.escape(cleanVal)}"], [name="${CSS.escape(cleanVal)}"], [placeholder="${CSS.escape(cleanVal)}"]`);
    } catch {}
  }

  // Helper: Deep search across open shadow DOMs and accessible iframes
  function deepFind(root, predicate) {
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current !== root && predicate(current)) return current;
      if (current.shadowRoot) stack.push(current.shadowRoot);
      if (current.contentDocument) stack.push(current.contentDocument.body || current.contentDocument);
      if (current.children) {
        for (let i = current.children.length - 1; i >= 0; i--) {
          stack.push(current.children[i]);
        }
      }
    }
    return null;
  }

  if (!el && (target || selector)) {
    const rawSel = String(selector || target).trim();
    el = deepFind(document.body, node => {
      try { return node.matches && node.matches(rawSel); } catch { return false; }
    });
  }

  // 3. Text content / label matching
  if (!el && (text || target)) {
    const query = String(text || target).toLowerCase().trim().replace(/^["']|["']$/g, '');
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], [role="link"], [role="tab"], div, span'));
    el = candidates.find(c => {
      const t = (c.innerText || c.textContent || c.value || c.getAttribute('aria-label') || '').toLowerCase().trim();
      return t === query;
    }) || candidates.find(c => {
      const t = (c.innerText || c.textContent || c.value || c.getAttribute('aria-label') || '').toLowerCase().trim();
      return t.includes(query) && t.length < query.length + 30;
    });
  }

  if (!el) throw new Error(`Click target not found: ${target || selector || text}`);

  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent('mouseenter', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.();
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();

  // Lively animated neon click ripple directly on the clicked element
  try {
    const rect = el.getBoundingClientRect();
    const ripple = document.createElement('div');
    ripple.className = '__bridge_click_ripple';
    ripple.style.cssText = `
      position: fixed;
      top: ${rect.top + rect.height / 2 - 16}px;
      left: ${rect.left + rect.width / 2 - 16}px;
      width: 32px; height: 32px; border-radius: 50%;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.85) 0%, rgba(168, 85, 247, 0.4) 60%, rgba(99, 102, 241, 0) 100%);
      border: 2px solid #818cf8;
      box-shadow: 0 0 16px #6366f1;
      pointer-events: none;
      z-index: 2147483647;
      transform: scale(0.2);
      transition: transform 0.35s ease-out, opacity 0.35s ease-out;
      opacity: 1;
    `;
    document.body.appendChild(ripple);
    requestAnimationFrame(() => {
      ripple.style.transform = 'scale(2.5)';
      ripple.style.opacity = '0';
      setTimeout(() => ripple.remove(), 380);
    });
  } catch {}

  // Return selector for highlight
  const clickSel = el.id ? `#${CSS.escape(el.id)}` : (el.getAttribute('data-bridge-idx') ? `[data-bridge-idx="${el.getAttribute('data-bridge-idx')}"]` : null);
  return { success: true, found: true, clicked: (el.innerText || el.value || el.tagName).trim().slice(0, 40), text: (el.innerText || el.value || '').trim().slice(0, 40), selector: clickSel };
}

function inPageType(params) {
  const { selector, text, target, clear = true, pressEnter = false } = params;
  let el = null;

  const targetStr = String(target || selector || '');
  if ((targetStr.startsWith('@') || targetStr.startsWith('#')) && !isNaN(Number(targetStr.slice(1)))) {
    const idx = targetStr.slice(1);
    el = document.querySelector(`[data-bridge-idx="${idx}"]`);
    if (!el) {
      const query = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
      const visible = Array.from(document.querySelectorAll(query)).filter(e => {
        const s = window.getComputedStyle(e);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      });
      el = visible[Number(idx) - 1];
    }
  }

  // 1. Direct CSS Selector
  if (!el && selector) {
    try { el = document.querySelector(selector); } catch {}
  }
  if (!el && target) {
    try { el = document.querySelector(target); } catch {}
  }

  // 2. High-precision semantic attribute matching: data-testid, id, name, placeholder, aria-label
  if (!el && (target || selector)) {
    const rawVal = String(target || selector).trim();
    const cleanVal = rawVal.replace(/^["']|["']$/g, '');
    try {
      el = document.querySelector(`input[name="${CSS.escape(cleanVal)}"], textarea[name="${CSS.escape(cleanVal)}"], [placeholder*="${CSS.escape(cleanVal)}" i], [aria-label*="${CSS.escape(cleanVal)}" i], [data-testid="${CSS.escape(cleanVal)}"]`);
    } catch {}
  }

  // Deep search across shadow DOMs and accessible iframes
  if (!el && (target || selector)) {
    const rawSel = String(selector || target).trim();
    const stack = [document.body];
    while (stack.length > 0) {
      const curr = stack.pop();
      if (!curr) continue;
      if (curr.matches && (curr.matches('input, textarea, [contenteditable="true"]') || curr.isContentEditable)) {
        try {
          if (curr.matches(rawSel) || curr.getAttribute('name') === rawSel || curr.getAttribute('placeholder') === rawSel || curr.id === rawSel) {
            el = curr;
            break;
          }
        } catch {}
      }
      if (curr.shadowRoot) stack.push(curr.shadowRoot);
      if (curr.contentDocument) stack.push(curr.contentDocument.body || curr.contentDocument);
      if (curr.children) {
        for (let i = curr.children.length - 1; i >= 0; i--) stack.push(curr.children[i]);
      }
    }
  }

  if (!el) el = document.activeElement;

  if (!el || (!el.matches('input, textarea, [contenteditable="true"]') && !el.isContentEditable)) {
    el = document.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
  }

  if (!el) throw new Error(`Type input not found: ${selector || target}`);

  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus();

  if (el.isContentEditable) {
    if (clear) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
      } catch {}
    }
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      if (clear) el.innerText = '';
      el.innerText += text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  } else {
    // Universal React/Vue/Angular synthetic setter support
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const newVal = (clear ? '' : (el.value || '')) + text;
    if (nativeSetter) {
      nativeSetter.call(el, newVal);
    } else {
      el.value = newVal;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (pressEnter) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const kd = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    // If not handled or cancelled by onkeydown handler (e.g., ASP.NET WebForm / Enter handlers)
    if (kd && el.form) {
      if (typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); } catch {
          try { el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch {}
        }
      } else {
        try { el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch {}
      }
    }
  }

  const typeSel = el.id ? `#${CSS.escape(el.id)}` : (el.getAttribute('name') ? `[name="${CSS.escape(el.getAttribute('name'))}"]` : null);
  return { success: true, typed: text, selector: typeSel };
}

function inPageBatchForm(params) {
  const { fields = {}, submitSelector } = params;
  for (const [sel, val] of Object.entries(fields)) {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  if (submitSelector) {
    const btn = document.querySelector(submitSelector);
    if (btn) btn.click();
  }
  return { success: true, filledCount: Object.keys(fields).length };
}

// SMART BATCH FORM FILL - Super-fast concurrent field filler with React/Vue support (< 50ms)
function inPageSmartBatchFill(params) {
  const { fields = {}, submit } = params;
  const filled = [];
  const notFound = [];

  // Fast pre-indexing of DOM inputs in a single pass
  const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'));
  const allLabels = Array.from(document.querySelectorAll('label'));

  function findInput(hint) {
    const lower = hint.toLowerCase().trim();
    // 1. Direct CSS Selector match
    try {
      const el = document.querySelector(hint);
      if (el) return el;
    } catch {}

    // 2. By ID
    const byId = document.getElementById(hint);
    if (byId) return byId;

    // 3. By Name
    const byName = allInputs.find(e => (e.getAttribute('name') || '').toLowerCase() === lower);
    if (byName) return byName;

    // 4. By Placeholder
    const byPlaceholder = allInputs.find(e => (e.placeholder || '').toLowerCase().includes(lower));
    if (byPlaceholder) return byPlaceholder;

    // 5. By Aria-Label
    const byAria = allInputs.find(e => (e.getAttribute('aria-label') || '').toLowerCase().includes(lower));
    if (byAria) return byAria;

    // 6. By Associated Label
    for (const label of allLabels) {
      if (label.textContent.toLowerCase().includes(lower)) {
        if (label.htmlFor) {
          const target = document.getElementById(label.htmlFor);
          if (target) return target;
        }
        const nested = label.querySelector('input, textarea, select');
        if (nested) return nested;
      }
    }

    // 7. By Adjacent / Parent Label-like text
    for (const inp of allInputs) {
      const prev = inp.previousElementSibling;
      if (prev && prev.textContent.toLowerCase().includes(lower)) return inp;
      const parent = inp.parentElement;
      if (parent && parent.textContent.toLowerCase().includes(lower) && parent.querySelectorAll('input, textarea, select').length === 1) return inp;
    }

    return null;
  }

  // Fill all matching fields in a single microtask pass
  for (const [key, value] of Object.entries(fields)) {
    const el = findInput(key);
    if (el) {
      el.focus();
      if (el.tagName === 'SELECT') {
        const option = Array.from(el.options).find(o => o.value === value || o.textContent.toLowerCase().includes(String(value).toLowerCase()));
        if (option) { el.value = option.value; }
      } else {
        // Trigger React / modern frameworks synthetic change handler
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, value);
        } else {
          el.value = value;
        }
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Subtle visual highlight for 1 second
      const prevOutline = el.style.outline;
      const prevShadow = el.style.boxShadow;
      el.style.outline = '2px solid #818cf8';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 10px rgba(129, 140, 248, 0.4)';
      setTimeout(() => {
        el.style.outline = prevOutline;
        el.style.boxShadow = prevShadow;
        el.style.outlineOffset = '';
      }, 1000);

      filled.push(key);
    } else {
      notFound.push(key);
    }
  }

  // Auto-submit if requested
  if (submit) {
    let btn = null;
    if (typeof submit === 'string') {
      try { btn = document.querySelector(submit); } catch {}
      if (!btn) {
        const lower = submit.toLowerCase();
        btn = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
          .find(b => (b.innerText || b.value || '').toLowerCase().includes(lower));
      }
    } else {
      btn = document.querySelector('button[type="submit"], input[type="submit"]') ||
            Array.from(document.querySelectorAll('button')).find(b => /(submit|sign.?in|log.?in|register|send|continue|next)/i.test(b.innerText || b.value || ''));
    }
    if (btn) {
      btn.click();
      filled.push('__submitted');
    }
  }

  return { success: true, filled, notFound, total: Object.keys(fields).length };
}

function inPageEval(code) {
  try {
    // Indirect eval ensures execution occurs in the global scope without inheriting strict mode
    const globalEval = (0, eval);
    const result = globalEval(code);
    let serialized = null;
    if (result !== undefined) {
      try {
        serialized = JSON.parse(JSON.stringify(result, (k, v) => {
          if (typeof v === 'function') return '[Function]';
          if (typeof v === 'bigint') return v.toString();
          if (v instanceof Error) return v.message || String(v);
          return v;
        }));
      } catch {
        serialized = String(result);
      }
    }
    return {
      success: true,
      result: serialized
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

function inPageGetSnapshot() {
  const snap = typeof inPageGetCompactSnapshot === 'function' ? inPageGetCompactSnapshot() : { title: document.title, url: location.href, items: [] };
  const bodyText = (document.body ? document.body.innerText : "").slice(0, 800);
  return {
    title: snap.title || document.title,
    url: snap.url || location.href,
    bodySummary: bodyText,
    interactiveElementsCount: (snap.items || []).length,
    interactiveElements: (snap.items || []).map(item => ({
      index: item.i,
      tag: item.t,
      type: item.y,
      text: item.n,
      selector: item.s,
      value: item.v
    }))
  };
}

// IN-PAGE USER NOTIFICATION (Smooth Web Audio chime + subtle luminous screen flash)
function inPageNotifyUser(message, title) {
  try {
    // 1. Smooth dual-tone audio chime (synthesized Web Audio, no external audio files required)
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const playTone = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + start + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };
      // Smooth bell chime: 587.33Hz (D5) -> 880Hz (A5)
      playTone(587.33, 0, 0.35);
      playTone(880.00, 0.12, 0.45);
    }

    // 2. Quick pleasant flash banner + border pulse
    const existing = document.getElementById('__antigravity_bridge_notification');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = '__antigravity_bridge_notification';
    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:20px;animation:pulse 1s infinite;">🔔</span>
        <div>
          <div style="font-weight:600;font-size:13px;letter-spacing:0.3px;color:#f8fafc;">${title || 'Input Needed'}</div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:2px;">${message}</div>
        </div>
      </div>
    `;
    banner.style.cssText = `
      position: fixed;
      top: 18px;
      right: 20px;
      z-index: 2147483647;
      background: rgba(15, 23, 42, 0.94);
      color: #f8fafc;
      padding: 12px 18px;
      border-radius: 12px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 0 0 2px rgba(56, 189, 248, 0.6);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: all 0.25s ease-out;
      backdrop-filter: blur(8px);
      cursor: pointer;
      transform: translateY(-8px);
      opacity: 0;
    `;
    document.body.appendChild(banner);

    // Subtle edge flash
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 2147483646;
      box-shadow: inset 0 0 0 4px rgba(56, 189, 248, 0.85);
      opacity: 1;
      transition: opacity 0.6s ease-out;
    `;
    document.body.appendChild(flash);

    requestAnimationFrame(() => {
      banner.style.transform = 'translateY(0)';
      banner.style.opacity = '1';
      setTimeout(() => { flash.style.opacity = '0'; }, 80);
    });

    const remove = () => {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-10px)';
      setTimeout(() => { banner.remove(); flash.remove(); }, 300);
    };

    banner.onclick = remove;
    setTimeout(remove, 6000);

    return { success: true, notified: message };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function inPageAddGroundingTags() {
  const container = document.createElement('div');
  container.id = '__bridge_grounding_container';
  container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483647;';
  
  const query = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="tab"], canvas, video, [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(query)).filter(el => {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 6 && r.height > 6 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }).slice(0, 50);

  const elements = [];
  const colors = ['#ec4899', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#06b6d4'];

  nodes.forEach((el, idx) => {
    const num = idx + 1;
    el.setAttribute('data-bridge-ground-id', String(num));
    const r = el.getBoundingClientRect();
    const color = colors[idx % colors.length];

    const box = document.createElement('div');
    box.className = '__bridge_ground_box';
    box.style.cssText = `
      position: absolute;
      top: ${window.scrollY + r.top}px;
      left: ${window.scrollX + r.left}px;
      width: ${r.width}px;
      height: ${r.height}px;
      border: 2px solid ${color};
      border-radius: 4px;
      pointer-events: none;
      box-sizing: border-box;
      box-shadow: 0 0 6px ${color}88;
    `;

    const tag = document.createElement('div');
    tag.className = '__bridge_ground_tag';
    tag.textContent = `[${num}]`;
    tag.style.cssText = `
      position: absolute;
      top: ${Math.max(0, window.scrollY + r.top - 16)}px;
      left: ${window.scrollX + r.left}px;
      background: ${color};
      color: #ffffff;
      font: bold 10px / 1.2 -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 1px 4px;
      border-radius: 3px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.5);
      pointer-events: none;
      z-index: 2;
    `;

    container.appendChild(box);
    container.appendChild(tag);

    const txt = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 30);
    elements.push({
      id: num,
      tag: el.tagName.toLowerCase(),
      text: txt || null,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      width: Math.round(r.width),
      height: Math.round(r.height),
      selector: `[data-bridge-ground-id="${num}"]`
    });
  });

  document.body.appendChild(container);
  return { count: elements.length, elements };
}

function inPageRemoveGroundingTags() {
  const container = document.getElementById('__bridge_grounding_container');
  if (container) container.remove();
}

function inPageDetectSecurityChallenge() {
  const html = document.documentElement.innerHTML.toLowerCase();
  const title = (document.title || '').toLowerCase();
  
  const indicators = [
    { type: 'Cloudflare Turnstile', match: html.includes('cf-turnstile') || !!document.querySelector('.cf-turnstile, [name="cf-turnstile-response"]') },
    { type: 'Cloudflare Challenge', match: title.includes('just a moment...') || title.includes('attention required! | cloudflare') || html.includes('challenge-platform') || html.includes('challenge-running') },
    { type: 'Google reCAPTCHA', match: html.includes('g-recaptcha') || !!document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha"]') },
    { type: 'hCaptcha', match: html.includes('hcaptcha.com') || !!document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]') },
    { type: 'Arkose FunCAPTCHA', match: html.includes('arkoselabs') || html.includes('funcaptcha') },
    { type: '2FA / Verification Code', match: html.includes('2-step verification') || html.includes('two-factor') || html.includes('authenticator code') || !!document.querySelector('input[autocomplete="one-time-code"]') }
  ];

  const found = indicators.find(i => i.match);
  if (found) {
    return {
      challengeDetected: true,
      type: found.type,
      title: document.title,
      url: window.location.href
    };
  }

  // Universal Password Barrier or App Screen Lock Detection
  const visiblePw = Array.from(document.querySelectorAll('input[type="password"]')).find(inp => {
    const s = window.getComputedStyle(inp);
    const r = inp.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 30 && r.height > 10;
  });

  const isLockScreen = html.includes('screen lock') || html.includes('enter password to unlock') || html.includes('unlock with password') || html.includes('enter your pin') || html.includes('session locked') || html.includes('locked') || html.includes('password to unlock');

  if (visiblePw && (isLockScreen || document.querySelectorAll('button, a, input').length < 15)) {
    return {
      challengeDetected: true,
      type: 'Password / App Lock',
      title: document.title,
      url: window.location.href,
      requiresPassword: true
    };
  }

  return { challengeDetected: false };
}

function inPageShowCheckpointPrompt(reason, timeoutSec) {
  try {
    window.__bridge_checkpoint_cleared = false;
    window.__bridge_had_password = !!document.querySelector('input[type="password"]');

    let banner = document.getElementById('__bridge_checkpoint_banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = '__bridge_checkpoint_banner';
      banner.style.cssText = `
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(99, 102, 241, 0.4);
        color: #f8fafc; padding: 12px 20px; border-radius: 12px;
        font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 10px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(99, 102, 241, 0.25);
        backdrop-filter: blur(16px);
        display: flex; align-items: center; gap: 14px;
        animation: bridgeSlideDown 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      `;

      const style = document.createElement('style');
      style.id = '__bridge_checkpoint_style';
      style.textContent = `
        @keyframes bridgeSlideDown {
          from { opacity: 0; transform: translate(-50%, -12px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `;
      document.head.appendChild(style);
      document.body.appendChild(banner);
    }

    const isPasswordNeeded = /password|pin|code|credential|unlock|2fa/i.test(reason);

    banner.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:8px; background:rgba(99, 102, 241, 0.2); font-size:15px;">🔔</span>
            <div>
              <div style="font-weight:700; font-size:13px; color:#e0e7ff; letter-spacing:-0.2px;">AI Assistant Action Required</div>
              <div style="font-size:12px; color:#94a3b8; max-width:380px;">${reason}</div>
            </div>
          </div>
          <button id="__bridge_resume_btn" style="
            background: #6366f1; color: white; border: none; border-radius: 8px;
            padding: 6px 14px; font-weight: 600; font-size: 12px; cursor: pointer;
            transition: all 0.15s ease; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
            white-space: nowrap;
          ">Resume Agent</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-top:2px;">
          <input id="__bridge_checkpoint_input" type="${isPasswordNeeded ? 'password' : 'text'}" placeholder="${isPasswordNeeded ? 'Enter password/value here or in page...' : 'Provide input or complete in page...'}" style="
            flex:1; background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(99, 102, 241, 0.4); border-radius: 6px;
            color: #f8fafc; padding: 6px 10px; font-size: 12px; outline: none; box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);
          " />
          <button id="__bridge_submit_val_btn" style="
            background: #10b981; color: white; border: none; border-radius: 6px;
            padding: 6px 12px; font-weight: 600; font-size: 11px; cursor: pointer;
          ">Submit</button>
        </div>
      </div>
    `;

    const inp = banner.querySelector('#__bridge_checkpoint_input');
    const submitValBtn = banner.querySelector('#__bridge_submit_val_btn');

    const handleInputSubmit = () => {
      const val = inp?.value;
      if (val) {
        window.__bridge_checkpoint_input_value = val;
        // Auto fill into active password input if present on page
        const pagePw = document.querySelector('input[type="password"], input[type="text"]:focus');
        if (pagePw) {
          pagePw.value = val;
          pagePw.dispatchEvent(new Event('input', { bubbles: true }));
          pagePw.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      window.__bridge_checkpoint_cleared = true;
    };

    if (submitValBtn) submitValBtn.onclick = handleInputSubmit;
    if (inp) {
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') handleInputSubmit();
      };
      inp.focus();
    }

    const btn = banner.querySelector('#__bridge_resume_btn');
    if (btn) {
      btn.onmouseenter = () => { btn.style.background = '#4f46e5'; };
      btn.onmouseleave = () => { btn.style.background = '#6366f1'; };
      btn.onclick = () => {
        window.__bridge_checkpoint_cleared = true;
        btn.textContent = 'Resuming...';
        btn.style.opacity = '0.7';
      };
    }

    // Melodic Web Audio Dual-Tone Chime: E5 (659Hz) -> B5 (988Hz)
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, ctx.currentTime);
      gain1.gain.setValueAtTime(0.15, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.25);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(987.77, ctx.currentTime + 0.12);
      gain2.gain.setValueAtTime(0.18, ctx.currentTime + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(ctx.currentTime + 0.12);
      osc2.stop(ctx.currentTime + 0.55);
    } catch {}
  } catch {}
}

function inPageCheckCheckpointStatus() {
  if (window.__bridge_checkpoint_cleared) {
    return {
      cleared: true,
      reason: window.__bridge_checkpoint_input_value ? 'user_provided_input' : 'user_clicked_resume',
      value: window.__bridge_checkpoint_input_value || null
    };
  }
  if (window.__bridge_had_password) {
    const pw = document.querySelector('input[type="password"]');
    if (!pw) {
      return { cleared: true, reason: 'password_field_disappeared' };
    }
    const s = window.getComputedStyle(pw);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
      return { cleared: true, reason: 'password_field_hidden' };
    }
  }
  return { cleared: false };
}

function inPageDismissOverlays() {
  let dismissedCount = 0;
  // 1. Common modal close button selectors
  const closeSelectors = [
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    '[aria-label*="close" i]',
    '.modal-close',
    '.close-modal',
    '.overlay-close',
    '.dialog-close',
    '[data-dismiss="modal"]',
    '[data-bs-dismiss="modal"]',
    '#close-button',
    '.btn-close'
  ];

  for (const sel of closeSelectors) {
    try {
      const btns = Array.from(document.querySelectorAll(sel));
      for (const btn of btns) {
        const s = window.getComputedStyle(btn);
        if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
          btn.click();
          dismissedCount++;
          break;
        }
      }
    } catch {}
  }

  // 2. Cookie consent banner buttons (Accept All / Got it / Agree / Dismiss)
  const consentTexts = ['accept all', 'accept', 'agree', 'got it', 'i understand', 'close', 'dismiss', 'decline'];
  const candidates = Array.from(document.querySelectorAll('button, a[role="button"]'));
  for (const c of candidates) {
    const t = (c.innerText || c.textContent || '').trim().toLowerCase();
    if (consentTexts.includes(t)) {
      const parent = c.closest('[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="banner" i], [class*="modal" i]');
      if (parent) {
        c.click();
        dismissedCount++;
        break;
      }
    }
  }

  // 3. Dispatch Escape key to dismiss top modal
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));

  return { dismissed: dismissedCount, success: true };
}

function inPageDismissCheckpoint() {
  try {
    const banner = document.getElementById('__bridge_checkpoint_banner');
    if (banner) {
      banner.style.transition = 'opacity 0.2s, transform 0.2s';
      banner.style.opacity = '0';
      banner.style.transform = 'translate(-50%, -10px)';
      setTimeout(() => banner.remove(), 250);
    }
    const style = document.getElementById('__bridge_checkpoint_style');
    if (style) style.remove();
    delete window.__bridge_checkpoint_cleared;
    delete window.__bridge_had_password;
    delete window.__bridge_checkpoint_input_value;
  } catch {}
}

function inPageShowHumanHandOffBanner(challengeType) {
  try {
    let banner = document.getElementById('__bridge_handoff_banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = '__bridge_handoff_banner';
      banner.style.cssText = `
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.95), rgba(185, 28, 28, 0.95));
        color: white; padding: 12px 24px; border-radius: 9999px;
        font: 600 13px -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,0.5), 0 0 0 2px rgba(254, 202, 202, 0.5);
        backdrop-filter: blur(10px);
        display: flex; align-items: center; gap: 12px;
      `;
      document.body.appendChild(banner);
    }
    banner.innerHTML = `<span style="font-size:16px;">🛡️</span> <strong>Security Challenge (${challengeType}):</strong> Please complete this prompt. The AI agent will auto-resume once cleared.`;

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch {}

    setTimeout(() => {
      if (banner) {
        banner.style.transition = 'opacity 0.4s';
        banner.style.opacity = '0';
        setTimeout(() => banner.remove(), 400);
      }
    }, 12000);
  } catch {}
}

async function inPageWhatsAppSendMessage(opts) {
  const { contact, message, dryRun } = opts;
  const t0 = performance.now();
  const timings = {};

  // 1. Check if App Lock is active
  const lockEl = document.querySelector('[data-testid="lock-screen-landing-window"], [data-testid="password-input"]');
  if (lockEl) {
    return {
      success: false,
      isLocked: true,
      error: "WhatsApp Web is currently locked with App Lock. Please unlock it in Chrome or call chrome_wait_for_user.",
      durationMs: Math.round(performance.now() - t0)
    };
  }

  // Helper: Condition-based element waiter
  const waitForEl = (sel, timeoutMs = 4000) => {
    return new Promise((resolve) => {
      const el = document.querySelector(sel);
      if (el) return resolve(el);
      const start = performance.now();
      const interval = setInterval(() => {
        const found = document.querySelector(sel);
        if (found || performance.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(found || null);
        }
      }, 50);
    });
  };

  // 2. Wait for WhatsApp UI readiness
  const searchInput = await waitForEl('div[contenteditable="true"][data-tab="3"], [data-testid="chat-list-search"], [role="textbox"], #side [contenteditable="true"]', 5000);
  if (!searchInput) {
    const startupProgress = document.querySelector('#initial_startup, progress, [data-testid="startup-progress"]');
    if (startupProgress) {
      return { success: false, error: "WhatsApp Web is still syncing/loading. Please retry in a few seconds.", durationMs: Math.round(performance.now() - t0) };
    }
    return { success: false, error: "WhatsApp Web search box could not be located.", durationMs: Math.round(performance.now() - t0) };
  }
  timings.searchReadyMs = Math.round(performance.now() - t0);

  // 3. Search for recipient
  searchInput.focus();
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(searchInput);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
  } catch (_) {}

  document.execCommand('insertText', false, contact);
  searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: contact }));
  timings.searchTypedMs = Math.round(performance.now() - t0);

  // 4. Wait for matching search result in chat list
  await new Promise(r => setTimeout(r, 400));

  const contactLower = contact.toLowerCase().trim();
  let matchedEl = null;
  let matchedName = null;

  const searchStart = performance.now();
  while (performance.now() - searchStart < 3000) {
    const cells = Array.from(document.querySelectorAll('#side div[role="listitem"], #side [data-testid="cell-frame-container"]'));
    for (const cell of cells) {
      const titleSpan = cell.querySelector('span[title], span[dir="auto"], [data-testid="cell-frame-title"]');
      const name = (titleSpan ? (titleSpan.getAttribute('title') || titleSpan.textContent) : cell.textContent || "").trim();
      if (name.toLowerCase().includes(contactLower)) {
        matchedEl = cell;
        matchedName = name;
        break;
      }
    }
    if (matchedEl) break;
    await new Promise(r => setTimeout(r, 100));
  }

  if (!matchedEl) {
    return {
      success: false,
      error: `Recipient "${contact}" not found in WhatsApp chat list or search results.`,
      durationMs: Math.round(performance.now() - t0)
    };
  }
  timings.contactMatchedMs = Math.round(performance.now() - t0);

  // 5. Open chat
  matchedEl.click();
  matchedEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  matchedEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

  // 6. Wait for chat compose box
  const composeInput = await waitForEl('footer div[contenteditable="true"], footer [role="textbox"], div[title="Type a message"], div[contenteditable="true"][data-tab="10"]', 3000);
  if (!composeInput) {
    return {
      success: false,
      error: `Could not open conversation with "${matchedName}". Compose box not found.`,
      durationMs: Math.round(performance.now() - t0)
    };
  }
  timings.composeReadyMs = Math.round(performance.now() - t0);

  // 7. Type the message
  composeInput.focus();
  document.execCommand('insertText', false, message);
  composeInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  timings.messageTypedMs = Math.round(performance.now() - t0);

  // 8. If dry run, do not send
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      contact: matchedName,
      message,
      status: "Validated recipient and entered message. Not sent (dryRun).",
      timings,
      durationMs: Math.round(performance.now() - t0)
    };
  }

  // 9. Send message
  await new Promise(r => setTimeout(r, 50));
  let sendBtn = document.querySelector('button[data-testid="compose-btn-send"], span[data-icon="send"], button[aria-label="Send"]');
  if (sendBtn) {
    const clickTarget = sendBtn.tagName === 'BUTTON' ? sendBtn : sendBtn.closest('button') || sendBtn;
    clickTarget.click();
  } else {
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composeInput.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    composeInput.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
  }

  // 10. Verify message sent
  await new Promise(r => setTimeout(r, 200));
  const hasTextCleared = (composeInput.textContent || '').trim() === '';
  timings.verifiedMs = Math.round(performance.now() - t0);

  return {
    success: true,
    sent: true,
    contact: matchedName,
    message,
    inputCleared: hasTextCleared,
    timings,
    durationMs: Math.round(performance.now() - t0)
  };
}

function inPageExtractData(params) {
  const { selector, attribute = 'text', multiple = true, limit = 50 } = params;
  if (!selector) throw new Error("Missing selector");

  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, limit);
  const items = nodes.map((el) => {
    if (attribute === 'text') return (el.innerText || el.textContent || '').trim();
    if (attribute === 'html') return el.outerHTML;
    if (attribute === 'value') return el.value !== undefined ? el.value : null;
    return el.getAttribute(attribute);
  });

  return {
    selector,
    count: items.length,
    data: multiple ? items : (items[0] || null)
  };
}

// Alarm & Startup listeners
chrome.alarms.create("v3KeepAlive", { periodInMinutes: 0.2 });
chrome.alarms.onAlarm.addListener(() => connectToBridge());
updateBadge(false);
connectToBridge();
chrome.runtime.onStartup.addListener(() => connectToBridge());
chrome.runtime.onInstalled.addListener(() => connectToBridge());
