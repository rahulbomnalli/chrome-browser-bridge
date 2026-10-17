const FAST_TOOLS = new Set([
  'chrome_list_tabs', 'chrome_smart_navigate', 'chrome_snap', 'chrome_act',
  'chrome_workflow', 'chrome_pipeline', 'chrome_extract_many', 'chrome_run_page_script',
  'chrome_cdp_batch', 'chrome_wait_for_user', 'chrome_screenshot', 'chrome_watch',
  'chrome_run_macro', 'whatsapp_send_message'
]);
const FAST_DESCRIPTIONS = {
  chrome_act: 'Known same-page task: send all actions and final assertions/extraction together. Targets must be unique. type/select use value. text means contains; equals means exact value/text. No preliminary snapshot for known targets.',
  chrome_workflow: 'Across navigation: submit all stages and final verify once. Bind {{inputs.key}} or {{results.stageId.path}}. saveAs caches successful plans; name replays with fresh inputs. when is immediate; wait first for async UI.',
  chrome_pipeline: 'Ordered browser actions in one request. Use act for same-page groups. Use wait_for_element, not duration waits. returnSnap:false skips the final snapshot when actions already verify completion.',
  chrome_run_page_script: 'One async MAIN-world JS body with JSON args. Include dependent work and verification; return only needed data. Use established endpoints only. Execution has page privileges.',
  chrome_cdp_batch: 'Ordered CDP commands, bounded results, stop on failure. parallel:true executes ALL commands concurrently, including after failures; only use for independent commands.',
  chrome_snap: 'Inspect unknown controls once; reuse fresh @indices in a batch. Skip when a previous response already supplies the snapshot.',
  chrome_list_tabs: 'List tab IDs, titles and URLs when the target tab is unknown.',
  chrome_smart_navigate: 'Open or reuse a URL; returns a snapshot. Use workflow when navigation and subsequent actions are already known.',
  chrome_extract_many: 'Extract known CSS selectors in one injection. attribute: text (default), html, value, or an attribute name. Limit results to the requested data.',
  chrome_wait_for_user: 'Show an in-tab checkpoint and chime for authentication or required human input; resume on completion. Passwords belong in the page, never the response.',
  chrome_screenshot: 'Capture visual evidence when DOM information is insufficient; not a routine verification step.',
  chrome_watch: 'Wait for a selector change in text, count or attribute. baseline resumes observation; timeout is a checkpoint, not a change. Use only for requested monitoring.',
  chrome_run_macro: 'Replay a saved macro with variables. returnSnap:false skips the final snapshot when the macro verifies completion.',
  whatsapp_send_message: 'Find recipient, prepare/send WhatsApp text and check the result in one call. dryRun prepares without sending. Requires user authorization to send.'
};
function selectToolProfile(tools, compactNames, profile) {
  const names = profile === 'fast' ? FAST_TOOLS : profile === 'compact' ? compactNames : null;
  return tools.filter(tool => !names || names.has(tool.name)).map(tool => profile === 'fast' && FAST_DESCRIPTIONS[tool.name]
    ? { ...tool, description: FAST_DESCRIPTIONS[tool.name] } : tool);
}
module.exports = { selectToolProfile, FAST_TOOLS };
