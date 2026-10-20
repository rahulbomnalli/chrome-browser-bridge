const FAST_TOOLS = new Set([
  'chrome_list_tabs', 'chrome_smart_navigate', 'chrome_snap', 'chrome_act',
  'chrome_workflow', 'chrome_wait_for_user',
  'chrome_extract_many', 'chrome_page_fetch_many', 'chrome_api_sequence', 'chrome_parallel_scrape',
  'browser.execute_plan', 'browser.execute_workflow', 'browser.cancel_plan', 'browser.plan_status', 'browser.metrics',
  'chrome_run_page_script', 'chrome_evaluate', 'chrome_screenshot', 'chrome_read_page',
  'chrome_debug_bundle', 'chrome_download_file', 'chrome_watch', 'chrome_api_catalog',
  'chrome_switch_tab', 'chrome_new_tab', 'chrome_navigate', 'chrome_snapshot', 'chrome_click',
  'chrome_type', 'chrome_scroll', 'chrome_select', 'chrome_wait_for_element', 'chrome_dismiss_overlays'
]);
const FAST_DESCRIPTIONS = {
  chrome_act: 'PRIMARY BROWSER TOOL for same-page tasks: batch click, type, select, scroll, wait, assert, extract, and upload actions against unique targets in one call without intermediate turns.',
  chrome_workflow: 'PRIMARY BROWSER WORKFLOW ENGINE: Universal compound browser execution in one call: ordered navigation, multi-tab orchestration, branching (if/else), bounded loops (for_each/while/until), extraction, collection filtering/aggregation, downloads, uploads, {{inputs.x}}/{{results.id.path}} bindings, and final verify. Runs entirely locally inside Chrome.',
  'browser.execute_workflow': 'Universal high-level browser workflow engine: execute complex multi-step browser tasks in one call with ordered navigation, branching, bounded loops, forms, content extraction, dynamic page waits, final verification, and typed failure recovery.',
  chrome_snap: 'PRIMARY BROWSER INSPECT TOOL: Inspect unknown controls once in active Chrome page. Reuse the returned targets; skip if the latest response already has a usable snapshot.',
  chrome_list_tabs: 'List open Chrome tabs only when the target tab is unknown.',
  chrome_smart_navigate: 'PRIMARY BROWSER NAVIGATION TOOL: Open or reuse a URL in Chrome and return its snapshot. Automatically switches to existing tab if already open. Use workflow when later steps are already known.',
  chrome_wait_for_user: 'Universal in-tab checkpoint for user credentials, MFA, PIN, captcha or confirmation with audio chime. Automatically resumes when cleared.',
  chrome_extract_many: 'Extract several known selectors in one page call.',
  chrome_page_fetch_many: 'Fetch independent, known API endpoints concurrently in one call. Never guess endpoints; obey origin/CORS.',
  chrome_api_sequence: 'Run dependent, known API requests in one call using {{results.name.path}} bindings. Returns the completed prefix on failure; never guess endpoints.',
  chrome_parallel_scrape: 'Read known URLs concurrently in background tabs. Use for independent page research; returns per-URL results.',
  'browser.execute_plan': 'One bounded browser plan with idempotencyKey, per-tab queueing, permission checks, and durable stage checkpoints. Never replays after an uncertain result.',
  'browser.cancel_plan': 'Request stop at the next stage boundary. An in-flight action is not interrupted.',
  'browser.plan_status': 'Read persistent plan state by idempotency key. Never replays the task.',
  'browser.metrics': 'Read bounded MCP and bridge latency/success traces; model reasoning time is unavailable.',
  chrome_run_page_script: 'Inject async JS into page MAIN world with args and return JSON. Fastest execution for in-page APIs and window state without DOM clicking.',
  chrome_evaluate: 'Evaluate a JavaScript expression in the active page context and return the result immediately.',
  chrome_screenshot: 'Capture the visible Chrome tab when page layout or visual state matters.',
  chrome_read_page: 'Read clean headings and text from the active page without selector setup.',
  chrome_debug_bundle: 'Inspect bounded network and console events together for page diagnostics.',
  chrome_download_file: 'Download a known URL or data URI through Chrome.',
  chrome_watch: 'Wait for a selected page region to change without repeated snapshots.',
  chrome_api_catalog: 'Inspect already-observed page requests and resources; it does not guess API endpoints.',
  chrome_switch_tab: 'Switch to a known open tab by ID.',
  chrome_new_tab: 'Open a URL in a new Chrome tab.',
  chrome_navigate: 'Navigate the selected tab to a known URL.',
  chrome_snapshot: 'Return a detailed snapshot of the selected tab for grounding.',
  chrome_click: 'Click one known CSS selector. Use chrome_act to batch same-page actions.',
  chrome_type: 'Type into one known field selector. Use chrome_act to batch same-page actions.',
  chrome_scroll: 'Scroll the selected page up or down by a requested amount.',
  chrome_select: 'Select an option by value or visible text from a known select element.',
  chrome_wait_for_element: 'Wait for a selected element or text to become visible.',
  chrome_dismiss_overlays: 'Dismiss common cookie banners, dialogs, and overlays before interaction.'
};

function selectToolProfile(tools, compactNames, profile) {
  const names = profile === 'fast' || profile === undefined ? FAST_TOOLS : profile === 'compact' ? compactNames : null;
  return tools.filter(tool => !names || names.has(tool.name)).map(tool => profile === 'fast' && FAST_DESCRIPTIONS[tool.name]
    ? { ...tool, description: FAST_DESCRIPTIONS[tool.name] } : tool);
}
module.exports = { selectToolProfile, FAST_TOOLS };
