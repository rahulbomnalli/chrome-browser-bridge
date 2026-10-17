# Chrome Browser Bridge

**Give your CLI agent a browser. Keep your logged-in Chrome session. Batch the work.**

Chrome automation for **Codex, Antigravity CLI/IDE, and Claude Code** through one local MCP server. No extra model subscription or hosted automation service: your existing CLI plans the task, and the bridge executes it in your real Chrome profile.

```text
Your prompt -> Codex / Antigravity / Claude Code
                    | MCP stdio
              Shared HTTP transport
                    | loopback HTTP + persistent WebSocket
              Chrome extension
                    | one DOM workflow / navigation pipeline / CDP
              Your existing browser session
```

## Start in three steps

Requires Node.js 22+ and Google Chrome.

```sh
git clone https://github.com/rahulbomnalli/chrome-browser-bridge.git
cd chrome-browser-bridge
npm ci
npm start
```

Load `extension/` using **Load unpacked** at `chrome://extensions/` with Developer mode enabled. Keep the server running, then verify in another terminal:

```sh
node cli.js doctor
```

On Windows PowerShell, use `npm.cmd` if your execution policy blocks `npm.ps1`.

## Connect your CLI

Use an absolute path to this checkout. All clients share the same server and extension; run each MCP adapter as a separate stdio process. Avoid concurrent mutations of the same tab from different agents.

### Codex

```sh
codex mcp add chrome-browser-bridge --env BRIDGE_TOOL_PROFILE=compact -- node "/absolute/path/chrome-browser-bridge/mcp-server.js"
```

For the full configuration, run `node cli.js config codex` and merge the output into `~/.codex/config.toml`. The generated config sets `tool_timeout_sec = 180` so human authentication checkpoints can finish. Restart the client after changing its configuration. [Official Codex MCP documentation](https://developers.openai.com/codex/mcp).

### Claude Code

```sh
claude mcp add --env BRIDGE_TOOL_PROFILE=compact --transport stdio chrome-browser-bridge -- node "/absolute/path/chrome-browser-bridge/mcp-server.js"
```

Alternatively, run `node cli.js config claude` and merge the JSON into the project's `.mcp.json`. This prints configuration; it does not overwrite existing settings. [Official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Antigravity CLI and IDE

Run `node cli.js config antigravity`. Merge the generated `mcpServers` entry into the workspace's `.agents/mcp_config.json` or global `~/.gemini/config/mcp_config.json`. In the IDE, open **MCP Servers > Manage MCP Servers > View raw config**. [Official Antigravity MCP documentation](https://www.antigravity.google/docs/mcp).

### Choose your tool catalog

Generated configs use `BRIDGE_TOOL_PROFILE=compact`: 25 tools covering complete task workflows, navigation, DOM batches, pipelines, extraction, API discovery, single/concurrent/dependent authenticated page API calls, main-world JavaScript injection, ordered Chrome DevTools commands, combined network/console diagnostics, screenshots, human checkpoints, one-call WhatsApp sending, parallel page reads, saved macros, and event-driven page watching. This keeps the catalog focused while exposing fast paths for common tasks. Omit this environment variable to expose the full catalog. Existing full-catalog configurations remain supported.

## Give it a goal

Ask your connected CLI:

> Use Chrome Browser Bridge to open GitHub, find my open pull requests, and summarize which ones need my review. Continue until you have verified the results.

> Open the reporting dashboard, apply last month's date range, download the report, and verify the outcome.

The MCP server supplies workflow instructions to the client: reuse fresh observations, batch known actions, verify outcomes, and resume from the last completed step. Planning comes from the connected agent. The bridge does not turn arbitrary text into actions by itself, bypass authentication, or guarantee completion on every website. Website response times and model reasoning determine total task duration.

## Two execution paths

**`chrome_act`: known steps within one document.** One MCP request, one WebSocket request, one page injection. Native input setters avoid character-by-character typing. DOM observers wake waiting steps when the relevant state changes; a bounded property-check fallback handles value and visibility updates. There are no fixed sleeps on the immediate success path.

```json
{
  "tabId": 123,
  "timeoutMs": 10000,
  "steps": [
    { "action": "type", "selector": "input[name=q]", "value": "browser bridge" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait", "selector": "#results", "text": "browser bridge" },
    { "action": "extract", "selector": "#results" }
  ]
}
```

Use this for SPAs and same-document forms. Each step needs exactly one target: `selector`, `role` (optionally with exact `name`), `label`, or `placeholder`. Semantic targets can avoid a preliminary snapshot when the control's label is known from the request. Matches must be unique and visible; ambiguous targets stop the workflow. Actions are `click`, `type`, `select`, `wait`, `assert`, and `extract`. `text` matches a substring; `equals` checks exact input value or text. Extraction returns at most 8,000 characters per step. Clicks reject obstructed targets. Input events are synthetic; use CDP when a website requires trusted input. Full navigation destroys the document execution context: use a pipeline instead.

```json
{"steps":[{"action":"type","placeholder":"Message","value":"Hello"},{"action":"click","role":"button","name":"Send"}]}
```

**`chrome_pipeline`: dependent steps across documents.** One bridge request, ordered browser operations, snapshots suppressed between steps, one optional final snapshot. It follows newly opened tabs and returns `failedStep` and completed results on failure. It never retries completed actions.

```json
{
  "steps": [
    { "action": "navigate", "params": { "url": "https://example.com" } },
    { "action": "wait_for_element", "params": { "selector": "h1" } },
    { "action": "extract_data", "params": { "selector": "h1" } }
  ],
  "timeoutMs": 30000,
  "returnSnap": false
}
```

A failed workflow returns `ok: false`, partial progress, and an error or failed-step result. MCP marks these results as errors. Inspect state before resuming; a timeout or navigation interruption cannot roll back an action already performed. Budgets bound waits and prevent starting further pipeline steps after expiry; they cannot interrupt an already dispatched Chrome operation or synchronous page script.

**`chrome_watch`: monitor a changing page.** Pass a CSS selector for message nodes or a region, and compare its `text`, match `count`, or an `attribute`. The call waits for a DOM change (20 seconds by default, up to 120 seconds) and returns the changed value and new text. An omitted baseline starts watching from the current state. Pass each result's `current` as the next call's `baseline` so changes between calls are detected. The CLI must remain active and call again after each change or timeout to continue monitoring; a reply still requires a user-defined rule or an agent decision.

**`chrome_extract_many`: gather multiple page fields at once.** Send an array of CSS-selector queries with optional attributes, result limits, and single/multiple modes. The extension evaluates all queries in one page injection and returns a result per selector, including selector-specific errors, instead of requiring one MCP call per field. Use `chrome_extract_data` for a single selector.

Routine actions skip the in-page status HUD and click/type animation to keep the browser hot path lean. Low-level bridge actions can opt in with `showHud: true` or `highlight: true`. Compact snapshots cache each candidate's layout and label once before ordering visible controls.

## CLI and diagnostics

```sh
node cli.js status
node cli.js doctor
node cli.js config codex
node cli.js config claude
node cli.js config antigravity
node cli.js tabs
node cli.js snap
node cli.js act @workflow.json
node cli.js action extract_data '{"selector":"h1"}'
node cli.js pipeline '[{"action":"navigate","params":{"url":"https://example.com"}}]'
```

`act` accepts either a steps array or a workflow object from a JSON argument or `@file`. `action` exposes bridge actions with JSON output; `act`, `action`, and `pipeline` exit nonzero when a structured workflow fails. `status` reports connection state and, with this server build, pending requests and rolling p50/p95 bridge latency for the most recent 512 responses. `doctor` exits nonzero when the extension is disconnected.

`BRIDGE_URL` changes the MCP/CLI server address (default `http://127.0.0.1:8765`). `PORT` changes the server listener; the extension currently connects to port 8765, so changing it also requires updating `BRIDGE_WS_URL` in `extension/background.js` and reloading the extension.

## Performance you can reproduce

### Remove AI round trips between steps

Choose the smallest reliable call for the task:

| Task | Fast path |
|---|---|
| One or more known actions on the current page | One `chrome_act` call with all actions and final assertions/extractions |
| Known multi-stage task spanning navigation and page actions | One `chrome_workflow` call; stages, local conditions, value transfer, and final verification run in the extension without intermediate model calls |
| Data from a known, page-accessible API endpoint | One `chrome_page_fetch` call; uses the active page session and remains subject to browser origin/CORS rules |
| Data from several known API endpoints | One `chrome_page_fetch_many` call; issues up to 20 requests concurrently in one page injection |
| Dependent API calls (for example, create then fetch by returned ID) | One `chrome_api_sequence` call; references earlier JSON values locally with `{{results.create.id}}` |
| Find API endpoints used by the loaded page | One `chrome_api_catalog` call; merges resource timing with captured DevTools request details and redacts likely secrets |
| Site globals or API logic requiring custom JavaScript | One `chrome_run_page_script` call in the page MAIN world with JSON `args` and bounded output |
| Known ordered Chrome DevTools operations | One `chrome_cdp_batch` call; runs up to 20 commands against one debugger attachment |
| Page failure diagnosis | One `chrome_debug_bundle` call for bounded network and console logs together |
| Several known selectors on one page | One `chrome_extract_many` call |
| Independent URLs | `chrome_parallel_scrape` |

Do not take a snapshot when targets are already known, or call status/snapshot between deterministic steps. If a target is unknown, take one snapshot, then batch the identified actions. Only use page fetch when the endpoint and method are supplied or already known; do not guess endpoints. If the API is unknown or inaccessible from the page, use DOM automation. The host AI still chooses the tool and authors a workflow; bridge instructions reduce avoidable round-trips but cannot force a client to choose a particular tool or remove model reasoning.

```json
{
  "inputs": { "query": "bridge performance" },
  "stages": [
    { "id": "open", "action": "navigate", "params": { "url": "https://example.com/search" } },
    { "id": "search", "action": "act", "params": { "steps": [
      { "action": "type", "label": "Search", "value": "{{inputs.query}}" },
      { "action": "click", "role": "button", "name": "Search" }
    ] } },
    { "id": "ready", "action": "wait_for_element", "params": { "selector": "#results" } }
  ],
  "verify": [{ "selector": "#results", "text": "Results" }],
  "saveAs": "site_search"
}
```

The example illustrates the schema; use selectors and labels verified on the actual site. Replay a saved plan with `{"name":"site_search","inputs":{"query":"new query"}}`. Only the template is saved, not runtime inputs. Use `{{results.read.results.0.value}}` to pass an earlier `act` extraction to later stages without returning to AI. A stage can include `"when":{"selector":"#optional-panel","exists":true}` for local conditional execution. Conditions observe the current visible DOM immediately; precede them with a readiness wait when needed.

`verify` contains read-only DOM assertions and is required for new plans. Success returns stage results and verification without a redundant snapshot. Failure returns `failedStage`, partial `failedResult`, completed stages and a fresh snapshot. Never replay completed submissions when recovering. Stage timeouts are capped by the remaining task budget; an already-dispatched browser operation cannot be forcibly canceled. CLI: `node cli.js workflow @plan.json`.

Restart/reconnect the MCP server and client after updating to expose the new tool; reload the extension only when extension files changed. Saved workflows still require one tool invocation; they eliminate plan reconstruction and intermediate model calls, not the initial AI response or website latency.

The compact profile includes `chrome_api_catalog`, `chrome_page_fetch`, `chrome_page_fetch_many`, `chrome_api_sequence`, `chrome_run_page_script`, `chrome_cdp_command`, `chrome_cdp_batch`, and `chrome_debug_bundle`. `chrome_api_catalog` combines resource timing entries (which can reflect requests made before DevTools attached) with captured CDP details; resource-only entries may not have method/status. It redacts credential-like URL query parameters and never returns request bodies, cookies, or authorization headers. The batch API tool dispatches 1-20 independent known endpoints concurrently. `chrome_api_sequence` runs dependent requests in order and resolves `{{results.name.path}}` references in URL, headers, and body from earlier JSON responses without returning to the model. Both bound response text and preserve partial progress on failure. The page-script tool executes one async JavaScript body in the page's MAIN world and returns bounded JSON; its code executes with page privileges, so use it only for the requested task. The DevTools batch runs 1-20 known commands in order on one tab, attaches once, stops at the first command error, returns the completed prefix, and caps each command result by default. The debug bundle returns bounded network and console summaries together, replacing separate diagnostics calls. These tools do not infer undocumented API endpoints or CDP operations. Page fetch remains constrained by the active page's network permissions and browser CORS rules.

```sh
npm test
npm run check
npm run bench               # read-only ping through a connected Chrome extension
npm run bench -- --mock     # actual HTTP + WebSocket transport, simulated extension
```

Benchmarks report 100 measured samples after 10 warmups, with p50, p95, and maximum latency. Mock results measure transport only. Live ping adds the extension handler; neither benchmark measures DOM workflows, website loading, or model reasoning. No claim of universal subsecond completion or superiority over other browser libraries is made without comparable measurements.

Latency improvements come from fewer agent/tool exchanges, persistent connections, disabled WebSocket compression for local traffic, compact observations, native field updates, and one-injection DOM workflows. [Architecture and failure behavior](docs/architecture.md).

Clicks, typing, compact snapshots, and batch form filling request immediate script injection, avoiding Chrome's default document-idle gate when the page already has usable controls. This does not guarantee a target exists during loading: use `chrome_act` with target readiness conditions for dynamic pages. Saved macros accept `timeoutMs` and `returnSnap: false` to skip a redundant final snapshot when their steps already verify the outcome. Keep the default final snapshot when more page context is needed.

## Local access and updates

The bridge binds to loopback. HTTP and WebSocket browser origins are restricted to local dashboard and Chrome extension origins. Request bodies and WebSocket payloads are bounded. Local processes and installed extensions are trusted; origin filtering is not authentication. Do not expose this port through a tunnel or public proxy.

After updating code, restart the bridge server, reload the unpacked extension, and reconnect MCP clients. Existing running processes do not pick up source changes automatically. For authentication challenges, `chrome_wait_for_user` displays an in-tab checkpoint and waits for the user.

## Development

The only runtime dependency is `ws`. Tests exercise HTTP/WebSocket routing, MCP stdio negotiation and errors, transport deadlines, connection replacement, workflow validation and partial failures, and pipeline navigation. CI is configured for Node 22/24 on Windows, Linux, and macOS. Real website behavior still requires live Chrome validation.

Contributions should include a reproducible case and the smallest relevant regression test. Performance claims should include environment, workload, samples, and p50/p95 results. Never include cookies, passwords, or private page contents in issue reports.

[MIT License](LICENSE)
