const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FAST_TOOLS, selectToolProfile } = require('../lib/tool-profile');
test('fast profile favors complete plans while preserving compact and full profiles', () => {
  const tools = [...FAST_TOOLS, 'chrome_status', 'chrome_click'].map(name => ({ name, description: 'original', inputSchema: { type: 'object' } }));
  const compact = new Set([...FAST_TOOLS, 'chrome_status']);
  const fast = selectToolProfile(tools, compact, 'fast');
  assert.equal(fast.length, 15);
  assert.ok(fast.some(tool => tool.name === 'chrome_workflow'));
  assert.ok(fast.some(tool => tool.name === 'browser.execute_workflow'));
  assert.ok(!fast.some(tool => ['chrome_pipeline', 'chrome_run_macro', 'whatsapp_send_message'].includes(tool.name)));
  for (const name of ['chrome_parallel_scrape', 'chrome_extract_many', 'chrome_page_fetch_many', 'chrome_api_sequence']) {
    assert.ok(fast.some(tool => tool.name === name));
  }
  assert.ok(!fast.some(tool => tool.name === 'chrome_click'));
  assert.match(fast.find(tool => tool.name === 'chrome_act').description, /batch click/);
  assert.equal(selectToolProfile(tools, compact, 'compact').length, 16);
  assert.equal(selectToolProfile(tools, compact, undefined).length, 15);
  assert.equal(selectToolProfile(tools, compact, 'full').length, 17);

  assert.ok(tools.every(tool => tool.description === 'original'));
});
