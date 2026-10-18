const FAST_TOOLS = new Set([
  'chrome_list_tabs', 'chrome_smart_navigate', 'chrome_snap', 'chrome_act',
  'chrome_workflow', 'chrome_wait_for_user',
  'chrome_extract_many', 'chrome_page_fetch_many', 'chrome_api_sequence', 'chrome_parallel_scrape',
  'browser.execute_plan', 'browser.cancel_plan', 'browser.plan_status', 'browser.metrics'
]);
const FAST_DESCRIPTIONS = {
  chrome_act: 'Known same-page task: batch click, type, select, scroll, wait, assert, extract, and upload actions against unique targets in one call without intermediate turns.',
  chrome_workflow: 'Universal compound workflow in one call: ordered navigation, multi-tab orchestration, branching (if/else), bounded loops (for_each/while/until), extraction, collection filtering/aggregation, downloads, uploads, {{inputs.x}}/{{results.id.path}} bindings, and final verify. Runs entirely locally inside Chrome.',
  chrome_snap: 'Inspect unknown controls once. Reuse the returned targets; skip if the latest response already has a usable snapshot.',
  chrome_list_tabs: 'List tabs only when the target tab is unknown.',
  chrome_smart_navigate: 'Open or reuse a URL and return its snapshot. Use workflow when the later steps are already known.',
  chrome_wait_for_user: 'Universal in-tab checkpoint for user credentials, MFA, PIN, captcha or confirmation with audio chime. Automatically resumes when cleared.',
  chrome_extract_many: 'Extract several known selectors in one page call.',
  chrome_page_fetch_many: 'Fetch independent, known API endpoints concurrently in one call. Never guess endpoints; obey origin/CORS.',
  chrome_api_sequence: 'Run dependent, known API requests in one call using {{results.name.path}} bindings. Returns the completed prefix on failure; never guess endpoints.',
  chrome_parallel_scrape: 'Read known URLs concurrently in background tabs. Use for independent page research; returns per-URL results.',
  'browser.execute_plan': 'One bounded browser plan with idempotencyKey, per-tab queueing, permission checks, and durable stage checkpoints. Never replays after an uncertain result.',
  'browser.cancel_plan': 'Request stop at the next stage boundary. An in-flight action is not interrupted.',
  'browser.plan_status': 'Read persistent plan state by idempotency key. Never replays the task.',
  'browser.metrics': 'Read bounded MCP and bridge latency/success traces; model reasoning time is unavailable.'
};

function selectToolProfile(tools, compactNames, profile) {
  const names = profile === 'fast' || profile === undefined ? FAST_TOOLS : profile === 'compact' ? compactNames : null;
  return tools.filter(tool => !names || names.has(tool.name)).map(tool => profile === 'fast' && FAST_DESCRIPTIONS[tool.name]
    ? { ...tool, description: FAST_DESCRIPTIONS[tool.name] } : tool);
}
module.exports = { selectToolProfile, FAST_TOOLS };
