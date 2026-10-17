const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executePipeline } = require('../extension/pipeline');

test('pipeline follows new tabs and snapshots once without modifying the plan', async () => {
  const calls = [];
  const steps = [{ action: 'new_tab', params: { url: 'https://example.com' } }, { action: 'click', params: { target: '#go' } }];
  const original = JSON.stringify(steps);
  const result = await executePipeline({ steps }, {
    getTargetTab: async () => ({ id: 10 }),
    execute: async (action, params) => {
      calls.push({ action, params });
      return action === 'new_tab' ? { id: 20 } : action === 'snap' ? { compact: 'Ready' } : {};
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls[1].params.tabId, 20);
  assert.equal(calls[1].params.returnSnap, false);
  assert.equal(calls[2].params.tabId, 20);
  assert.equal(result.snapshot, 'Ready');
  assert.equal(JSON.stringify(steps), original);
});

test('pipeline preserves partial progress for thrown and structured failures', async () => {
  for (const thrown of [true, false]) {
    const calls = [];
    const result = await executePipeline({ steps: [{ action: 'click' }, { action: 'type' }, { action: 'click' }] }, {
      getTargetTab: async () => ({ id: 1 }),
      execute: async action => {
        calls.push(action);
        if (action === 'type') { if (thrown) throw new Error('Detached'); else return { ok: false }; }
        return {};
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedStep, 1);
    assert.equal(result.count, 1);
    assert.deepEqual(calls, ['click', 'type']);
  }
});

test('pipeline validates waits and nesting before executing anything', async () => {
  const deps = { getTargetTab: () => { throw new Error('Must not execute'); }, execute: () => {} };
  await assert.rejects(executePipeline({ steps: [{ action: 'click' }, { action: 'pipeline' }] }, deps), /nested/);
  await assert.rejects(executePipeline({ steps: [{ action: 'click' }, { action: 'wait', ms: 10001 }] }, deps), /Wait/);
});

test('duration waits are rejected before resolving a tab or mutating', async () => {
  await assert.rejects(executePipeline({ timeoutMs: 10, steps: [{ action: 'wait', ms: 100 }] }, {
    getTargetTab: async () => ({ id: 1 }), execute: async () => { throw new Error('Must not execute'); }
  }), /wait_for_element/);
});

test('pipeline fuses known fields and a terminal click, then respects navigation and tab boundaries', async () => {
  const calls = [];
  const result = await executePipeline({ returnSnap: false, steps: [
    { action: 'type', params: { selector: '#a', text: 'one' } },
    { action: 'type', params: { selector: '#b', text: 'two' } },
    { action: 'click', params: { selector: '#submit' } },
    { action: 'wait_for_element', params: { selector: '#next' } },
    { action: 'type', params: { selector: '#other', text: 'three', tabId: 2 } }
  ] }, {
    getTargetTab: async () => ({ id: 1 }),
    execute: async (action, params) => { calls.push({ action, params }); return {}; },
    executeDom: async params => { calls.push({ action: 'act', params }); return { ok: true, completed: params.steps.length }; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.count, 5);
  assert.deepEqual(calls.map(call => call.action), ['act', 'wait_for_element', 'type']);
  assert.equal(calls[0].params.steps.length, 3);
  assert.equal(calls[2].params.tabId, 2);
});

test('fused errors preserve original step indices and never run later mutations', async () => {
  const result = await executePipeline({ returnSnap: false, steps: [
    { action: 'navigate', params: { url: 'https://example.com' } },
    { action: 'type', params: { selector: '#a', text: 'one' } },
    { action: 'type', params: { selector: '#b', text: 'two' } },
    { action: 'click', params: { selector: '#submit' } }
  ] }, {
    getTargetTab: async () => ({ id: 1 }),
    execute: async action => { assert.equal(action, 'navigate'); return { id: 2 }; },
    executeDom: async params => { assert.equal(params.tabId, 2); return { ok: false, completed: 1, failedStep: 1, error: 'Detached' }; }
  });
  assert.equal(result.failedStep, 2);
  assert.equal(result.count, 2);
  assert.equal(result.results.length, 2);
});
