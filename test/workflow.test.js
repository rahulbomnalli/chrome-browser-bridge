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

test('workflow cancellation stops only at the next stage boundary', async () => {
  let cancel = false;
  const calls = [];
  const result = await executeWorkflow({ stages: [stage('first'), stage('second')], verify }, {
    getTargetTab: async () => ({ id: 7 }),
    shouldCancel: () => cancel,
    execute: async action => {
      calls.push(action);
      cancel = true;
      return { ok: true };
    }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.failedStage, 'second');
  assert.equal(result.completed, 1);
  assert.deepEqual(calls, ['act']);
});

test('workflow reports action counts and timings without retries', async () => {
  const result = await executeWorkflow({ stages: [stage('first')], verify }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async () => ({ ok: true })
  });
  assert.equal(result.metrics.extensionActions, 2);
  assert.equal(result.metrics.retries, 0);
  assert.equal(result.metrics.actions.length, 2);
  assert.ok(result.metrics.actions.every(item => Number.isFinite(item.durationMs)));
});

test('if/else and bounded for_each execute locally with scoped value bindings', async () => {
  const calls = [];
  const workflow = {
    inputs: { fallback: 'fallback' },
    stages: [
      stage('items', 'act', { steps: [{ action: 'extract', selector: '#items' }] }),
      {
        id: 'branch', action: 'if',
        params: {
          condition: { selector: '#ready' },
          then: [stage('selected', 'act', { steps: [{ action: 'type', selector: '#target', value: '{{inputs.fallback}}' }] })],
          else: []
        }
      },
      {
        id: 'each', action: 'for_each',
        params: {
          items: '{{results.items.results.0.value}}',
          itemAs: 'row', maxIterations: 3,
          stages: [stage('fill', 'act', { steps: [{ action: 'type', selector: '#target', value: '{{vars.row}}' }] })]
        }
      }
    ],
    verify
  };
  const result = await executeWorkflow(workflow, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async (action, params) => {
      calls.push({ action, params });
      if (action === 'workflow_condition') return { matches: params.selector === '#ready' };
      if (params.steps?.[0]?.action === 'extract') return { ok: true, results: [{ value: ['A', 'B'] }] };
      return { ok: true, results: [] };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls.filter(call => call.params.steps?.[0]?.action === 'type').length, 3);
  assert.deepEqual(calls.filter(call => call.params.steps?.[0]?.action === 'type').map(call => call.params.steps[0].value), ['fallback', 'A', 'B']);
  assert.equal(result.results.each.count, 2);
});

test('bounded while loops stop on condition and reject unsafe or unbounded declarations', async () => {
  let checks = 0;
  let actions = 0;
  const result = await executeWorkflow({
    stages: [{
      id: 'poll', action: 'while',
      params: { condition: { selector: '#pending' }, maxIterations: 3, stages: [stage('step')] }
    }],
    verify
  }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async action => {
      if (action === 'workflow_condition') return { matches: ++checks < 3 };
      actions++;
      return { ok: true };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.poll.count, 2);
  assert.equal(actions, 3);
  await assert.rejects(executeWorkflow({
    stages: [{ id: 'loop', action: 'while', params: { condition: { selector: '#x' }, stages: [stage('run')] } }],
    verify
  }, { getTargetTab: async () => ({ id: 1 }), execute: async () => ({ ok: true }) }), /maxIterations/);
});

test('consequential stage requires an in-tab confirmation before dispatch', async () => {
  const calls = [];
  const result = await executeWorkflow({
    stages: [{ ...stage('submit'), requiresConfirmation: true }],
    verify
  }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async action => {
      calls.push(action);
      return action === 'wait_for_user' ? { success: true, resumed: true } : { ok: true };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['wait_for_user', 'act', 'act']);
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

test('bounded until loops repeat until condition becomes true', async () => {
  let attempts = 0;
  const calls = [];
  const result = await executeWorkflow({
    stages: [{
      id: 'paginate', action: 'until',
      params: {
        condition: { selector: '#last-page' },
        maxIterations: 5,
        stages: [stage('next_page', 'act', { steps: [{ action: 'click', selector: '#next' }] })]
      }
    }],
    verify
  }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async action => {
      calls.push(action);
      if (action === 'workflow_condition') return { matches: ++attempts >= 3 };
      return { ok: true };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.paginate.count, 2);
  assert.equal(calls.filter(c => c === 'act').length, 3); // 2 next clicks + 1 final verify
});

test('extract_collection, filter, and aggregate process structured data locally', async () => {
  const result = await executeWorkflow({
    stages: [
      {
        id: 'cards', action: 'extract_collection',
        params: {
          selector: '.product-card',
          fields: [
            { name: 'title', selector: '.title' },
            { name: 'price', selector: '.price' }
          ]
        }
      },
      {
        id: 'filtered', action: 'filter',
        params: {
          items: '{{results.cards.items}}',
          field: 'price',
          operator: 'gt',
          value: '50'
        }
      },
      {
        id: 'total_count', action: 'aggregate',
        params: {
          items: '{{results.filtered.items}}',
          op: 'count'
        }
      },
      {
        id: 'sum_prices', action: 'aggregate',
        params: {
          items: '{{results.filtered.items}}',
          op: 'sum',
          field: 'price'
        }
      },
      {
        id: 'titles', action: 'aggregate',
        params: {
          items: '{{results.filtered.items}}',
          op: 'join',
          field: 'title',
          delimiter: ' | '
        }
      }
    ],
    verify
  }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async (action, params) => {
      if (action === 'extract_collection') {
        return {
          ok: true, count: 3, items: [
            { title: 'Keyboard', price: '45' },
            { title: 'Monitor', price: '250' },
            { title: 'Mouse', price: '75' }
          ]
        };
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.filtered.count, 2);
  assert.equal(result.results.total_count.value, 2);
  assert.equal(result.results.sum_prices.value, 325);
  assert.equal(result.results.titles.value, 'Monitor | Mouse');
});

test('scroll, download, switch_tab, and inline assert execute cleanly', async () => {
  const calls = [];
  const result = await executeWorkflow({
    stages: [
      { id: 'scroll_down', action: 'scroll', params: { direction: 'down', amount: 800 } },
      { id: 'tab_switch', action: 'switch_tab', params: { tabId: 42 } },
      { id: 'dl', action: 'download', params: { url: 'https://example.com/report.pdf', filename: 'report.pdf' } },
      { id: 'inline_check', action: 'assert', params: { condition: { selector: '#ready' } } }
    ],
    verify
  }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async (action, params) => {
      calls.push({ action, params });
      if (action === 'workflow_condition') return { matches: true };
      if (action === 'switch_tab') return { tabId: 42 };
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.tabId, 42);
  assert.ok(calls.some(c => c.action === 'scroll' && c.params.amount === 800));
  assert.ok(calls.some(c => c.action === 'download_file' && c.params.url === 'https://example.com/report.pdf'));
});

test('bracket notation and array indices resolve in variable bindings', async () => {
  let typed = null;
  const result = await executeWorkflow({
    stages: [
      {
        id: 'fetch_list', action: 'act',
        params: { steps: [{ action: 'extract', selector: '.items' }] }
      },
      {
        id: 'use_item', action: 'act',
        params: {
          steps: [{ action: 'type', selector: '#input', value: '{{results.fetch_list.results[1].name}} count={{results.fetch_list.results.length}}' }]
        }
      }
    ],
    verify
  }, {
    getTargetTab: async () => ({ id: 7 }),
    execute: async (action, params) => {
      if (params.steps?.[0]?.action === 'extract') {
        return { ok: true, results: [{ name: 'Alpha' }, { name: 'Beta' }] };
      }
      if (params.steps?.[0]?.action === 'type') {
        typed = params.steps[0].value;
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(typed, 'Beta count=2');
});

