# Architecture

The language model belongs to the client. Codex, Antigravity, and Claude Code connect to the same newline-delimited MCP stdio adapter. Each adapter shares an HTTP transport implementation with the standalone CLI. A loopback HTTP server correlates requests over a persistent WebSocket to the Chrome MV3 service worker.

## Execution costs

Total task time is model planning + client/tool exchanges + bridge transport + Chrome execution + website response. The bridge can reduce exchanges and browser calls. It cannot remove network loading, human authentication, or model reasoning.

`chrome_act` serializes `runDomWorkflow` into one immediate Chrome `executeScript` call. It validates the plan before mutation, resolves unique targets across open shadow roots, executes native field updates, and waits on DOM conditions. MutationObserver wakes waits on DOM changes; requestAnimationFrame covers property-only updates and CSS transitions. Each wait has a deadline and releases its observer/frame callback when finished. Background tabs may throttle frames. A document-scoped root index avoids rediscovering unchanged shadow topology on each operation. Trusted typing is a deliberate exception to one injection: a rejected setter or `trusted:true` yields to CDP and resumes the uncompleted suffix, pinned to the original document and verified before further actions.

`chrome_pipeline` fuses compatible selector-based type/wait steps and a terminal click into one DOM injection. A legacy click ends the group because it can navigate. Other actions retain their browser handlers and tab propagation. Use an explicit `act` stage for arbitrary same-document action sequences. `fuseDom:false` is a low-level benchmark/control option. Duration-only `wait` steps are rejected; migrate them to `wait_for_element` or `act` state assertions. Pipeline nesting is rejected, and completed mutations are never automatically replayed.

`chrome_page_fetch` runs `fetch()` in the active page context and includes browser credentials where permitted. It is the direct data path when the task supplies or establishes the endpoint and method; browser origin and CORS rules still apply. The bridge does not discover or guess undocumented endpoints. MCP instructions favor this single call for known API data, batched extraction for known DOM data, and a single local workflow for deterministic multi-stage tasks.

`chrome_page_fetch_many` validates a bounded list of up to 20 requests in the extension worker, then injects one page function that dispatches the requests concurrently. Responses retain request labels and per-request HTTP/network errors; each text response is capped to the requested maximum (10,000 characters by default, 50,000 maximum). The aggregate result is unsuccessful if any request fails, without discarding successful sibling results. A single batch reduces MCP and page-injection round trips, but does not bypass same-origin/CORS policy or infer undocumented endpoints.

`chrome_api_sequence` handles dependent API calls in one page injection. Each request has a unique safe name; later URL/header/body fields can interpolate scalar or JSON values from earlier JSON responses. The executor is sequential, stops on the first HTTP/network error, and returns the completed prefix so the client does not need an intermediate model turn. The whole sequence shares one abort deadline and per-response size bound.

`chrome_api_catalog` merges the active document's Resource Timing entries with the debugger's request ring in one extension operation. This makes already-loaded page resources discoverable even when debugger attachment happened after navigation; DevTools-only details (method, status, allowlisted headers) are included when captured. The catalog redacts credential-like query parameters and excludes request bodies, cookies, and authorization headers. Resource Timing alone cannot reliably establish HTTP method or status, and browser timing privacy may omit cross-origin detail.

`chrome_run_page_script` uses `chrome.scripting.executeScript` with `world: MAIN` and `injectImmediately: true`, avoiding the debugger attach/Runtime.evaluate path for ordinary page JavaScript. It accepts a JSON argument object, awaits async results, and serializes/caps output before returning it. This is powerful page-context execution and must be restricted to code required by the user's task; it does not bypass site authorization or browser security policy.

`chrome_cdp_batch` resolves one target tab and attaches the debugger once, then runs up to 20 validated `domain.method` commands in order. It stops at the first protocol error and returns the completed prefix and failing index, so clients can resume without repeating prior commands. Each serialized result is capped (8,000 characters by default, 20,000 maximum) to bound MCP output and token use. Commands remain sequential because CDP operations may depend on earlier state changes; this optimizes bridge/model round trips without introducing unsafe command races.

`chrome_debug_bundle` reads the current tab's bounded network and console rings in one extension action. It reuses the existing debugger attachment and returns compact, independently filterable summaries in one result, avoiding separate model/tool cycles for routine diagnosis.

`chrome_act` injects immediately, before `document_idle`, then waits for its target in the document. `wait_for_element` also injects immediately and uses a `MutationObserver` to wake on DOM changes, with a bounded fallback for style or property changes. Its timeout returns `ok: false`, so a pipeline stops before dependent actions. Navigation registers its completion listener before reading tab status to avoid missing a completion event between those operations.

`chrome_watch` leaves one bounded `executeScript` call pending in the selected tab. A `MutationObserver` resolves it when the selected text, element count, or attribute changes. The caller receives a compact delta and can decide the next action, then call again to keep monitoring. It does not run an agent or send a response after the CLI session ends.

## Transport and compatibility

`lib/transport.js` provides HTTP/HTTPS keep-alive, TCP no-delay, bounded wall-clock request deadlines, and cleanup shared by MCP and CLI. No automatic retries are performed: connection loss after dispatch leaves the browser outcome uncertain. Transport timeouts include additional room for browser and human-checkpoint budgets.

MCP initialization negotiates supported protocol dates, advertises tools, and supplies execution instructions. Notifications receive no response. Parse errors, invalid envelopes, unknown methods, and tool errors use JSON-RPC/MCP responses. A compact tool profile reduces startup schema context while the default full profile preserves existing integrations. Standard output contains protocol messages only.

`lib/client-config.js` generates absolute Node and entrypoint paths, independent of the client's working directory. It prints configuration without rewriting user files. Codex uses TOML; Claude Code and Antigravity use `mcpServers` JSON. Antigravity configurations select the 14-tool `fast` profile: shorter model instructions, compound operations and compact successful DOM results. Extracted values and full failure checkpoints remain available. Other clients retain `compact`; the default full catalog remains compatible. Restart the client to load changed environment variables and schemas.

## Failure boundaries

Each pending server request belongs to its originating extension socket. A late reply or disconnect from a replaced socket cannot settle another socket's requests. Disconnection and send failures release associated timers. Rolling latency samples are bounded to 512 entries; request payloads and WebSocket messages are bounded to 16 MiB. `/metrics` holds the last 128 action names, timestamps, byte counts and timings, without inputs or page data. `node cli.js profile` summarizes call counts. Per-action server logging is opt-in through `BRIDGE_TRACE=1`.

Workflow errors preserve the completed prefix and failed step. This is a recovery checkpoint, not a transaction or rollback. A full navigation can terminate a DOM workflow before its response arrives. A synchronous script or previously dispatched Chrome action cannot be cancelled by a transport deadline. Inspect application state before resuming a consequential operation.

Do not run concurrent mutations against the same tab. This release does not add cross-client browser ownership or a distributed action scheduler. Independent reads can run concurrently; dependent mutations belong in one ordered workflow or pipeline.

## Verification

`npm test` uses Node's test runner, real HTTP/WebSocket connections with a simulated extension, and dependency-injected browser tests. These catch routing, protocol, deadline, ambiguity, interruption, and partial-progress regressions. They do not prove that a particular website accepts synthetic input. `npm run bench -- --mock` isolates transport overhead; live ping exercises the installed extension. Compare equivalent workloads and disclose what is excluded.
