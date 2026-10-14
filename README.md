# ⚡ Chrome Browser Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16.0.0-green.svg)](https://nodejs.org/)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-yellow.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-purple.svg)](https://modelcontextprotocol.io/)
[![Latency](https://img.shields.io/badge/Action%20Latency-%3C10ms-brightgreen.svg)]()
[![Token Savings](https://img.shields.io/badge/Token%20Reduction-90%25-orange.svg)]()

> **The ultra-fast, token-efficient autonomous bridge connecting AI Agents (Claude Desktop, Antigravity IDE, Cursor, OpenAI Agents) directly to your real, authenticated Google Chrome browser.**

---

## ⚡ Why Chrome Browser Bridge?

Traditional browser automation tools (Puppeteer, Playwright, Selenium) were designed for end-to-end testing, not LLM agents:

| Feature | Headless Automation (Playwright/Puppeteer) | ⚡ Chrome Browser Bridge |
|---|---|---|
| **User Logins & Sessions** | ❌ Empty profiles; blocked by Google/GitHub 2FA | ✅ **100% active sessions & cookies (Google, Slack, GitHub)** |
| **Token Consumption** | ❌ Dumps 30,000–80,000 raw DOM tokens | ✅ **Compresses DOM into `@1, @2` map (< 200 tokens)** |
| **Execution Latency** | ❌ 1,500ms – 5,000ms browser startup & round-trips | ✅ **Sub-10ms native Chrome DevTools Protocol & Scripting** |
| **Anti-Bot & CAPTCHA** | ❌ Headless flags trigger Cloudflare / Turnstile | ✅ **Real user browser context; zero headless fingerprint** |
| **Human Checkpoint** | ❌ Process crashes or hangs indefinitely | ✅ **Melodic audio chime + live auto-resume banner** |
| **Canvas & WebGL** | ❌ Cannot click or ground on Canvas/TradingView | ✅ **Visual Grounding tags `[1]`, `[2]` with coordinate clicks** |
| **Agent Protocols** | ❌ Complex ad-hoc wrappers | ✅ **Turnkey MCP Server for Claude, Antigravity, & Cursor** |

---

## 📸 Snapshots & Live Experience

### 1. Terminal CLI & MCP Execution
```text
$ npx chrome-bridge navigate "https://news.ycombinator.com"
✓ Opened dedicated window [Tab #1341700812] in 14ms

PAGE SNAPSHOT [URL: https://news.ycombinator.com]
--------------------------------------------------------------------------------
@1 [a] "Hacker News" (/news)
@2 [a] "new" (/newest)
@3 [a] "comments" (/newcomments)
@4 [a] "Show HN: Chrome Browser Bridge" (https://github.com/...)
@5 [span] "142 points by rahulbomnalli 2 hours ago"
@6 [input:text] (Search)
--------------------------------------------------------------------------------

$ npx chrome-bridge click @4
✓ Clicked element @4 -> Navigated to repository (8ms)
```

### 2. Live In-Browser Agent Activity Overlay
When your AI agent triggers actions, Chrome displays a non-intrusive floating status pill:

```
+---------------------------------------------------------------+
|  🟣 Agent Working: Typing into search and clicking @1...     |
+---------------------------------------------------------------+
```

The overlay updates smoothly:
- `🟣 Agent Working` (executing)
- `✓ Done (12ms)` (success flash)
- `⚠️ Action Required` (human checkpoint)

### 3. Human-in-the-Loop Checkpoint (2FA / CAPTCHA / App Lock)
When encountering a Cloudflare challenge, banking 2FA, or WhatsApp App Lock:
1. Plays a pleasant musical chime (`E5 -> B5`) inside the browser.
2. Focuses the window with a top banner: *"Agent Paused: Please complete 2FA verification"*.
3. Auto-resumes instantaneously the millisecond verification passes or the user clicks *"Resume"*.

---

## 🏗️ Architecture

```text
+---------------------------------------------------------------+
|     AI Agents (Claude Desktop / Antigravity / Cursor / CLI)   |
+---------------------------------------------------------------+
                               |
                   MCP (stdio) / CLI / REST
                               v
+---------------------------------------------------------------+
|       Local Bridge Server (Node.js on 127.0.0.1:8765)         |
+---------------------------------------------------------------+
                               ^
                  WebSocket (ws://127.0.0.1:8765)
                               v
+---------------------------------------------------------------+
|   Chrome MV3 Extension (Service Worker & Content Engine)      |
+---------------------------------------------------------------+
                               |
                  Chrome DevTools Protocol (CDP)
                               v
+---------------------------------------------------------------+
|     Your Real Google Chrome Browser (All Cookies & Logins)    |
+---------------------------------------------------------------+
```

---

## 🚀 Quick Start (60 Seconds)

### Step 1: Clone & Install

```bash
git clone https://github.com/rahulbomnalli/chrome-browser-bridge.git
cd chrome-browser-bridge
npm install
```

### Step 2: Load the Extension in Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select the `extension/` folder inside the cloned repository.
5. The extension icon appears in your toolbar with a green status indicator!

### Step 3: Start the Bridge Server

**On macOS / Linux:**
```bash
./run.sh
# or: npm start
```

**On Windows:**
```cmd
run.bat
# or: npm start
```

The server listens on `http://127.0.0.1:8765`.

---

## 🤖 Connect to AI Agents

### 1. Claude Desktop Setup
Add the server to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "chrome-browser-bridge": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/mcp-server.js"]
    }
  }
}
```

### 2. Antigravity IDE Setup
Add to your `mcp_config.json` (`~/.gemini/config/mcp_config.json` or `.agents/skills/`):

```json
{
  "mcpServers": {
    "chrome-browser-bridge": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/mcp-server.js"]
    }
  }
}
```

### 3. Cursor Setup
Go to **Settings** > **Features** > **MCP Servers** > **Add New MCP Server**:
- **Name**: `chrome-browser-bridge`
- **Type**: `command`
- **Command**: `node <PATH_TO_REPO>/mcp-server.js`

---

## 🛠️ CLI Reference

You can run commands directly using the CLI tool:

```bash
# Check bridge and extension connection status
node cli.js status

# List all open Chrome tabs
node cli.js tabs

# Open a URL in an isolated agent window and get semantic element tree
node cli.js navigate "https://github.com"

# Click an element by compact index, CSS selector, or visible text
node cli.js click @1
node cli.js click "#login-button"
node cli.js click "Sign In"

# Type text into an input field (--enter submits automatically)
node cli.js type @2 "search query" --enter

# Fill an entire form in under 50ms
node cli.js batch-fill '{"Email": "dev@test.com", "Password": "password123"}' "Submit"

# Visual Grounding: Injects [1], [2], [3] tags for Canvas / WebGL / TradingView
node cli.js ground

# Extract distraction-free readability content
node cli.js read

# Execute JavaScript directly in the active tab context
node cli.js eval "window.location.href"

# Take high-resolution screenshot
node cli.js screenshot "output.png"

# Execute a multi-step macro pipeline in 1 single round-trip
node cli.js pipeline '[
  {"action":"type","params":{"target":"#search","text":"ai bridge"}},
  {"action":"press","params":{"key":"Enter"}},
  {"action":"wait","ms":300},
  {"action":"click","params":{"target":"@1"}}
]'

# Run parallel scraping across multiple URLs in < 2 seconds
node cli.js scrape "https://news.ycombinator.com" "https://github.com/trending"
```

---

## 🧰 Full MCP Toolset (24+ Native Agent Tools)

| Tool Name | Parameters | Description |
|---|---|---|
| `chrome_smart_navigate` | `url`, `newWindow`, `timeout` | Opens dedicated window with shared cookies; returns compact elements `@1, @2` in 1 call |
| `chrome_snap` | `tabId`, `interactiveOnly` | Ultra-compact semantic DOM tree (**90% fewer tokens**) |
| `chrome_click` | `target`, `waitForNavigation` | Click element by `@index`, selector, or text; returns updated page state |
| `chrome_type` | `target`, `text`, `pressEnter` | Types into inputs/contentEditables; auto-submits with `pressEnter: true` |
| `chrome_batch_fill` | `fields`, `submitSelector` | Fills multiple inputs simultaneously across React/Vue/vanilla forms in < 50ms |
| `chrome_visual_grounding` | `tabId` | Generates numbered visual tags (`[1]`, `[2]`) for Canvas, SVGs, and WebGL |
| `chrome_pipeline` | `steps` | Runs multi-action pipelines in 1 round-trip without intermediate LLM delays |
| `chrome_detect_challenge` | `tabId` | Detects Cloudflare, Turnstile, hCaptcha, Google reCAPTCHA, and 2FA screens |
| `chrome_wait_for_user` | `reason`, `timeoutSec` | Melodic chime + top banner for human checkpoint; auto-resumes once resolved |
| `chrome_parallel_scrape` | `urls`, `selector` | Fetches and parses content across multiple URLs in parallel worker tabs |
| `chrome_read_page` | `tabId` | Clean readability extraction (headings, article text, metadata) |
| `chrome_save_macro` | `name`, `steps` | Saves repetitive workflows for zero-token replaying |
| `chrome_run_macro` | `name`, `variables` | Replays saved workflow at hardware speed with **zero LLM tokens** |
| `chrome_list_tabs` | - | Lists open tabs with IDs, titles, and URLs |
| `chrome_switch_tab` | `tabId` | Switches active Chrome tab |
| `chrome_screenshot` | `path`, `fullPage` | Captures high-res PNG screenshot |
| `chrome_network_logs` | `filter`, `limit` | Live HTTP/HTTPS requests, status codes, and latency |
| `chrome_console_logs` | `level`, `limit` | Captures browser console logs and uncaught runtime errors |
| `chrome_evaluate` | `script` | Executes arbitrary JavaScript inside page context |

---

## 🔒 Privacy, Security & Isolation

- **100% Local**: All communication occurs exclusively over loopback `127.0.0.1`. No external servers, no telemetry, no third-party cloud relays.
- **Dedicated Task Window**: The bridge operates in an isolated window under your profile. Your personal tabs and windows remain undisturbed.
- **Zero Headless Footprint**: Because it runs inside your real Google Chrome, anti-bot mechanisms see authentic browser TLS fingerprints, WebGL contexts, and natural user environments.

---

## 🤝 Contributing

Contributions, feature requests, and benchmarks are welcome!
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/FastAction`)
3. Commit your Changes (`git commit -m 'Add fast action pipeline'`)
4. Push to the Branch (`git push origin feature/FastAction`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more details.

---

**Built with ⚡ for the next generation of autonomous AI agents.**
