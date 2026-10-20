const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FAST_TOOLS, selectToolProfile } = require('../lib/tool-profile');
test('fast profile favors complete plans while preserving compact and full profiles', () => {
  const tools = [...FAST_TOOLS, 'chrome_status', 'chrome_pipeline', 'chrome_run_macro', 'whatsapp_send_message']
    .map(name => ({ name, description: 'original', inputSchema: { type: 'object' } }));
  const compact = new Set([...FAST_TOOLS, 'chrome_status', 'chrome_pipeline', 'chrome_run_macro', 'whatsapp_send_message']);
  const fast = selectToolProfile(tools, compact, 'fast');
  assert.equal(fast.length, 33);
  assert.ok(fast.some(tool => tool.name === 'chrome_workflow'));
  assert.ok(fast.some(tool => tool.name === 'browser.execute_workflow'));
  assert.ok(!fast.some(tool => ['chrome_pipeline', 'chrome_run_macro', 'whatsapp_send_message'].includes(tool.name)));
  for (const name of [
    'chrome_parallel_scrape', 'chrome_extract_many', 'chrome_page_fetch_many', 'chrome_api_sequence',
    'chrome_screenshot', 'chrome_read_page', 'chrome_debug_bundle', 'chrome_download_file', 'chrome_watch', 'chrome_api_catalog',
    'chrome_switch_tab', 'chrome_new_tab', 'chrome_navigate', 'chrome_snapshot', 'chrome_click', 'chrome_type',
    'chrome_scroll', 'chrome_select', 'chrome_wait_for_element', 'chrome_dismiss_overlays'
  ]) {
    assert.ok(fast.some(tool => tool.name === name));
  }
  assert.ok(!fast.some(tool => ['chrome_pipeline', 'chrome_run_macro', 'whatsapp_send_message'].includes(tool.name)));
  assert.match(fast.find(tool => tool.name === 'chrome_act').description, /batch click/);
  assert.match(fast.find(tool => tool.name === 'chrome_screenshot').description, /visual state/);
  assert.equal(selectToolProfile(tools, compact, 'compact').length, 37);
  assert.equal(selectToolProfile(tools, compact, undefined).length, 33);
  assert.equal(selectToolProfile(tools, compact, 'full').length, 37);

  assert.ok(tools.every(tool => tool.description === 'original'));
});
