# 🌐 Chrome Browser Bridge

[![CI Checks](https://github.com/rahulbomnalli/chrome-browser-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/rahulbomnalli/chrome-browser-bridge/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen.svg)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Standard%20%26%20Fast%20Profiles-purple.svg)](https://modelcontextprotocol.io)

> **Give your AI coding agents direct, ultra-fast access to your real logged-in Chrome browser.**

Chrome Browser Bridge connects **Antigravity CLI / IDE, OpenAI Codex, and Claude Code** directly to your active Google Chrome session over a high-performance local MCP server. No separate headless browser instances, no losing login sessions, and zero unnecessary turn round-trips.

---

## ⚡ Key Highlights

- **Preserve Real Logged-In Sessions**: Automate tasks on authenticated sites (GitHub, AWS, WhatsApp, internal dashboards) seamlessly using your everyday Chrome profile.
- **Sub-Second Execution Protocol**: Eliminates multi-turn LLM latency. Execute multi-step interactions, form fills, assertions, and extractions in **one single compound MCP call** (`chrome_workflow` / `chrome_act`).
- **Zero-Round-Trip Page APIs**: Dispatch concurrent authenticated HTTP requests directly from page context via `chrome_page_fetch_many` and `chrome_api_sequence`.
- **Smart Adaptive Memory**: Automatic failure recovery, in-tab human authentication checkpoints (`chrome_wait_for_user`), and proactive DOM observers.
- **Battle-Tested & Lightweight**: Zero heavy external browser dependencies (like Puppeteer/Playwright); only uses native Chrome Extension APIs + lightweight WebSocket transport.

---

## 🚀 Quick Start (3 Steps)

### Prerequisites
- **Node.js 22+**
- **Google Chrome**

### 1. Clone & Install
```bash
git clone https://github.com/rahulbomnalli/chrome-browser-bridge.git
cd chrome-browser-bridge
npm install
```

### 2. Start the Local Bridge Server
```bash
npm start
```
*The local bridge server runs on `http://127.0.0.1:8765`.*

### 3. Load Extension in Chrome
1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `extension/` folder inside this repository.
4. Verify the setup in a new terminal:
   ```bash
   node cli.js doctor
   ```

---

## 🔌 Connecting to Your Agent / CLI

### 1. Antigravity CLI & IDE
Run the configuration generator:
```bash
node cli.js config antigravity
```
Merge the generated output into your global config (`~/.gemini/config/mcp_config.json`) or workspace configuration (`.agents/mcp_config.json`). Generated Antigravity, Claude, and Codex configs use the task-focused `fast` profile: 33 tools covering universal browser controls, workflows, extraction/API work, visual capture, downloads, page diagnostics, and change monitoring, with compact successful results. Set `BRIDGE_TOOL_PROFILE=compact` or `BRIDGE_TOOL_PROFILE=full` to expose the broader catalogs.

### 2. Claude Code
Add to your project `.mcp.json` or run:
```bash
claude mcp add --env BRIDGE_TOOL_PROFILE=fast --transport stdio chrome-browser-bridge -- node "/absolute/path/to/chrome-browser-bridge/mcp-server.js"
```

### 3. OpenAI Codex
Run:
```bash
codex mcp add chrome-browser-bridge --env BRIDGE_TOOL_PROFILE=fast -- node "/absolute/path/to/chrome-browser-bridge/mcp-server.js"
```

Actions that expose `timeoutMs` or `timeoutSec` accept per-call deadline overrides. Set `BRIDGE_DEFAULT_TIMEOUT_MS` to change the fallback deadline; human checkpoints and page-watch actions retain their dedicated defaults.

---

## 🛠️ Core Tool Capabilities

The server defaults to the 33-tool `fast` profile, and generated client configs set it explicitly. Alongside compound actions, it now exposes universal tab, navigation, snapshot, click, type, scroll, select, wait, and overlay controls. It also includes parallel URL research, batched extraction/API requests, screenshots, clean page reading, downloads, network/console diagnostics, page-change monitoring, idempotent `browser.execute_plan`, cancellation/status checkpoints, and bounded execution metrics. Prefer `chrome_act` or `chrome_workflow` to batch known multi-step work. Specialized CDP and macro tools remain available through `BRIDGE_TOOL_PROFILE=compact` or `BRIDGE_TOOL_PROFILE=full`.

MCP guidance requires clients to ground claims in returned tool data, inspect unknown page state instead of guessing, and report task success only when the result and final verification support it. Legacy tools return structured browser results rather than unconditional success summaries.

| Tool | Purpose | Performance Benefit |
| :--- | :--- | :--- |
| `chrome_workflow` | Multi-stage tasks spanning navigation and conditional logic | Executes full plan locally in browser; zero model round-trips |
| `browser.execute_plan` | Execute a validated plan with idempotency and persisted checkpoints | Prevents duplicate submissions and serializes same-tab plans |
| `browser.cancel_plan` / `browser.plan_status` | Cancel at a stage boundary or inspect saved task state | Safe recovery without blind replay |
| `browser.metrics` | Read MCP and bridge latency/outcome traces | Separates bridge cost from unavailable model/client time |
| `chrome_act` | Batch same-page interactions (click, type, assert, extract) | Single-injection script with native setters and microtask reactivity |
| `chrome_parallel_scrape` | Read independent known URLs concurrently | One call for multi-site page research |
| `chrome_smart_navigate` | Switch to/reuse already-open tabs or navigate active tab | Eliminates duplicate tab churn and preserves SPA state |
| `chrome_switch_tab` / `chrome_new_tab` / `chrome_navigate` | Control tabs and navigate directly | Generic browser controls for simple navigation tasks |
| `chrome_snapshot` / `chrome_click` / `chrome_type` | Inspect and perform one grounded interaction | Direct controls when a compound action is unnecessary |
| `chrome_scroll` / `chrome_select` / `chrome_wait_for_element` | Scroll, select a dropdown option, or wait for page state | Covers common single-step interactions |
| `chrome_dismiss_overlays` | Dismiss common banners and dialogs | Unblocks page interaction without site-specific tooling |
| `chrome_page_fetch_many` | Execute 1–20 API requests in active page session | Uses existing browser session cookies/headers concurrently |
| `chrome_api_sequence` | Execute dependent API requests in one page injection | Reuses prior response values without model round-trips |
| `chrome_api_catalog` | Inspect requests and resources already observed on the page | Finds known page APIs without guessing endpoints |
| `chrome_extract_many` | Extract multiple CSS selectors in a single call | One round-trip extraction instead of repetitive DOM queries |
| `chrome_read_page` | Read clean headings and text from the active page | Useful for articles and pages without selector-specific extraction |
| `chrome_screenshot` | Capture the visible browser tab | Provides visual evidence for layout-dependent tasks |
| `chrome_debug_bundle` | Read recent network and console events together | One call for routine page diagnostics |
| `chrome_download_file` | Download a known URL or data URI through Chrome | Handles downloads without a separate browser workflow |
| `chrome_watch` | Wait for a selected page region to change | Avoids polling snapshots for asynchronous page updates |
| `whatsapp_send_message` | Auto-detect WhatsApp tab, resolve recipient, and send message | Handles App Lock and verification in one call |
| `chrome_wait_for_user` | Prompt user for manual CAPTCHA / 2FA checkpoint | In-tab modal pauses agent safely until user completes verification |

---

## 🧪 Testing & Verification

Run the comprehensive suite of unit tests, syntax checks, and transport benchmarks:

```bash
# Run unit & integration tests (50/50 passing)
npm test

# Run syntax check across all modules
npm run check

# Run transport benchmark
npm run bench -- --mock
```

---

## 📁 Repository Structure

```text
├── extension/          # Manifest V3 Chrome Extension (background, DOM dispatch, workflow)
├── lib/                # Client config, transport layers, and tool profiling
├── test/               # Comprehensive unit and integration test suite
├── docs/               # In-depth architecture specs, audits, and guides
├── cli.js              # Diagnostic CLI tool for status, doctor, tabs, and actions
├── server.js           # Local HTTP & WebSocket bridge server
├── mcp-server.js       # Fast Model Context Protocol (MCP) server implementation
└── package.json        # Dependencies and scripts
```

---

## 🛡️ License

This project is licensed under the [MIT License](LICENSE).
