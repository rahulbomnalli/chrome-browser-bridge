// Antigravity Chrome Bridge - Dark Theme Popup Controller
document.addEventListener("DOMContentLoaded", async () => {
  const statusPill = document.getElementById("statusPill");
  const statusLabel = document.getElementById("statusLabel");
  const sidepanelBtn = document.getElementById("sidepanelBtn");
  const pageDomain = document.getElementById("pageDomain");
  const pageTitle = document.getElementById("pageTitle");
  const pageUrl = document.getElementById("pageUrl");
  const reloadBtn = document.getElementById("reloadBtn");
  const commandInput = document.getElementById("commandInput");
  const submitBtn = document.getElementById("submitBtn");
  const chipSnapshot = document.getElementById("chipSnapshot");
  const chipRead = document.getElementById("chipRead");
  const chipScroll = document.getElementById("chipScroll");
  const canvasCard = document.getElementById("canvasCard");
  const canvasImg = document.getElementById("canvasImg");
  const canvasText = document.getElementById("canvasText");
  const copyCanvasBtn = document.getElementById("copyCanvasBtn");
  const downloadCanvasBtn = document.getElementById("downloadCanvasBtn");
  const closeCanvasBtn = document.getElementById("closeCanvasBtn");
  const toast = document.getElementById("toast");

  let currentTab = null;
  let activeImageBlob = null;
  let activeTextContent = null;

  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function getDomain(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return u.hostname.replace(/^www\./, "");
    } catch {
      return rawUrl || "";
    }
  }

  // 1. Status Check
  async function checkStatus() {
    try {
      const res = await fetch("http://127.0.0.1:8765/status", { signal: AbortSignal.timeout(1000) });
      const data = await res.json();
      if (data.connected || data.status === "ok") {
        if (statusPill) statusPill.className = "status-pill";
        if (statusLabel) statusLabel.textContent = "Bridge Active";
      } else {
        if (statusPill) statusPill.className = "status-pill offline";
        if (statusLabel) statusLabel.textContent = "Offline";
      }
    } catch {
      if (statusPill) statusPill.className = "status-pill offline";
      if (statusLabel) statusLabel.textContent = "Offline";
    }
  }

  statusPill?.addEventListener("click", async () => {
    if (statusLabel) statusLabel.textContent = "Reconnecting...";
    await checkStatus();
    showToast(statusLabel?.textContent === "Bridge Active" ? "Connected" : "Server not running");
  });

  // 2. Load Active Tab
  async function loadActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentTab = tab;
        if (pageDomain) pageDomain.textContent = getDomain(tab.url);
        if (pageTitle) pageTitle.textContent = tab.title || "Untitled Tab";
        if (pageUrl) pageUrl.textContent = tab.url || "";
      }
    } catch (err) {
      if (pageTitle) pageTitle.textContent = "No active page";
    }
  }

  // 3. Reload Button
  reloadBtn?.addEventListener("click", async () => {
    if (!currentTab) return;
    reloadBtn.style.transform = "rotate(360deg)";
    try {
      await chrome.tabs.reload(currentTab.id);
      showToast("Page reloaded");
    } finally {
      setTimeout(() => { if (reloadBtn) reloadBtn.style.transform = "none"; }, 400);
    }
  });

  // 4. Command Input Handler (Smart Action or URL)
  async function handleCommand() {
    if (!commandInput) return;
    const query = commandInput.value.trim();
    if (!query || !currentTab) return;

    // Check if it's a URL or domain
    const isDomain = query.includes(".") && !query.includes(" ");
    const isUrl = /^https?:\/\//i.test(query) || query.startsWith("localhost") || query.startsWith("127.0.0.1");

    if (isUrl || isDomain) {
      let finalUrl = query;
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = finalUrl.startsWith("localhost") ? "http://" + finalUrl : "https://" + finalUrl;
      }
      await chrome.tabs.update(currentTab.id, { url: finalUrl });
      showToast("Navigating...");
      setTimeout(() => window.close(), 300);
      return;
    }

    // Otherwise, click the target button/link by text on the page
    if (submitBtn) submitBtn.textContent = "⏳";
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: (targetText) => {
          const lower = targetText.toLowerCase();
          const clickable = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']"));
          const match = clickable.find(el => {
            const t = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
            return t === lower || t.includes(lower);
          });

          if (match) {
            match.scrollIntoView({ behavior: "smooth", block: "center" });
            match.click();
            return { found: true, text: match.innerText || match.value || targetText };
          }
          return { found: false };
        },
        args: [query]
      });

      const res = results[0]?.result;
      if (res && res.found) {
        showToast(`Clicked "${res.text.slice(0, 20)}"`);
        commandInput.value = "";
      } else {
        showToast(`Could not find "${query}"`);
      }
    } catch (err) {
      showToast("Error: " + err.message);
    } finally {
      if (submitBtn) submitBtn.textContent = "➔";
    }
  }

  submitBtn?.addEventListener("click", handleCommand);
  commandInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCommand();
  });

  const chipNewTab = document.getElementById("chipNewTab");
  chipNewTab?.addEventListener("click", async () => {
    try {
      showToast("Opening new tab with your account...");
      const res = await fetch("http://127.0.0.1:8765/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "new_tab", params: { url: "https://google.com" } })
      });
      const data = await res.json();
      if (data.success) {
        showToast("📑 New task tab active!");
        await loadActiveTab();
      }
    } catch {
      showToast("Bridge unreachable");
    }
  });

  // 5. Snapshot Chip
  chipSnapshot?.addEventListener("click", async () => {
    if (!currentTab) return;
    chipSnapshot.textContent = "📸 Capturing...";

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(currentTab.windowId, { format: "png" });
      if (canvasText) canvasText.style.display = "none";
      if (canvasImg) {
        canvasImg.src = dataUrl;
        canvasImg.style.display = "block";
      }
      if (downloadCanvasBtn) downloadCanvasBtn.style.display = "inline-flex";
      if (canvasCard) canvasCard.style.display = "block";

      const res = await fetch(dataUrl);
      activeImageBlob = await res.blob();
      activeTextContent = null;
      showToast("Snapshot captured!");
    } catch (err) {
      showToast("Capture failed");
    } finally {
      chipSnapshot.textContent = "📸 Snapshot";
    }
  });

  // 6. Read Page Chip
  chipRead?.addEventListener("click", async () => {
    if (!currentTab) return;
    chipRead.textContent = "📄 Reading...";

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => {
          const main = document.querySelector("article, main, #content, .content") || document.body;
          const headings = Array.from(main.querySelectorAll("h1, h2, h3")).map(h => h.innerText.trim()).filter(Boolean);
          const paras = Array.from(main.querySelectorAll("p")).map(p => p.innerText.trim()).filter(t => t.length > 25);
          return {
            title: headings[0] || document.title,
            content: paras.slice(0, 5).join("\n\n")
          };
        }
      });

      const data = results[0]?.result;
      if (data && data.content) {
        if (canvasImg) canvasImg.style.display = "none";
        if (downloadCanvasBtn) downloadCanvasBtn.style.display = "none";
        if (canvasText) {
          canvasText.innerHTML = `<strong style="color:#ffffff;">${data.title}</strong><br><br>${data.content.replace(/\n\n/g, '<br><br>')}`;
          canvasText.style.display = "block";
        }
        if (canvasCard) canvasCard.style.display = "block";

        activeTextContent = `${data.title}\n\n${data.content}`;
        activeImageBlob = null;
        showToast("Read page text");
      } else {
        showToast("No readable text found");
      }
    } catch {
      showToast("Cannot read this page");
    } finally {
      chipRead.textContent = "📄 Read";
    }
  });

  // 7. Scroll Chip
  chipScroll?.addEventListener("click", async () => {
    if (!currentTab) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => window.scrollBy({ top: 600, behavior: "smooth" })
      });
      showToast("Scrolled");
    } catch {}
  });

  // 8. Canvas Actions
  copyCanvasBtn?.addEventListener("click", async () => {
    if (activeImageBlob) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": activeImageBlob })]);
        showToast("Copied screenshot to clipboard!");
      } catch {
        showToast("Clipboard copy not supported");
      }
    } else if (activeTextContent) {
      await navigator.clipboard.writeText(activeTextContent);
      showToast("Copied text to clipboard!");
    }
  });

  downloadCanvasBtn?.addEventListener("click", () => {
    if (!canvasImg || !canvasImg.src) return;
    const a = document.createElement("a");
    a.href = canvasImg.src;
    a.download = `snapshot-${Date.now()}.png`;
    a.click();
    showToast("Downloaded!");
  });

  closeCanvasBtn?.addEventListener("click", () => {
    if (canvasCard) canvasCard.style.display = "none";
  });

  // 9. Side Panel Toggle
  sidepanelBtn?.addEventListener("click", async () => {
    if (chrome.sidePanel && chrome.sidePanel.open && currentTab) {
      try {
        await chrome.sidePanel.open({ windowId: currentTab.windowId });
        window.close();
      } catch {
        showToast("Side panel not supported");
      }
    }
  });

  // 10. Launch Isolated Sandbox Window
  const sandboxBtn = document.getElementById("sandboxBtn");
  if (sandboxBtn) {
    sandboxBtn.addEventListener("click", async () => {
      showToast("Launching sandbox...");
      try {
        const res = await fetch("http://127.0.0.1:8765/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sandbox_window", params: { focus: false } })
        });
        const data = await res.json();
        if (data.success) {
          showToast("🪟 Dedicated sandbox active!");
          setTimeout(() => window.close(), 600);
        } else {
          showToast("Failed to launch sandbox");
        }
      } catch {
        showToast("Bridge server unreachable");
      }
    });
  }

  // 11. Highlight Detected Elements
  const chipHighlight = document.getElementById("chipHighlight");
  if (chipHighlight) {
    chipHighlight.addEventListener("click", async () => {
      if (!currentTab) return;
      try {
        const res = await fetch("http://127.0.0.1:8765/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "highlight_elements", params: { tabId: currentTab.id } })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`✨ Highlighted ${data.result.count} elements!`);
        } else {
          showToast("Could not highlight elements");
        }
      } catch {
        showToast("Highlight failed");
      }
    });
  }

  // Init
  await checkStatus();
  await loadActiveTab();
});
