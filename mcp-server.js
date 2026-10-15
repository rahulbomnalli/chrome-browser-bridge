#!/usr/bin/env node
// Model Context Protocol (MCP) Server for Antigravity Chrome Agent Bridge
const readline = require("readline");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:8765";

// High-speed persistent HTTP Agent with keep-alive to eliminate connection handshake overhead
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 30000,
});

async function postAction(action, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ action, params });
    const dynamicTimeout = (params.timeoutSec ? (params.timeoutSec * 1000 + 10000) : (params.timeoutMs || 25000));
    const req = http.request(
      `${BRIDGE_URL}/action`,
      {
        method: "POST",
        agent: keepAliveAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "Connection": "keep-alive"
        },
        timeout: dynamicTimeout,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.success) {
              resolve(parsed.result);
            } else {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${body}`));
            }
          } catch (err) {
            reject(new Error(`Failed to parse response: ${body}`));
          }
        });
      }
    );

    req.on("socket", (sock) => {
      sock.setNoDelay(true);
    });

    req.on("error", (err) => {
      reject(new Error(`Bridge connection failed: ${err.message}`));
    });

    req.write(data);
    req.end();
  });
}

async function getStatus() {
  return new Promise((resolve, reject) => {
    http.get(`${BRIDGE_URL}/status`, { agent: keepAliveAgent }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

const TOOLS = [
  {
    name: "whatsapp_send_message",
    description: "Composite high-speed tool to send a WhatsApp message in 1 single tool call. Automatically locates the existing WhatsApp tab, detects App Lock if active, searches for the recipient, validates the contact match, enters the message, sends it, and verifies delivery. Zero AI token loops. Supports dryRun: true for testing/benchmarking without actually sending.",
    inputSchema: {
      type: "object",
      properties: {
        contact: { type: "string", description: "Name or phone number of recipient to search and send to" },
        message: { type: "string", description: "Message text to send" },
        dryRun: { type: "boolean", description: "If true, prepares message and validates recipient without sending (safe test mode)" },
        tabId: { type: "number", description: "Optional specific tab ID of WhatsApp" }
      },
      required: ["contact", "message"]
    }
  },
  {
    name: "chrome_whatsapp_send",
    description: "Alias for whatsapp_send_message. Consolidates locating tab, recipient validation, typing, and sending into 1 tool call.",
    inputSchema: {
      type: "object",
      properties: {
        contact: { type: "string", description: "Name or phone number of recipient" },
        message: { type: "string", description: "Message text" },
        dryRun: { type: "boolean", description: "If true, validates recipient and prepares message without sending" },
        tabId: { type: "number", description: "Optional specific tab ID" }
      },
      required: ["contact", "message"]
    }
  },
  {
    name: "chrome_smart_navigate",
    description: "High-speed intelligent navigation: Reuses an existing open tab if the target website/domain is already open in Chrome (eliminating window creation and preserving logins/SPA state), or navigates the active tab without launching duplicate windows.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Destination URL to navigate or switch to" },
        reuseExisting: { type: "boolean", description: "Whether to reuse an existing matching open tab (default true)" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["url"]
    }
  },
  {
    name: "chrome_extract_data",
    description: "High-speed targeted extraction of text, values, or attributes matching a CSS selector without full-page token dump overhead.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of elements to extract" },
        attribute: { type: "string", description: "Attribute to extract: 'text' (default), 'html', 'value', 'href', 'src', etc." },
        multiple: { type: "boolean", description: "Whether to return all matches as an array (default true)" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["selector"]
    }
  },
  {
    name: "chrome_status",
    description: "Check if Chrome browser is connected to the Antigravity Bridge.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_list_tabs",
    description: "List all open tabs in Google Chrome (IDs, titles, and URLs).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_switch_tab",
    description: "Switch active tab in Chrome.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab ID to activate" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "chrome_new_tab",
    description: "Open a fresh tab in Chrome using the same user profile (preserves all logins, accounts, and cookies) and returns interactive page elements immediately.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open (default: about:blank)" },
        active: { type: "boolean", description: "Whether to make it the active visible tab (default: true)" }
      }
    }
  },
  {
    name: "chrome_navigate",
    description: "Navigate to a URL. By default, launches the task in a dedicated separate Chrome window (shares all logged-in accounts, cookies, and profile sessions) without interfering with the user's personal window, and immediately returns interactive elements (@1, @2) in 1 fast round-trip.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Destination URL" },
        tabId: { type: "number", description: "Optional specific tab ID to navigate" },
        forceNewWindow: { type: "boolean", description: "Whether to force opening a fresh new window (default: false)" }
      },
      required: ["url"]
    }
  },
  {
    name: "chrome_snapshot",
    description: "Inspect the current page in Chrome: returns page title, URL, visible text summary, and an indexed list of all interactive elements (buttons, inputs, links, forms) with clean selectors.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_click",
    description: "Click an element by @index (e.g. '@1'), CSS selector, or button text. Automatically returns the updated page elements (@1, @2) so you don't need to call snapshot separately.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element reference: '@1', '#id', '.class', or button text" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["target"]
    }
  },
  {
    name: "chrome_type",
    description: "Type text into an input field or textarea. Use pressEnter: true to submit/search immediately and get updated page elements in 1 round-trip.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Input selector or element reference like '@1' or '#query'" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Whether to press Enter after typing (auto-returns next page elements)" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["selector", "text"]
    }
  },
  {
    name: "chrome_evaluate",
    description: "Run custom JavaScript code in the browser tab and return the serialized result.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code or expression" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["code"]
    }
  },
  {
    name: "chrome_screenshot",
    description: "Take a screenshot of the visible Chrome tab and save it to disk.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path where image should be saved" },
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_network_logs",
    description: "Inspect network activity, HTTP/HTTPS API requests, responses, status codes, and network errors in Chrome DevTools.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional filter string for URL or method" },
        limit: { type: "number", description: "Maximum number of recent network entries to return (default 40)" },
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_console_logs",
    description: "Inspect browser console messages, errors, warnings, and uncaught exceptions with stack traces.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", description: "Optional log level filter ('error', 'warn', 'info', 'log')" },
        limit: { type: "number", description: "Maximum number of recent logs to return (default 40)" },
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_batch_form",
    description: "Instantly fill multiple input fields and optionally click the submit button in a single fast action.",
    inputSchema: {
      type: "object",
      properties: {
        fields: { type: "object", description: "Key-value mapping of CSS selector to input text" },
        submitSelector: { type: "string", description: "Optional CSS selector of submit button" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["fields"]
    }
  },
  {
    name: "chrome_snap",
    description: "Ultra-compact, token-efficient semantic map of the active tab. Consumes 90% fewer AI tokens. Elements are labeled @1, @2, @3 for instant referencing in click and type.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_pipeline",
    description: "Execute a multi-step automation macro (e.g. click, type, wait, snap) in a single fast round-trip without intermediate AI token waste.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "List of step objects: [{ action: 'click', params: { target: '@1' } }, { action: 'type', params: { text: 'hello', pressEnter: true } }]"
        },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["steps"]
    }
  },
  {
    name: "chrome_batch_fill",
    description: "Smart form filler: fill multiple fields at once by label text, placeholder, name, or id — no CSS selectors needed. Optionally auto-submit. Example: { fields: { 'Username': 'admin', 'Password': 'secret' }, submit: 'Sign In' }",
    inputSchema: {
      type: "object",
      properties: {
        fields: { type: "object", description: "Key-value pairs where key is the field label/name/placeholder and value is the text to fill" },
        submit: { description: "Optional: true for auto-detect submit, or a string like 'Sign In' to click a specific button" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["fields"]
    }
  },
  {
    name: "chrome_sandbox_window",
    description: "Launch a dedicated, isolated Chrome window for the AI agent to work in without interfering with the user's personal browsing. Returns the window and tab IDs.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open in the sandbox window (default: about:blank)" },
        width: { type: "number", description: "Window width in pixels (default: 1280)" },
        height: { type: "number", description: "Window height in pixels (default: 900)" }
      }
    }
  },
  {
    name: "chrome_read_page",
    description: "Extract clean, readable text content from the active page — headings and paragraphs. Useful for reading articles, docs, and web content.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_visual_grounding",
    description: "Visual Grounding Pass: Overlays high-contrast numbered bounding tags [1], [2], [3] onto all clickable and canvas elements, captures a clean snapshot, and returns coordinates. Enables clicking any custom UI, canvas, chart, or video without relying on standard HTML IDs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional tab ID" },
        savePath: { type: "string", description: "Optional file path to save tagged screenshot PNG" }
      }
    }
  },
  {
    name: "chrome_parallel_scrape",
    description: "Autonomous Multi-Tab Scraper: Opens multiple URLs in parallel background worker tabs, extracts page content/headings simultaneously in < 2 seconds, and closes the tabs.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Array of URLs to scrape in parallel" },
        keepOpen: { type: "boolean", description: "Whether to keep worker tabs open (default false)" }
      },
      required: ["urls"]
    }
  },
  {
    name: "chrome_detect_challenge",
    description: "Smart Human-in-the-Loop Hand-off: Checks if page has a Cloudflare Turnstile, hCaptcha, Google reCAPTCHA, or 2FA verification challenge. If found, displays a smooth alert banner and focuses the tab for the user to solve.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_save_macro",
    description: "Save a sequence of browser actions as a reusable named macro to execute later in < 500ms with zero LLM tokens.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique name for the macro (e.g. 'search_and_filter')" },
        description: { type: "string", description: "What this macro does" },
        steps: { type: "array", description: "List of action step objects to execute" }
      },
      required: ["name", "steps"]
    }
  },
  {
    name: "chrome_run_macro",
    description: "Execute a previously saved macro at hardware speed (< 500ms) with zero AI reasoning tokens. Supports dynamic variable replacement (e.g. {{query}}).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the macro to run" },
        variables: { type: "object", description: "Key-value mapping to replace {{variable}} in macro parameters" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["name"]
    }
  },
  {
    name: "chrome_list_macros",
    description: "List all stored workflow macros available for instant replay.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "chrome_wait_for_user",
    description: "Pause and wait for the user to complete a sensitive action (e.g., enter password to unlock app, solve 2FA/PIN, approve permission). Plays an audible chime alert in Chrome, displays a guidance banner, and auto-resumes the instant the user unlocks or enters credentials.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Clear explanation shown to user (e.g. 'Please enter your password to unlock the app')" },
        timeoutSec: { type: "number", description: "Maximum seconds to wait before continuing (default 60)" },
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_page_fetch",
    description: "Execute authenticated HTTP requests directly from inside the active page session (inherits cookies, origin, and credentials). Ultra-fast (sub-50ms) and zero UI scraping tokens.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL (relative or absolute)" },
        method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE, etc.)" },
        headers: { type: "object", description: "Optional request headers" },
        body: { type: "string", description: "Optional body string or JSON" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["url"]
    }
  },
  {
    name: "chrome_scroll",
    description: "Scroll the page smoothly up or down by pixels without full-page reloads.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", description: "'up' or 'down' (default 'down')" },
        amount: { type: "number", description: "Number of pixels to scroll (default 400)" },
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_select",
    description: "Select an option from a <select> dropdown by option value or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the <select> element" },
        value: { type: "string", description: "Option value or visible text to select" },
        tabId: { type: "number", description: "Optional tab ID" }
      },
      required: ["selector", "value"]
    }
  },
  {
    name: "chrome_set_memory",
    description: "Persist solutions, selectors, credentials, or task recovery notes into Chrome persistent storage so problems and patterns are remembered permanently across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unique identifier/domain/task key for the memory" },
        value: { description: "Memory value (string, object, or array) describing the fix, selector, or pattern" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "chrome_get_memory",
    description: "Recall persisted task memory, past failure fixes, domain selectors, or session patterns to avoid repeating past errors.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Optional specific key to retrieve. If omitted, returns all stored memories." }
      }
    }
  },
  {
    name: "chrome_clear_memory",
    description: "Clear a specific memory key or wipe all stored agent task memory.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Optional key to delete. If omitted, clears all memory." }
      }
    }
  },
  {
    name: "chrome_dismiss_overlays",
    description: "Automatically find and dismiss screen overlays, cookie consent popups, modal backdrops, dialogs, and banners without failing page interaction.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_wait_for_element",
    description: "Pause until a specific element or text appears in the DOM (with dynamic polling, no fixed sleep timers). Returns immediately upon appearance.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of element to wait for" },
        text: { type: "string", description: "Visible text snippet to wait for" },
        timeoutMs: { type: "number", description: "Maximum wait time in milliseconds (default 10000)" },
        tabId: { type: "number", description: "Optional tab ID" }
      }
    }
  },
  {
    name: "chrome_download_file",
    description: "Trigger a file download directly in Chrome from a URL, blob, or base64 data URI to disk.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Download URL or base64 data URI" },
        filename: { type: "string", description: "Optional suggested destination filename" }
      },
      required: ["url"]
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case "whatsapp_send_message":
    case "chrome_whatsapp_send": {
      const t0 = performance.now();
      const res = await postAction("whatsapp_send", {
        contact: args.contact,
        message: args.message,
        dryRun: !!args.dryRun,
        tabId: args.tabId
      });
      const totalMs = Math.round(performance.now() - t0);
      if (res.isLocked) {
        return `⚠️ WhatsApp Web is locked with App Lock.\nAction Required: Please unlock WhatsApp Web in your browser or call chrome_wait_for_user("Please enter WhatsApp App Lock password").`;
      }
      if (!res.success) {
        return `❌ WhatsApp Send Failed: ${res.error || 'Unknown error'}\n[Execution Time: ${totalMs}ms]`;
      }
      if (res.dryRun) {
        return `✓ WhatsApp DRY RUN Successful:\n- Recipient validated: "${res.contact}"\n- Message prepared: "${res.message}"\n- Status: Not sent (dryRun enabled)\n[Timing: Browser=${res.durationMs}ms, Total=${totalMs}ms]`;
      }
      return `✓ WhatsApp Message Sent Successfully:\n- Recipient: "${res.contact}"\n- Message: "${res.message}"\n- Input cleared: ${res.inputCleared ? 'Yes (sent)' : 'Sent'}\n[Timing: Browser=${res.durationMs}ms, Total=${totalMs}ms]`;
    }
    case "chrome_smart_navigate": {
      const t0 = performance.now();
      const res = await postAction("smart_navigate", {
        url: args.url,
        reuseExisting: args.reuseExisting !== false,
        tabId: args.tabId,
        returnSnap: true
      });
      const totalMs = Math.round(performance.now() - t0);
      let out = `${res.reused ? '✓ Reused existing open tab' : '✓ Navigated to'}: [${res.title || 'Page'}] (${res.url}) in ${totalMs}ms.`;
      if (res.snapshot) {
        out += `\n\nInteractive Elements:\n${res.snapshot}`;
      }
      return out;
    }
    case "chrome_extract_data": {
      const t0 = performance.now();
      const res = await postAction("extract_data", {
        selector: args.selector,
        attribute: args.attribute || 'text',
        multiple: args.multiple !== false,
        tabId: args.tabId
      });
      const totalMs = Math.round(performance.now() - t0);
      return JSON.stringify({ ...res, executionTimeMs: totalMs });
    }
    case "chrome_status": {
      const status = await getStatus();
      return JSON.stringify(status);
    }
    case "chrome_list_tabs": {
      const tabs = await postAction("tabs");
      return JSON.stringify(tabs);
    }
    case "chrome_switch_tab": {
      const res = await postAction("switch_tab", { tabId: args.tabId });
      return `Switched to tab: ${res.title} (${res.url})`;
    }
    case "chrome_new_tab": {
      const res = await postAction("new_tab", { url: args.url || "about:blank", active: args.active !== false, returnSnap: true });
      let out = `Opened new tab (ID: ${res.id}): [${res.title || 'New Tab'}] (${res.url})`;
      if (res.snapshot) {
        out += `\n\nInteractive Elements:\n${res.snapshot}`;
      }
      return out;
    }
    case "chrome_navigate": {
      const res = await postAction("navigate", {
        url: args.url,
        tabId: args.tabId,
        forceNewWindow: args.forceNewWindow !== false,
        returnSnap: true
      });
      let out = `Navigated to: [${res.title || 'Page'}] (${res.url}) in ${res.isNewWindow ? 'dedicated new window' : 'agent window'}.`;
      if (res.snapshot) {
        out += `\n\nInteractive Elements:\n${res.snapshot}`;
      }
      return out;
    }
    case "chrome_snap": {
      const snap = await postAction("snap", { tabId: args.tabId });
      return snap.compact;
    }
    case "chrome_pipeline": {
      const res = await postAction("pipeline", { steps: args.steps, tabId: args.tabId, returnSnap: true });
      let out = `✓ Executed pipeline: ${res.count || args.steps?.length || 0} steps in 1 roundtrip.`;
      if (res.snapshot) {
        out += `\n\nFinal Page State:\n${res.snapshot}`;
      }
      return out;
    }
    case "chrome_snapshot": {
      const snapshot = await postAction("snapshot", { tabId: args.tabId });
      return JSON.stringify(snapshot);
    }
    case "chrome_click": {
      let params = { tabId: args.tabId, returnSnap: args.returnSnap !== false };
      const target = String(args.target || '');
      if (target.startsWith("@") && !isNaN(Number(target.slice(1)))) {
        params.target = target;
        params.index = Number(target.slice(1));
      } else if (target.startsWith("#") && !isNaN(Number(target.slice(1)))) {
        params.index = Number(target.slice(1));
      } else if (target.startsWith(".") || target.startsWith("#") || target.includes("[") || target.includes(">")) {
        params.selector = target;
      } else {
        params.text = target;
      }
      const res = await postAction("click", params);
      let out = `✓ Clicked "${target}" (${res.clicked || 'ok'})`;
      if (res.snapshot) {
        out += `\n\nUpdated Page State:\n${res.snapshot}`;
      }
      return out;
    }
    case "chrome_type": {
      const res = await postAction("type", {
        selector: args.selector,
        target: args.selector,
        text: args.text,
        pressEnter: !!args.pressEnter,
        tabId: args.tabId,
        returnSnap: args.pressEnter ? true : (args.returnSnap ?? false)
      });
      let out = `✓ Typed "${args.text.slice(0, 30)}" into ${args.selector}${args.pressEnter ? " [Pressed Enter]" : ""}`;
      if (res.snapshot) {
        out += `\n\nUpdated Page State:\n${res.snapshot}`;
      }
      return out;
    }
    case "chrome_evaluate": {
      const res = await postAction("eval", { code: args.code, tabId: args.tabId });
      return JSON.stringify(res.result !== undefined ? res.result : res);
    }
    case "chrome_screenshot": {
      const outPath = args.filePath || path.join(process.cwd(), `screenshot-${Date.now()}.png`);
      const res = await postAction("screenshot", { tabId: args.tabId });
      const base64Data = res.dataUrl.replace(/^data:image\/png;base64,/, "");
      fs.writeFileSync(outPath, Buffer.from(base64Data, "base64"));
      return `Screenshot saved: ${outPath}`;
    }
    case "chrome_network_logs": {
      const res = await postAction("network", { filter: args.filter, limit: args.limit || 40, tabId: args.tabId });
      return JSON.stringify(res);
    }
    case "chrome_console_logs": {
      const res = await postAction("console", { level: args.level, limit: args.limit || 40, tabId: args.tabId });
      return JSON.stringify(res);
    }
    case "chrome_batch_form": {
      const res = await postAction("batch_form", { fields: args.fields, submitSelector: args.submitSelector, tabId: args.tabId });
      return `✓ Batch form: ${res.filledCount || 0} fields filled`;
    }
    case "chrome_batch_fill": {
      const res = await postAction("batch_fill", { fields: args.fields, submit: args.submit, tabId: args.tabId });
      return `✓ Filled ${res.filled?.length || 0} fields (${res.filled?.includes('__submitted') ? 'submitted' : 'ok'})`;
    }
    case "chrome_sandbox_window": {
      const res = await postAction("sandbox_window", { url: args.url, width: args.width, height: args.height });
      return `Sandbox window launched: windowId=${res.windowId}, tabId=${res.tabId}, url=${res.url}`;
    }
    case "chrome_read_page": {
      const res = await postAction("read_page", { tabId: args.tabId });
      let out = `# ${res.title}\n\n`;
      if (res.headings) out += res.headings.map(h => `## ${h}`).join('\n') + '\n\n';
      out += res.content || 'No readable content found.';
      return out;
    }
    case "chrome_cdp_command": {
      const res = await postAction("cdp", { method: args.method, params: args.params || {}, tabId: args.tabId });
      return JSON.stringify(res);
    }
    case "chrome_visual_grounding": {
      const res = await postAction("visual_grounding", { tabId: args.tabId });
      if (args.savePath && res.screenshotDataUrl) {
        const base64Data = res.screenshotDataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(args.savePath, Buffer.from(base64Data, "base64"));
      }
      let summary = `✓ Visually Grounded ${res.count} Elements with [1], [2], [3] Tags:\n`;
      res.elements.slice(0, 30).forEach(e => {
        summary += `[${e.id}] <${e.tag}> "${e.text || ''}" at (x: ${e.x}, y: ${e.y})\n`;
      });
      return summary;
    }
    case "chrome_parallel_scrape": {
      const res = await postAction("parallel_scrape", { urls: args.urls, keepOpen: args.keepOpen });
      return JSON.stringify(res);
    }
    case "chrome_detect_challenge": {
      const res = await postAction("detect_challenge", { tabId: args.tabId });
      if (res.challengeDetected) {
        return `⚠️ SECURITY CHALLENGE DETECTED: [${res.type}]. Alerted human user. Waiting on user solve.`;
      }
      return `✓ No security challenges or CAPTCHAs detected on page.`;
    }
    case "chrome_save_macro": {
      const res = await postAction("save_macro", { name: args.name, description: args.description, steps: args.steps });
      return `✓ Saved macro "${res.name}" with ${res.stepsCount} steps.`;
    }
    case "chrome_run_macro": {
      const res = await postAction("run_macro", { name: args.name, variables: args.variables, tabId: args.tabId });
      return `✓ Executed macro "${res.macro}" at hardware speed!`;
    }
    case "chrome_list_macros": {
      const res = await postAction("list_macros");
      return JSON.stringify(res);
    }
    case "chrome_wait_for_user": {
      const res = await postAction("wait_for_user", {
        reason: args.reason,
        timeoutSec: args.timeoutSec,
        tabId: args.tabId
      });
      return JSON.stringify(res);
    }
    case "chrome_page_fetch": {
      const res = await postAction("page_fetch", {
        url: args.url,
        method: args.method || "GET",
        headers: args.headers || {},
        body: args.body,
        tabId: args.tabId
      });
      return JSON.stringify(res);
    }
    case "chrome_scroll": {
      const res = await postAction("scroll", {
        direction: args.direction || "down",
        amount: args.amount || 400,
        tabId: args.tabId
      });
      return JSON.stringify(res);
    }
    case "chrome_select": {
      const res = await postAction("select", {
        selector: args.selector,
        value: args.value,
        tabId: args.tabId
      });
      return JSON.stringify(res);
    }
    case "chrome_set_memory": {
      const res = await postAction("set_memory", {
        key: args.key,
        value: args.value
      });
      return JSON.stringify(res);
    }
    case "chrome_get_memory": {
      const res = await postAction("get_memory", {
        key: args.key
      });
      return JSON.stringify(res);
    }
    case "chrome_clear_memory": {
      const res = await postAction("clear_memory", {
        key: args.key
      });
      return JSON.stringify(res);
    }
    case "chrome_dismiss_overlays": {
      const res = await postAction("dismiss_overlays", {
        tabId: args.tabId
      });
      return JSON.stringify(res);
    }
    case "chrome_wait_for_element": {
      const res = await postAction("wait_for_element", {
        selector: args.selector,
        text: args.text,
        timeoutMs: args.timeoutMs,
        tabId: args.tabId
      });
      return JSON.stringify(res);
    }
    case "chrome_download_file": {
      const res = await postAction("download_file", {
        url: args.url,
        filename: args.filename
      });
      return JSON.stringify(res);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC stdio handler
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    console.error("Invalid JSON:", line);
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    sendJson({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "chrome-browser-bridge", version: "1.0.0" }
      }
    });
    return;
  }

  if (method === "notifications/initialized") {
    // No-op
    return;
  }

  if (method === "tools/list") {
    sendJson({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (method === "tools/call") {
    try {
      const textResult = await handleToolCall(params.name, params.arguments || {});
      sendJson({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: String(textResult) }]
        }
      });
    } catch (err) {
      sendJson({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Error: ${err.message}` }]
        }
      });
    }
    return;
  }

  if (id !== undefined) {
    sendJson({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
});
