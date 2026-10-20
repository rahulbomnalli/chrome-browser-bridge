# Execution and Antigravity latency audit

This is a historical audit snapshot. Its tool-count references describe the catalog at the time of those measurements; the current default `fast` profile exposes 33 tools.

## What was slowing the task

Total latency is model planning + agent/tool exchanges + bridge dispatch + Chrome work + website response. Optimizing a few milliseconds of dispatch cannot eliminate seconds spent on repeated model turns.

The installed Antigravity configuration already used a persistent Node MCP process and the compact bridge profile. It also exposed a separate Chrome DevTools server. The installed browser skill was out of sync with the bridge: it advertised nonexistent tools (`chrome_task_dispatch`, `chrome_endpoint_registry`, `chrome_api_discover`) and unsupported `chrome_act` parameters (`recipe`, `batch`, `api`, `url`). That mismatch can cause invalid calls and recovery turns; a particular slow conversation was not replayed or traced end to end.

The global Antigravity bridge entry now selects `BRIDGE_TOOL_PROFILE=fast`. Its installed skill was replaced with the concise, schema-correct [execution instructions](antigravity-fast-skill.md). The other MCP server and model selection were preserved. Original configuration and skill backups are in the conversation scratch directory.

## Changes

| Area | Previous cost or failure | Current behavior |
| --- | --- | --- |
| Antigravity MCP | 25 bridge tools and long initialization instructions | 14 tools favoring complete workflows; shorter instructions; direct persistent MCP use |
| Model output context | Successful actions repeated every acknowledgement | Fast profile omits successful DOM acknowledgements while retaining completion counts, extracted values and failure details |
| `extension/pipeline.js` | Separate page injection for every legacy action | Compatible selector steps compile into one DOM action group; navigation and legacy clicks define boundaries |
| `extension/dom-workflow.js` | 50/100 ms polling fallbacks | Immediate mutation wakeups, render-frame checks and explicit deadlines |
| Native typing | Synthetic event acceptance assumed | Native setter plus composed events; immediate rejection or explicit trusted mode hands off to CDP and verifies before resuming |
| Target resolution | Repeated shadow discovery | Document-scoped, mutation-invalidated root index; selectors still revalidated against current DOM |
| Compact snapshots | DOM attribute writes for indices; no shadow/slot indexing | Single-pass shadow/slot discovery; source filtering; isolated-world element map; no index attribute writes; password values omitted |
| Tab and saved-plan lookup | Repeated browser/storage reads | Lifecycle-invalidated tab metadata and saved-plan caches |
| CDP | Only ordered command calls | Ordered default retained; explicit independent mode dispatches concurrently and reports all outcomes |
| Checkpoints | Repeated host calls every 500 ms | A bounded in-page observer/frame wait |
| Site helpers | Fixed delays between observations | Condition-based waits and frame synchronization; timeout timers remain |
| Media | No generic in-page file synthesis in the DOM runner | `upload` builds File/DataTransfer from text, base64, or Canvas without an external HTTP request |
| `server.js` | Per-action console output, no action-level metrics | Trace logging opt-in; bounded action/byte/timing metrics with no page content or input values |

## Measurements obtained before the request to stop testing

The live benchmark uses an ephemeral localhost page, a dedicated task tab, four field replacements and one click. It measures Node HTTP dispatch through the existing WebSocket server and installed extension to completion. Modes alternate order, with five warmups per mode.

| Run / mode | Samples | Median | p95 |
| --- | ---: | ---: | ---: |
| Original extension, sequential pipeline | 20 | 11.082 ms | 14.937 ms |
| First optimized run, sequential control | 40 | 11.483 ms | 15.171 ms |
| First optimized run, fused pipeline | 40 | 4.871 ms | 7.380 ms |
| Final measured run, sequential control | 40 | 24.356 ms | 32.088 ms |
| Final measured run, fused pipeline | 40 | 12.611 ms | 16.902 ms |

The paired runs reduced median pipeline dispatch time by 57.6% and 48.2%, respectively. Machine/browser scheduling changed absolute latency between runs. These measurements exclude Antigravity model reasoning, client startup, public website loads and human authentication. They do not establish a universal end-to-end time guarantee.

Real Chrome checks passed for rejected synthetic input falling back to trusted input, Shadow DOM targeting, slot deduplication, indexed shadow typing and page-local file synthesis. Fifty Node tests passed before the final compact-response/instruction edits. The user then requested no more testing; subsequent changes have not been tested.

Snapshot tradeoff: on a fixture with 1,500 inert spans, the old snapshot measured approximately 0.1 ms median and the shadow-aware walk approximately 0.4 ms. Serialized results were 669 versus 653 bytes, while the new walk included an additional shadow target. This improves coverage and avoids DOM writes; it does **not** demonstrate a 70% payload reduction or a faster cold traversal.

The isolated mock transport benchmark measured p50 2.140 ms and p95 3.053 ms over 100 samples. This is not a browser benchmark.

## Reproduce when testing is wanted

## Subsequent token reduction (not tested)

The MCP adapter now keeps structured results as tagged objects until the response boundary, avoiding the previous stringify/parse cycle. Tags distinguish structured primitive values from ordinary page text. The fast profile uses short descriptions for all 14 tools, omits routine successful pipeline acknowledgements and duplicate successful workflow progress, and retains extracted values, skipped stages, original step indices and failure details. Formatting failures fall back to the full result rather than reporting a completed action as failed.

The repository and installed Antigravity skill now use the same concise entrypoint. The longer manual is retained as `REFERENCE.md` and is read only when needed. No tests, benchmarks, or token-reduction measurements were run for these edits, per the user's instruction. Restart the Antigravity MCP session to load the updated adapter and skill.

## Reproduce when testing is wanted

```powershell
node scripts/benchmark-dom.js --samples 40 --verify
npm.cmd run bench -- --mock
node cli.js profile
```

`--output <absolute-artifact-path>` saves a benchmark report. `--baseline-snapshot <background.js-backup>` optionally compares snapshot implementations. The script closes its own fixture tab and server. Use a conversation artifact directory for output. `profile` needs the updated bridge server running.

## Boundaries and activation

- Restart `agy` to load its changed MCP environment and installed skill. Existing conversations can retain old schemas and earlier instructions.
- The extension was reloaded during live validation and again to activate final execution edits. The final edits were not tested after the user's stop-testing instruction.
- Automatic approval review blocked restarting the existing bridge server with “blocked by policy.” Its new metrics/logging code is saved but not active in that process. Start the updated server after stopping the old server through the normal launcher.
- No arbitrary sleep is needed for DOM readiness, but deadlines, reconnect backoff, heartbeat and visual animation timers remain necessary. Render frames can be throttled in background tabs.
- A full navigation destroys the injected document. A pipeline is one client request with multiple document-local batches, not a rollback transaction. The browser cannot undo a completed submission.
- CDP batching means one MCP request; Chrome's extension debugger API still sends separate commands. Concurrent mode is only for explicitly independent commands. It is not an unsupported JSON-RPC array sent as one CDP command.
- Compact JSON remains the wire format. The existing transport already uses keep-alive, TCP no-delay and no WebSocket compression. Adding a binary codec or persistent execution-context IDs was not justified by the measured transport cost; document-pinned continuations avoid stale-context reuse.
- The bridge cannot force a host model to plan well. Correct schemas, fewer alternatives, concise instructions and local workflow execution reduce avoidable exchanges; unexpected page states still need another decision.

## Task-focused defaults (not tested)

At the time of this audit, the server defaulted to `fast`, and generated Antigravity, Claude, and Codex configurations selected it explicitly. That profile then exposed fifteen task-oriented tools, including parallel URL research, batched extraction/API calls, validated idempotent plans, checkpoints, cancellation and bounded metrics, while removing overlapping pipeline/macro choices. The current `fast` profile has since expanded to 33 tools, including generic tab and page interaction controls. Initialization guidance and skills prioritize complete local plans and batched operations.

No tests, builds, browser checks, or benchmarks were run for these changes, as requested. Existing clients must regenerate or edit their MCP profile to `fast` and restart/refresh the MCP connection to load the new environment and tool catalog; saved conversations can retain older instructions.

Chrome documents serialized, self-contained injection functions and `injectImmediately` in its [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting). Its [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) defines individual command dispatch. Antigravity documents persistent MCP process configuration in its [CLI MCP guide](https://www.antigravity.google/docs/cli/mcp/).
