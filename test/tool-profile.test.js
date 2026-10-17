const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FAST_TOOLS, selectToolProfile } = require('../lib/tool-profile');
test('fast profile favors complete plans while preserving compact and full profiles', () => {
  const tools = [...FAST_TOOLS, 'chrome_status', 'chrome_click'].map(name => ({ name, description: 'original', inputSchema: { type: 'object' } }));
  const compact = new Set([...FAST_TOOLS, 'chrome_status']);
  const fast = selectToolProfile(tools, compact, 'fast');
  assert.equal(fast.length, 14);
  assert.ok(fast.some(tool => tool.name === 'chrome_workflow'));
  assert.ok(!fast.some(tool => tool.name === 'chrome_click'));
  assert.match(fast.find(tool => tool.name === 'chrome_act').description, /all/);
  assert.equal(selectToolProfile(tools, compact, 'compact').length, 15);
  assert.equal(selectToolProfile(tools, compact, undefined).length, 16);
  assert.ok(tools.every(tool => tool.description === 'original'));
});
