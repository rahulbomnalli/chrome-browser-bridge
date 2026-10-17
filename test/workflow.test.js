const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeWorkflow, checkWorkflowCondition } = require('../extension/workflow');

const verify = [{ selector: '#done', text: 'Complete' }];
const stage = (id, action = 'act', params = { steps: [{ action: 'click', selector: '#go' }] }) => ({ id, action, params });

test('one submitted plan runs navigation, local branching, value transfer and final verification', async () => {
  const calls = [];
  const stages = [
    stage('open', 'navigate', { url: 'https://example.com' }),
    { ...stage('optional'), when: { selector: '#popup' } },
    stage('read', 'act', { steps: [{ action: 'extract', selector: '#code' }] }),
    stage('submit', 'act', { steps: [
      { action: 'type', label: 'Query', value: '{{inputs.query}} {{results.read.results.0.value}}' },
      { action: 'click', role: 'button', name: 'Search' }
    ] })
  ];
  const plan = { stages, inputs: { query: '$& literal' }, verify };
  const before = JSON.stringify(plan);
  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 1 }),
    execute: async (action, params) => {
      calls.push({ action, params });
      if (action === 'navigate') return { id: 2 };
      if (action === 'workflow_condition') return { matches: false };
      return { ok: true, results: [{ value: 'ABC' }] };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.tabId, 2);
  assert.equal(result.progress[1].skipped, true);
  assert.equal(calls[3].params.steps[0].value, '$& literal ABC');
  assert.equal(calls[4].params.steps[0].action, 'assert');
  assert.ok(calls.slice(1).every(call => call.params.tabId === 2));
  assert.ok(calls.every(call => call.params.returnSnap === false));
  assert.equal(calls.filter(call => call.action === 'snap').length, 0);
  assert.equal(JSON.stringify(plan), before);
});

test('failure stops the task, preserves partial mutations, and snapshots once for recovery', async () => {
  const calls = [];
  const result = await executeWorkflow({ stages: [stage('first'), stage('send'), stage('never')], verify }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async action => {
      calls.push(action);
      if (action === 'snap') return { compact: 'Failure context' };
      return calls.length === 2 ? { ok: false, completed: 1, failedStep: 1, error: 'Page changed' } : { ok: true };
    }
  });
  assert.equal(result.failedStage, 'send');
  assert.equal(result.completed, 1);
  assert.equal(result.failedResult.completed, 1);
  assert.equal(result.snapshot, 'Failure context');
  assert.deepEqual(calls, ['act', 'act', 'snap']);
});

test('verification failure cannot report task success', async () => {
  let calls = 0;
  const result = await executeWorkflow({ stages: [stage('submit')], verify }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async () => ++calls === 1 ? { ok: true } : { ok: false, error: 'No success state' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.failedStage, '$verify');
  assert.equal(result.completed, 1);
});

test('invalid plans fail before any browser action', async () => {
  const deps = { getTargetTab: () => { throw new Error('Browser must not run'); }, execute: () => {} };
  for (const plan of [
    { stages: [stage('ok')], verify: [] },
    { stages: [stage('ok'), stage('ok')], verify },
    { stages: [stage('ok'), stage('bad', 'workflow')], verify },
    { stages: [stage('ok')], verify: [{ action: 'click', selector: '#go' }] },
    { stages: [stage('ok')], verify, timeoutMs: -1 }
  ]) await assert.rejects(executeWorkflow(plan, deps), error => !error.message.includes('Browser must not run'));
});

test('missing or prototype input references stop before the affected mutation', async () => {
  for (const value of ['{{inputs.missing}}', '{{inputs.constructor}}']) {
    const calls = [];
    const result = await executeWorkflow({ stages: [stage('fill', 'act', { steps: [{ action: 'type', selector: '#query', value }] })], verify }, {
      getTargetTab: async () => ({ id: 1 }),
      execute: async action => { calls.push(action); return {}; }
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unresolved workflow value/);
    assert.deepEqual(calls, ['snap']);
  }
});

test('stage timeout is capped by remaining task budget', async () => {
  const budgets = [];
  await executeWorkflow({ timeoutMs: 1000, stages: [stage('wait', 'wait_for_element', { selector: '#ready', timeoutMs: 60000 })], verify }, {
    getTargetTab: async () => ({ id: 1 }),
    execute: async (_, params) => { budgets.push(params.timeoutMs); return { ok: true }; }
  });
  assert.ok(budgets.every(value => value > 0 && value <= 1000));
});

test('authentication checkpoint uses remaining task budget even without timeoutSec', async () => {
  let checkpoint;
  await executeWorkflow({ timeoutMs: 1000, stages: [stage('unlock', 'wait_for_user', { reason: 'Unlock app' })], verify }, {
    getTargetTab: async () => ({ id: 1 }),
    execute: async (action, params) => { if (action === 'wait_for_user') checkpoint = params; return { ok: true }; }
  });
  assert.ok(checkpoint.timeoutSec > 0 && checkpoint.timeoutSec <= 1);
});

test('conditions inspect visible DOM without clicking or waiting', t => {
  globalThis.document = { querySelectorAll: () => [{ isConnected: true, getClientRects: () => [{}], textContent: 'Optional panel' }] };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  t.after(() => { delete globalThis.document; delete globalThis.getComputedStyle; });
  assert.equal(checkWorkflowCondition({ selector: '#panel', text: 'Optional' }).matches, true);
  assert.equal(checkWorkflowCondition({ selector: '#panel', text: 'Missing', exists: false }).matches, true);
});
