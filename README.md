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
Merge the generated output into your global config (`~/.gemini/config/mcp_config.json`) or workspace configuration (`.agents/mcp_config.json`). Uses `BRIDGE_TOOL_PROFILE=fast` for maximum execution speed.

### 2. Claude Code
Add to your project `.mcp.json` or run:
```bash
claude mcp add --env BRIDGE_TOOL_PROFILE=compact --transport stdio chrome-browser-bridge -- node "/absolute/path/to/chrome-browser-bridge/mcp-server.js"
```

### 3. OpenAI Codex
Run:
```bash
codex mcp add chrome-browser-bridge --env BRIDGE_TOOL_PROFILE=compact -- node "/absolute/path/to/chrome-browser-bridge/mcp-server.js"
```

---

## 🛠️ Core Tool Capabilities

| Tool | Purpose | Performance Benefit |
| :--- | :--- | :--- |
| `chrome_workflow` | Multi-stage tasks spanning navigation and conditional logic | Executes full plan locally in browser; zero model round-trips |
| `chrome_act` | Batch same-page interactions (click, type, assert, extract) | Single-injection script with native setters and microtask reactivity |
| `chrome_smart_navigate` | Switch to/reuse already-open tabs or navigate active tab | Eliminates duplicate tab churn and preserves SPA state |
| `chrome_page_fetch_many` | Execute 1–20 API requests in active page session | Uses existing browser session cookies/headers concurrently |
| `chrome_extract_many` | Extract multiple CSS selectors in a single call | One round-trip extraction instead of repetitive DOM queries |
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
