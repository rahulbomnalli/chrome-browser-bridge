// Chrome Browser Bridge — Pro Popup Controller
document.addEventListener("DOMContentLoaded", async () => {
  const statusPill = document.getElementById("statusPill");
  const statusLabel = document.getElementById("statusLabel");
  const pageTitle = document.getElementById("pageTitle");
  const pageUrl = document.getElementById("pageUrl");
  const chipTabId = document.getElementById("chipTabId");
  const chipWindowId = document.getElementById("chipWindowId");
  const chipCdp = document.getElementById("chipCdp");
  const reloadTabBtn = document.getElementById("reloadTabBtn");
  const metricP50 = document.getElementById("metricP50");
  const lastActionName = document.getElementById("lastActionName");
  const lastActionDuration = document.getElementById("lastActionDuration");
  const lastActionStatus = document.getElementById("lastActionStatus");
  const inspectBtn = document.getElementById("inspectBtn");
  const highlightBtn = document.getElementById("highlightBtn");
  const copyTokenBtn = document.getElementById("copyTokenBtn");
  const sidepanelBtn = document.getElementById("sidepanelBtn");
  const toast = document.getElementById("toast");

  let activeTab = null;
  let activeToken = null;

  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2000);
  }

  // 1. Load Active Tab
  async function loadActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        activeTab = tab;
        pageTitle.textContent = tab.title || "Untitled Tab";
        pageUrl.textContent = tab.url ? new URL(tab.url).hostname : "";
        chipTabId.textContent = `Tab: ${tab.id} 📋`;
        chipWindowId.textContent = `Win: ${tab.windowId}`;
      }
    } catch (_) {
      pageTitle.textContent = "No active page";
    }
  }

  // 2. Poll Bridge Telemetry & Status
  async function updateStatus() {
    try {
      chrome.runtime.sendMessage({ type: "get_bridge_status" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        activeToken = res.token || null;
        if (res.connected) {
          statusPill.className = "status-pill";
          statusLabel.textContent = "Online";
        } else {
          statusPill.className = "status-pill offline";
          statusLabel.textContent = "Offline";
        }

        if (res.lastTelemetry) {
          lastActionName.textContent = res.lastTelemetry.action || "Ready";
          lastActionDuration.textContent = res.lastTelemetry.durationMs ? `${res.lastTelemetry.durationMs} ms` : "—";
          if (res.lastTelemetry.ok) {
            lastActionStatus.className = "tag-ok";
            lastActionStatus.textContent = "OK";
          } else {
            lastActionStatus.className = "tag-fail";
            lastActionStatus.style.background = "rgba(239, 68, 68, 0.12)";
            lastActionStatus.style.color = "#ef4444";
            lastActionStatus.textContent = "FAIL";
          }
        }
      });

      // Query server metrics for p50
      const serverRes = await fetch("http://127.0.0.1:8765/status", { signal: AbortSignal.timeout(600) }).then(r => r.json()).catch(() => null);
      if (serverRes?.latencyMs?.p50 !== null && serverRes?.latencyMs?.p50 !== undefined) {
        metricP50.textContent = `p50: ${serverRes.latencyMs.p50}ms`;
      }
    } catch (_) {}
  }

  // 3. User Actions
  chipTabId?.addEventListener("click", () => {
    if (!activeTab?.id) return;
    navigator.clipboard.writeText(String(activeTab.id));
    showToast(`Copied Tab ID: ${activeTab.id}`);
  });

  reloadTabBtn?.addEventListener("click", async () => {
    if (!activeTab?.id) return;
    reloadTabBtn.style.transform = "rotate(360deg)";
    await chrome.tabs.reload(activeTab.id);
    showToast("Reloaded tab");
    setTimeout(() => { reloadTabBtn.style.transform = "none"; }, 400);
    await loadActiveTab();
  });

  statusPill?.addEventListener("click", () => {
    statusLabel.textContent = "Reconnecting...";
    chrome.runtime.sendMessage({ type: "reconnect_bridge" }, () => {
      showToast("Reconnecting bridge socket...");
      setTimeout(updateStatus, 500);
    });
  });

  copyTokenBtn?.addEventListener("click", () => {
    if (activeToken) {
      navigator.clipboard.writeText(activeToken);
      showToast("Copied Bearer Token 🔑");
    } else {
      showToast("No active token found");
    }
  });

  inspectBtn?.addEventListener("click", async () => {
    if (!activeTab?.id) return;
    showToast("Inspecting page tree...");
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const els = Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role='button']"))
            .filter(el => el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
          const lines = els.slice(0, 30).map((el, idx) => {
            const tag = el.tagName.toLowerCase();
            const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 40).replace(/\n/g, ' ');
            return `@${idx + 1}[${tag}] "${text}"`;
          });
          return { count: els.length, summary: lines.join('\n') };
        }
      });
      const res = results[0]?.result;
      if (res?.summary) {
        await navigator.clipboard.writeText(res.summary);
        showToast(`Copied ${res.count} targets to clipboard 📋`);
      } else {
        showToast("No interactive elements found");
      }
    } catch (e) {
      showToast("Cannot inspect this page");
    }
  });

  highlightBtn?.addEventListener("click", async () => {
    if (!activeTab?.id) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const existing = document.getElementById("__bridge_highlight_root");
          if (existing) { existing.remove(); return; }
          const root = document.createElement("div");
          root.id = "__bridge_highlight_root";
          root.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999999;";
          const els = Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role='button']"))
            .filter(el => el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').slice(0, 40);
          els.forEach((el, idx) => {
            const r = el.getBoundingClientRect();
            const box = document.createElement("div");
            box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);box-sizing:border-box;border-radius:3px;`;
            const badge = document.createElement("span");
            badge.textContent = `@${idx + 1}`;
            badge.style.cssText = "position:absolute;top:-10px;left:0;background:#2563eb;color:#fff;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;font-family:monospace;";
            box.appendChild(badge);
            root.appendChild(box);
          });
          document.body.appendChild(root);
        }
      });
      showToast("Toggled element highlights 🎯");
    } catch (_) {
      showToast("Cannot highlight this page");
    }
  });

  sidepanelBtn?.addEventListener("click", async () => {
    if (!activeTab?.windowId) return;
    try {
      if (chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: activeTab.windowId });
        window.close();
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
      }
    } catch (_) {
      chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
    }
  });

  loadActiveTab();
  updateStatus();
  setInterval(updateStatus, 2000);
});
