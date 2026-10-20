const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactToolResult, compactDom, compactPipeline } = require('../lib/compact-result');

test('compactDom preserves extracted values, trusted flags, and supports scroll', () => {
  const result = {
    ok: true,
    results: [
      { action: 'scroll', index: 0, ok: true },
      { action: 'click', index: 1, ok: true },
      { action: 'type', index: 2, ok: true, trusted: true },
      { action: 'extract', index: 3, ok: true, value: 'Hello World' },
      { action: 'wait', index: 4, ok: true }
    ]
  };
  const compacted = compactDom(result);
  assert.equal(compacted.ok, true);
  assert.equal(compacted.results.length, 2);
  assert.equal(compacted.results[0].action, 'type');
  assert.equal(compacted.results[0].trusted, true);
  assert.equal(compacted.results[1].action, 'extract');
  assert.equal(compacted.results[1].value, 'Hello World');
});

test('compactToolResult compacts browser.execute_workflow identically to chrome_workflow', () => {
  const workflowResult = {
    ok: true,
    progress: [
      { id: 's1', ok: true },
      { id: 's2', ok: true }
    ],
    results: {
      s1: { ok: true, results: [{ action: 'click', index: 0, ok: true }] },
      s2: { ok: true, results: [{ action: 'extract', index: 0, ok: true, value: 42 }] }
    },
    verification: { ok: true, results: [{ action: 'assert', index: 0, ok: true }] }
  };
  const compacted = compactToolResult('browser.execute_workflow', workflowResult);
  assert.equal(compacted.ok, true);
  assert.equal(compacted.progress, undefined);
  assert.equal(compacted.results.s1.results.length, 0);
  assert.equal(compacted.results.s2.results.length, 1);
  assert.equal(compacted.results.s2.results[0].value, 42);
});

test('compactToolResult compacts browser.execute_plan and filters successful checkpoints', () => {
  const planResult = {
    ok: true,
    planId: 'plan-123',
    checkpoints: [{ id: 'c1', ok: true }, { id: 'c2', ok: false, error: 'warn' }],
    results: {
      act1: { ok: true, results: [{ action: 'click', index: 0, ok: true }] }
    }
  };
  const compacted = compactToolResult('browser.execute_plan', planResult);
  assert.equal(compacted.ok, true);
  assert.equal(compacted.planId, 'plan-123');
  assert.equal(compacted.checkpoints.length, 1);
  assert.equal(compacted.checkpoints[0].id, 'c2');
  assert.equal(compacted.results.act1.results.length, 0);
});

test('compactToolResult trims chrome_list_tabs to lean tab objects', () => {
  const rawTabs = [
    { id: 1, index: 0, windowId: 10, title: 'Google', url: 'https://google.com', active: true, status: 'complete' },
    { id: 2, index: 1, windowId: 10, title: 'GitHub', url: 'https://github.com', active: false, status: 'complete' }
  ];
  const leanTabs = compactToolResult('chrome_list_tabs', rawTabs);
  assert.deepEqual(leanTabs, [
    { id: 1, title: 'Google', url: 'https://google.com', active: true },
    { id: 2, title: 'GitHub', url: 'https://github.com', active: false }
  ]);
});
