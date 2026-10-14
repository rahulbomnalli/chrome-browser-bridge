---
name: chrome-browser-bridge
description: Ultra-fast, token-optimized autonomous bridge to control Google Chrome. Uses token compression (90% fewer tokens), multi-action pipelines, visual grounding, and Chrome DevTools Protocol for sub-10ms native browser automation.
---

# Chrome Browser Bridge (Ultra-Fast Engine v4.0)

This skill enables Antigravity to autonomously control the user's running Google Chrome browser with ultra-low token consumption (< 100 tokens/action) and hardware-level execution speed.

---

## ⚡ Core Execution Principles (Must Follow)

### 1. 🪟 Dedicated Window Isolation (Zero User Interruption)
- **Always operate in a dedicated window**: The bridge automatically starts tasks in a dedicated Chrome window under the user's primary profile.
- **100% Shared Sessions**: All cookies, logins (Google, GitHub, email), saved passwords, and extensions are active.
- **Never hijack personal tabs**: Your personal browsing window stays completely undisturbed.

### 2. ⚡ 1-Roundtrip Auto-Snapshot (60–70% Faster)
- `chrome_navigate` / `bridge navigate` automatically returns the URL, title, **and the compact interactive elements (`@1, @2, @3`) in 1 single round-trip**.
- `chrome_click` and `chrome_type` (`pressEnter: true`) automatically return the updated page state.
- **NEVER** call `chrome_snap` immediately after `chrome_navigate` or `chrome_click` — the elements are already in the response!

### 3. 🎯 Visual Grounding for Canvas, Charts, & WebGL
- When DOM selectors fail on Canvas, TradingView charts, Google Docs canvases, SVGs, or complex SPAs, use **`visual_grounding`**.
- Injects high-contrast numeric tags `[1]`, `[2]`, `[3]` onto elements and returns coordinate mappings for hardware-level clicking.

### 4. 🚀 Zero-Token Instant Macros (`run_macro`)
- For repetitive workflows (login, filter search, scrape invoice), save the macro once with `chrome_save_macro` and execute it at hardware speed (< 400ms) with **zero LLM tokens** via `chrome_run_macro`.

### 5. 🛡️ Smart Human Checkpoint & App Lock (`wait_for_user`)
- When any site or application presents a password prompt, PIN lock, app lock screen, CAPTCHA, or 2FA barrier:
  - Call **`chrome_wait_for_user`** (or `bridge wait "<reason>"`).
  - Automatically plays a crystal-clear melodic audio chime (E5 -> B5) inside Chrome, brings the window to focus, and shows a top guidance banner.
  - Keeps the AI agent execution alive and polls every 500ms; auto-resumes the moment the password field disappears or the user clicks "Resume Agent".
  - **100% Universal**: Works across all web apps, portals, and authenticated sites without hardcoding.

### 6. ✍️ Universal High-Speed Typing (ContentEditable & SPAs)
- Works natively on all modern web apps, React/Vue synthetic inputs, and rich-text editors (Lexical, Slate, DraftJS, ProseMirror, Quill).
- Submits and auto-returns next page state in 1 call using `pressEnter: true`.

---

## 🚀 Ultra-Fast Action Workflows

### Pattern 1: Fast Navigation & Action (2 Tool Calls Total)
```bash
# Call 1: Opens dedicated window and returns @1, @2 elements immediately
bridge navigate "https://news.ycombinator.com"

# Call 2: Clicks element @1 and auto-returns next page elements
bridge click @1
```

### Pattern 2: Multi-Action Pipeline (1 Round-Trip Macro)
Execute multiple interactions in one synchronous execution without intermediate LLM round-trips:
```bash
bridge pipeline '[
  {"action":"type","params":{"target":"#search","text":"laptop"}},
  {"action":"press","params":{"key":"Enter"}},
  {"action":"wait","ms":300},
  {"action":"click","params":{"target":"@1"}}
]'
```

### Pattern 3: Autonomous Parallel Scraping (< 2s)
Fetch data across multiple URLs simultaneously in parallel background worker tabs:
```bash
bridge scrape "https://news.ycombinator.com" "https://github.com/trending"
```

---

## 🛠️ Complete Command Reference

| Category | Command / MCP Tool | Description |
|---|---|---|
| **Window & Navigation** | `bridge navigate <url>` / `chrome_navigate` | Launches task in dedicated window and returns page elements `@1, @2` |
| | `bridge new <url>` / `chrome_new_tab` | Open dedicated task tab with shared session |
| | `bridge tabs` / `chrome_list_tabs` | List open Chrome tabs with IDs and URLs |
| | `bridge switch <tabId>` / `chrome_switch_tab` | Switch focused tab |
| | `bridge reload` | Fast reload active page |
| **Inspection & Grounding** | `bridge snap` / `chrome_snap` | **Ultra-compact DOM map (90% fewer tokens)** |
| | `bridge ground` / `chrome_visual_grounding` | **Visual Bounding Boxes with [1], [2], [3] tags for canvas/charts** |
| | `bridge challenge` / `chrome_detect_challenge` | Detect Cloudflare, Turnstile, hCaptcha, and 2FA screens |
| | `bridge wait <msg>` / `chrome_wait_for_user` | **Human Checkpoint**: Plays audio chime, shows banner, and auto-resumes once unlocked |
| | `bridge read` / `chrome_read_page` | Clean readability extraction (headings & text) |
| | `bridge screenshot [path]` / `chrome_screenshot` | High-res PNG capture |
| **High-Speed Actions** | `bridge click <@idx\|sel>` / `chrome_click` | Click by `@1`, `#id`, or text (auto-returns next state) |
| | `bridge type <@idx\|sel> <txt>` / `chrome_type` | Type text (`--enter` submits and auto-returns next state) |
| | `bridge fill '{"Field":"Val"}'` / `chrome_batch_fill` | **Smart form fill (< 50ms) by label, name, or placeholder** |
| | `bridge pipeline <jsonSteps>` / `chrome_pipeline` | Execute multi-step macro in 1 single round-trip |
| | `bridge run-macro <name>` / `chrome_run_macro` | Replay saved workflow at hardware speed (0 tokens) |
| **DevTools & Network** | `bridge network [filter]` / `chrome_network_logs` | Real-time HTTP/HTTPS traffic & status codes |
| | `bridge console [level]` / `chrome_console_logs` | Console errors, exceptions, and stack traces |
| | `bridge eval <code>` / `chrome_evaluate` | Run arbitrary JavaScript in page context |
| | `bridge cdp <method> [params]` | Execute raw Chrome DevTools Protocol command |

---

## ⚡ Speed & Token Optimization Rules

1. **Prefer `@index` notation**: Always target `@1`, `@2` over long CSS selectors or XPath.
2. **Combine Submit + Navigation**: Use `chrome_type({ selector: "@1", text: "query", pressEnter: true })` — it types, submits, and returns the next page's elements in **one tool call**.
3. **Batch Form Filling**: Never type fields one-by-one with multiple round-trips. Use `chrome_batch_fill` with a JSON map (`{ "Email": "user@test.com", "Password": "..." }`) to fill all inputs in **< 50ms**.
4. **Use Parallel Scraping**: When comparing multiple products or articles, pass all URLs to `chrome_parallel_scrape` instead of sequential navigations.
