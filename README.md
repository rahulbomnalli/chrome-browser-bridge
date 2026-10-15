# ⚡ Chrome Browser Bridge

> **Control your real Google Chrome browser with AI — easily, quickly, and securely.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16.0.0-green.svg)](https://nodejs.org/)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-yellow.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-purple.svg)](https://modelcontextprotocol.io/)

---

## 🌟 What is this?

**Chrome Browser Bridge** connects AI agents (like Claude Desktop, Antigravity, or Cursor) to the Google Chrome browser you already use every day.

Normally, AI web bots start a blank browser where you are logged out of everything, get blocked by verification screens, or waste lots of time and AI tokens. 

**Chrome Browser Bridge fixes that:**
- 🔑 **Stay Logged In**: Uses your normal Chrome tabs, saved passwords, and cookies (Google, WhatsApp, GitHub, LinkedIn).
- ⚡ **Lightning Fast**: Actions take less than 10 milliseconds.
- 💰 **Saves AI Tokens**: Converts messy web pages into simple lists (`@1`, `@2`), saving up to 90% of token costs.
- 🔔 **Friendly Alerts**: If a website asks for 2-step verification (2FA or CAPTCHA), the browser plays a gentle chime and lets you solve it before automatically continuing.
- 🎯 **Visual Point & Click**: Can click buttons even on complex charts, canvas, and graphics.

---

## 🆚 Regular Tools vs. Chrome Browser Bridge

| Feature | Regular Tools (Puppeteer/Playwright) | ⚡ Chrome Browser Bridge |
|---|---|---|
| **Your Logins & Passwords** | ❌ Blank profile, logged out of everything | ✅ **Keeps you logged in everywhere** |
| **Speed** | ❌ Slow (1 to 5 seconds per action) | ✅ **Instant (under 10ms)** |
| **Token Cost** | ❌ Sends massive page code (30,000+ tokens) | ✅ **Clean & tiny summary (< 200 tokens)** |
| **Bot Detection / CAPTCHAs** | ❌ Blocked by websites | ✅ **Looks like a normal human user** |
| **Verification / 2FA** | ❌ Freezes or crashes | ✅ **Plays a sound, waits for you, and resumes** |
| **Setup with AI Assistants** | ❌ Hard to set up | ✅ **Plug-and-play with Claude, Antigravity & Cursor** |

---

## 🚀 Quick Setup (3 Simple Steps)

### Step 1: Download the Project
Open your computer terminal and run:
```bash
git clone https://github.com/rahulbomnalli/chrome-browser-bridge.git
cd chrome-browser-bridge
npm install
```

### Step 2: Add the Extension to Chrome
1. Open Google Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select the `extension/` folder inside this project.
5. You will see the extension icon in your browser toolbar!

### Step 3: Start the Bridge Server
- **On Windows**: Double-click `run.bat` or run:
  ```cmd
  run.bat
  ```
- **On Mac / Linux**: Run:
  ```bash
  ./run.sh
  ```

Your bridge is now live and waiting for AI commands!

---

## 🤖 Connect to Your Favorite AI App

Add Chrome Browser Bridge to your AI configuration file:

### Claude Desktop
Open your Claude settings file (`claude_desktop_config.json`):
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add this:
```json
{
  "mcpServers": {
    "chrome-browser-bridge": {
      "command": "node",
      "args": ["<FULL_PATH_TO_FOLDER>/mcp-server.js"]
    }
  }
}
```

### Antigravity IDE
Add to your `mcp_config.json` file:
```json
{
  "mcpServers": {
    "chrome-browser-bridge": {
      "command": "node",
      "args": ["<FULL_PATH_TO_FOLDER>/mcp-server.js"]
    }
  }
}
```

### Cursor
1. Go to **Settings** > **Features** > **MCP Servers**.
2. Click **Add New MCP Server**.
3. Set **Name**: `chrome-browser-bridge`
4. Set **Type**: `command`
5. Set **Command**: `node <FULL_PATH_TO_FOLDER>/mcp-server.js`

---

## 🖥️ Easy Commands (CLI)

You can also run commands yourself directly from the command line:

```bash
# Check if the bridge is connected
node cli.js status

# List your open tabs
node cli.js tabs

# Open a website
node cli.js navigate "https://github.com"

# Click a button (by number, text, or selector)
node cli.js click @1
node cli.js click "Sign In"

# Type into a search box and press Enter
node cli.js type @2 "AI Tools" --enter

# Fill out a full form in one go
node cli.js batch-fill '{"Email": "you@example.com", "Password": "mypassword"}' "Submit"

# Read article text without clutter
node cli.js read

# Take a screenshot
node cli.js screenshot "page.png"
```

---

## 🧰 Available Tools for AI

| Tool | What It Does |
|---|---|
| `chrome_smart_navigate` | Opens a web page using your existing cookies and returns simple numbered buttons (`@1`, `@2`) |
| `chrome_snap` | Takes a clean, low-token snapshot of interactive items on the page |
| `chrome_click` | Clicks any button, link, or item |
| `chrome_type` | Types words or searches into fields |
| `chrome_batch_fill` | Fills out an entire login or sign-up form instantly |
| `chrome_read_page` | Extracts clean text and articles without ads or sidebar mess |
| `chrome_screenshot` | Saves a high-quality picture of the page |
| `chrome_wait_for_user` | Chimes and waits for you if 2FA or CAPTCHA appears, then resumes |
| `chrome_list_tabs` | Shows all currently open tabs |
| `chrome_switch_tab` | Jumps to another open tab |
| `chrome_parallel_scrape` | Reads multiple websites at the same time |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
