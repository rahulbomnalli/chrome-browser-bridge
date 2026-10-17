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

test('pipeline cannot report a truncated wait as successful', async () => {
  const result = await executePipeline({ timeoutMs: 10, steps: [{ action: 'wait', ms: 100 }] }, {
    getTargetTab: async () => ({ id: 1 }), execute: async () => { throw new Error('Must not execute'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.match(result.error, /deadline/);
});
