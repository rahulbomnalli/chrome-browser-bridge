#!/usr/bin/env node
// Antigravity Chrome Agent Bridge CLI
const fs = require("fs");
const path = require("path");

const { createTransport } = require('./lib/transport');
const transport = createTransport();
const { postAction, getStatus } = transport;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  try {
    switch (command) {
      case "config": {
        console.log(require('./lib/client-config').clientConfig(args[1]));
        break;
      }
      case "doctor": {
        const status = await getStatus();
        console.log(JSON.stringify({ node: process.version, bridge: status, ready: !!status.connected,
          next: status.connected ? "Ready for browser actions" : "Load extension/ at chrome://extensions and check the bridge URL" }, null, 2));
        if (!status.connected) process.exitCode = 1;
        break;
      }
      case 'profile': {
        const response = await fetch(new URL('/metrics', process.env.BRIDGE_URL || 'http://127.0.0.1:8765'), { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Metrics unavailable; restart the bridge server with the updated build');
        const metrics = await response.json();
        const groups = new Map();
        for (const action of metrics.actions) {
          const item = groups.get(action.action) || { action: action.action, calls: 0, totalMs: 0, failures: 0 };
          item.calls++; item.totalMs += action.roundTripMs; if (!action.ok) item.failures++;
          groups.set(action.action, item);
        }
        console.log(JSON.stringify({ scope: metrics.scope, totalCalls: metrics.actions.length,
          byAction: [...groups.values()].map(item => ({ ...item, totalMs: +item.totalMs.toFixed(2) })), recent: metrics.actions.slice(-12) }, null, 2));
        break;
      }
      case "workflow":
      case "act": {
        if (!args[1]) throw new Error(`Usage: bridge ${command} <JSON or @file.json>`);
        const raw = args[1].startsWith('@') ? fs.readFileSync(args[1].slice(1), 'utf8') : args.slice(1).join(' ');
        const input = JSON.parse(raw);
        const result = await postAction(command, Array.isArray(input) && command === 'act' ? { steps: input } : input);
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "action": {
        if (!args[1]) throw new Error('Usage: bridge action <action> [JSON params]');
        const result = await postAction(args[1], JSON.parse(args.slice(2).join(' ') || '{}'));
        console.log(JSON.stringify(result));
        if (result?.ok === false || result?.success === false) process.exitCode = 1;
        break;
      }
      case "status": {
        try {
          const status = await getStatus();
          console.log(JSON.stringify(status, null, 2));
        } catch (err) {
          console.error("❌ Bridge Server is not responding:", err.message);
          process.exit(1);
        }
        break;
      }

      case "tabs": {
        const tabs = await postAction("tabs");
        console.log("=== Open Chrome Tabs ===");
        tabs.forEach((t) => {
          console.log(`[${t.id}] ${t.active ? "* " : "  "}${t.title} (${t.url})`);
        });
        break;
      }

      case "switch": {
        const tabId = args[1];
        if (!tabId) throw new Error("Usage: chrome-bridge switch <tabId>");
        const res = await postAction("switch_tab", { tabId: Number(tabId) });
        console.log(`Switched to tab: ${res.title} (${res.url})`);
        break;
      }

      case "new": {
        const url = args[1] || "about:blank";
        const res = await postAction("new_tab", { url });
        console.log(`Opened new tab [${res.id}] -> ${res.url}`);
        break;
      }

      case "close": {
        const tabId = args[1] ? Number(args[1]) : undefined;
        const res = await postAction("close_tab", { tabId });
        console.log(`Closed tab [${res.closedTabId}]`);
        break;
      }

      case "navigate": {
        const url = args[1];
        if (!url) throw new Error("Usage: chrome-bridge navigate <url>");
        console.log(`Navigating to ${url}...`);
        const res = await postAction("navigate", { url });
        console.log(`Navigated to: ${res.title} (${res.url})`);
        break;
      }

      case "reload": {
        await postAction("reload");
        console.log("Reloaded current tab.");
        break;
      }

      case "snap": {
        const tabId = args[1] ? Number(args[1]) : undefined;
        const res = await postAction("snap", { tabId });
        console.log(res.compact);
        break;
      }

      case "pipeline": {
        let steps;
        try {
          steps = JSON.parse(args.slice(1).join(" "));
        } catch (_) {
          throw new Error('Usage: bridge pipeline \'[{"action":"click","params":{"target":"@1"}},...]\'');
        }
        const res = await postAction("pipeline", { steps });
        console.log(`Executed ${res.count} pipeline steps:`, JSON.stringify(res.results, null, 2));
        if (!res.ok) process.exitCode = 1;
        break;
      }

      case "snapshot": {
        const tabId = args[1] ? Number(args[1]) : undefined;
        const snapshot = await postAction("snapshot", { tabId });
        console.log(`=== Page: ${snapshot.title} ===`);
        console.log(`URL: ${snapshot.url}`);

        console.log(`\nInteractive Elements (${snapshot.interactiveElementsCount}):`);
        (snapshot.interactiveElements || []).forEach((el) => {
          const info = [
            `#${el.index}`,
            `<${el.tag}>`,
            el.type ? `type="${el.type}"` : "",
            el.text ? `text="${el.text}"` : "",
            el.placeholder ? `placeholder="${el.placeholder}"` : "",
            el.id ? `id="${el.id}"` : "",
            `selector: ${el.selector}`
          ].filter(Boolean).join(" ");
          console.log(`  ${info}`);
        });
        console.log(`\nText Summary Preview:\n${(snapshot.bodySummary || "").slice(0, 500)}...`);
        break;
      }

      case "click": {
        const rawTarget = args.slice(1).join(" ").trim();
        if (!rawTarget) throw new Error("Usage: bridge click <@index | selector | text>");
        // Auto prefix bare numbers like "1" to "@1" for ease of use in shell
        const target = (/^\d+$/.test(rawTarget)) ? `@${rawTarget}` : rawTarget;
        const res = await postAction("click", { target });
        console.log(`Clicked element:`, res.clicked);
        break;
      }

      case "type": {
        const target = args[1];
        const text = args[2];
        const pressEnter = args.includes("--enter");
        if (!target || text === undefined) {
          throw new Error("Usage: bridge type <@index | selector> <text> [--enter]");
        }
        const resolvedTarget = (/^\d+$/.test(target)) ? `@${target}` : target;
        const res = await postAction("type", { target: resolvedTarget, text, pressEnter });
        console.log(`Typed into ${resolvedTarget}: "${res.typed}"`);
        break;
      }

      case "select": {
        const selector = args[1];
        const val = args[2];
        if (!selector || !val) throw new Error("Usage: chrome-bridge select <selector> <value>");
        const res = await postAction("select", { selector, value: val });
        console.log(`Selected in ${selector}: ${res.selectedValue} (${res.selectedText})`);
        break;
      }

      case "scroll": {
        const dir = args[1] === "up" ? "up" : "down";
        const amt = args[2] ? Number(args[2]) : 400;
        const res = await postAction("scroll", { direction: dir, amount: amt });
        console.log(`Scrolled ${dir} to Y=${res.scrollY}`);
        break;
      }

      case "eval": {
        const code = args.slice(1).join(" ");
        if (!code) throw new Error("Usage: chrome-bridge eval <javascript-expression>");
        const res = await postAction("eval", { code });
        if (res.success) {
          console.log(JSON.stringify(res.result, null, 2));
        } else {
          console.error(`Eval Error: ${res.error}`);
          process.exit(1);
        }
        break;
      }

      case "snap": {
        const tabId = args[1] ? Number(args[1]) : undefined;
        const res = await postAction("snap", { tabId });
        console.log(res.compact);
        break;
      }

      case "read": {
        const tabId = args[1] ? Number(args[1]) : undefined;
        const res = await postAction("read_page", { tabId });
        console.log(`\n# ${res.title}\n`);
        if (res.headings && res.headings.length) {
          res.headings.forEach(h => console.log(`## ${h}`));
          console.log("");
        }
        console.log(res.content || "No readable content found.");
        break;
      }

      case "sandbox": {
        const url = args[1] || "about:blank";
        const res = await postAction("sandbox_window", { url });
        console.log(`Sandbox window launched: Window ID=${res.windowId}, Tab ID=${res.tabId}, URL=${res.url}`);
        break;
      }

      case "batch-fill": {
        let fields = {};
        try {
          fields = JSON.parse(args[1]);
        } catch (_) {
          throw new Error('Usage: chrome-bridge batch-fill \'{"Username": "admin", "Password": "123"}\' [submitText]');
        }
        const submit = args[2];
        const res = await postAction("batch_fill", { fields, submit });
        console.log("Batch fill result:", JSON.stringify(res, null, 2));
        break;
      }

      case "screenshot": {
        const outPath = args[1] || path.join(process.cwd(), `screenshot-${Date.now()}.png`);
        console.log("Capturing visible tab screenshot...");
        const res = await postAction("screenshot");
        if (!res.dataUrl) throw new Error("No image data returned");
        const base64Data = res.dataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(outPath, Buffer.from(base64Data, "base64"));
        console.log(`Saved screenshot to: ${outPath}`);
        break;
      }

      case "notify":
      case "beep": {
        const msg = args.slice(1).join(" ") || "Your input or authentication code is required";
        const res = await postAction("notify", { message: msg, title: "Input Required" });
        console.log(`🔔 Chime + Flash triggered in browser: "${msg}"`);
        break;
      }

      case "network": {
        const filter = args[1];
        const res = await postAction("network", { filter, limit: 40 });
        console.log(`=== Chrome Network Activity (Total captured: ${res.totalCaptured}) ===`);
        (res.returned || []).forEach(r => {
          const status = r.status === "pending" ? "[...]" : `[${r.status}]`;
          const method = (r.method || "GET").padEnd(6);
          console.log(`${status} ${method} ${r.url.slice(0, 100)}`);
          if (r.errorText) console.log(`       ⚠️ Error: ${r.errorText}`);
        });
        break;
      }

      case "console": {
        const level = args[1];
        const res = await postAction("console", { level, limit: 40 });
        console.log(`=== Chrome Console Logs & Errors (Total logs: ${res.totalLogs}) ===`);
        (res.logs || []).forEach(l => {
          const icon = l.level === "error" ? "❌" : (l.level === "warning" || l.level === "warn" ? "⚠️" : "ℹ️");
          console.log(`${icon} [${l.level.toUpperCase()}] ${l.text}`);
          if (l.stack) console.log(`   ${l.stack.split("\n")[0]}`);
        });
        break;
      }

      case "cdp": {
        const method = args[1];
        if (!method) throw new Error("Usage: chrome-bridge cdp <method> [jsonParams]");
        let params = {};
        if (args[2]) {
          try { params = JSON.parse(args.slice(2).join(" ")); } catch (_) {}
        }
        const res = await postAction("cdp", { method, params });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "fill": {
        let fields = {};
        try {
          fields = JSON.parse(args[1]);
        } catch (_) {
          throw new Error('Usage: chrome-bridge fill \'{"#selector": "value"}\' [submitSelector]');
        }
        const submitSelector = args[2];
        const res = await postAction("batch_form", { fields, submitSelector });
        console.log(`Filled fields:`, res.filled, res.submitted ? "(Submitted)" : "");
        break;
      }

      case "attach": {
        const tabId = args[1] ? Number(args[1]) : undefined;
        const res = await postAction("dev_attach", { tabId });
        console.log(`Attached DevTools to tab ${res.tabId}:`, res.attached);
        break;
      }

      case "ground":
      case "visual-ground": {
        const outPath = args[1] || path.join(process.cwd(), `grounded-${Date.now()}.png`);
        console.log("Running visual grounding pass with numbered tags [1], [2], [3]...");
        const res = await postAction("visual_grounding");
        if (res.screenshotDataUrl) {
          const base64Data = res.screenshotDataUrl.replace(/^data:image\/png;base64,/, "");
          fs.writeFileSync(outPath, Buffer.from(base64Data, "base64"));
          console.log(`Saved tagged image to: ${outPath}`);
        }
        console.log(`✓ Visually grounded ${res.count} interactive elements:`);
        (res.elements || []).slice(0, 20).forEach(e => {
          console.log(`  [${e.id}] <${e.tag}> "${e.text || ''}" -> Center: (${e.x}, ${e.y})`);
        });
        break;
      }

      case "challenge": {
        const res = await postAction("detect_challenge");
        if (res.challengeDetected) {
          console.log(`🛡️ Security challenge detected: [${res.type}] on ${res.url}`);
        } else {
          console.log(`✓ Clean page: No CAPTCHAs, Turnstile, or 2FA barriers detected.`);
        }
        break;
      }

      case "scrape": {
        const urls = args.slice(1);
        if (!urls.length) throw new Error("Usage: node cli.js scrape <url1> [url2...]");
        console.log(`Scraping ${urls.length} URLs in parallel background tabs...`);
        const res = await postAction("parallel_scrape", { urls });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "run-macro": {
        const name = args[1];
        if (!name) throw new Error("Usage: node cli.js run-macro <macroName>");
        console.log(`Executing macro "${name}" at hardware speed...`);
        const res = await postAction("run_macro", { name });
        console.log(`✓ Executed:`, res);
        break;
      }

      case "wait":
      case "wait_for_user": {
        const reason = args.slice(1).join(" ") || "Action or password input required";
        console.log(`🔔 Checkpoint active: "${reason}" (chime played in Chrome)...`);
        const res = await postAction("wait_for_user", { reason, timeoutSec: 120 }, 150000);
        console.log(`✓ Resumed (${res.clearedBy}) in ${res.elapsedSeconds}s!`);
        break;
      }

      case "whatsapp":
      case "wa": {
        const contact = args[1];
        const message = args[2];
        const dryRun = args.includes("--dry-run") || args.includes("-d");
        if (!contact || !message) {
          throw new Error("Usage: bridge whatsapp <contact> <message> [--dry-run]");
        }
        console.log(`Sending WhatsApp message to "${contact}"...`);
        const res = await postAction("whatsapp_send", { contact, message, dryRun });
        if (res.isLocked) {
          console.warn("⚠️ WhatsApp Web is locked with App Lock.");
          console.log("Please unlock it in Chrome or run: bridge wait \"Enter WhatsApp password\"");
        } else if (res.dryRun) {
          console.log(`✓ [DRY RUN] WhatsApp message prepared:`);
          console.log(`  Recipient: "${res.contact}"`);
          console.log(`  Message:   "${res.message}"`);
          console.log(`  Duration:  ${res.durationMs}ms`);
        } else if (res.success) {
          console.log(`✓ WhatsApp message sent to "${res.contact}" in ${res.durationMs}ms!`);
        } else {
          console.error(`❌ Failed: ${res.error}`);
        }
        break;
      }

      case "smart-nav":
      case "snav": {
        const url = args[1];
        if (!url) throw new Error("Usage: bridge smart-nav <url>");
        const res = await postAction("smart_navigate", { url });
        console.log(`${res.reused ? '✓ Reused existing tab' : '✓ Navigated to'}: [${res.title || 'Page'}] (${res.url})`);
        break;
      }

      case "extract": {
        const selector = args[1];
        const attribute = args[2] || "text";
        if (!selector) throw new Error("Usage: bridge extract <selector> [attribute]");
        const res = await postAction("extract_data", { selector, attribute });
        console.log(`Extracted (${res.count} items):`, JSON.stringify(res.data, null, 2));
        break;
      }

      case "help":
      default: {
        console.log(`
Chrome Browser Bridge: Codex / Antigravity / Claude Code

Usage:
  bridge config <client>            Print Codex, Claude, or Antigravity MCP config
  bridge doctor                     Diagnose server and extension connection
  bridge profile                    Show recent action counts and browser/bridge timing
  bridge act <JSON|@file.json>       Execute DOM steps in one page injection
  bridge workflow <JSON|@file.json> Run a complete plan locally with final verification
  bridge action <name> [JSON]        Machine-readable access to any bridge action
  bridge status                     Check connection status
  bridge tabs                       List open tabs
  bridge switch <tabId>             Switch active tab
  bridge new <url>                  Open new tab
  bridge close [tabId]              Close tab
  bridge navigate <url>             Navigate active tab to URL
  bridge reload                     Reload active tab
  bridge snapshot [tabId]           Dump page elements, structure & summaries
  bridge network [filter]           Inspect network traffic & API calls
  bridge console [level]            Inspect browser console logs & runtime errors
  bridge click <sel|text|#num>      Click element by selector, text, or #index
  bridge type <sel> <text>          Type into input field (--enter to submit)
  bridge fill '{"sel":"val"}' [btn] Fast batch form filling & submission
  bridge select <sel> <val>         Select option in dropdown
  bridge scroll [up|down] [px]      Scroll active page
  bridge eval <code>                Execute JavaScript in page context
  bridge cdp <method> [params]      Send raw Chrome DevTools Protocol command
  bridge screenshot [path]          Save high-res screenshot of active tab
`);
        break;
      }
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main().finally(() => transport.close());
