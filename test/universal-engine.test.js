const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeWorkflow } = require('../extension/workflow');
const { createPlanExecutor } = require('../extension/plan-executor');

const defaultVerify = [{ selector: '#app', text: 'Ready' }];

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

// 1. Search and Extract
test('universal engine: search and extract across dynamic result cards', async () => {
  const calls = [];
  const plan = {
    stages: [
      { id: 'open_search', action: 'navigate', params: { url: 'https://docs.test/search' } },
      { id: 'type_query', action: 'act', params: { steps: [{ action: 'type', selector: '#q', value: 'autonomous engine' }] } },
      {
        id: 'extract_cards', action: 'extract_collection', params: {
          itemSelector: '.result-card',
          fields: {
            title: '.title',
            snippet: '.desc',
            url: { selector: 'a', attribute: 'href' }
          }
        }
      },
      { id: 'check_count', action: 'assert', params: { condition: { selector: '.result-card' } } }
    ],
    verify: [{ selector: '.result-card' }]
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 10 }),
    execute: async (action, params) => {
      calls.push({ action, params });
      if (action === 'navigate') return { id: 10 };
      if (action === 'extract_collection') {
        return {
          ok: true,
          count: 3,
          items: [
            { title: 'Result 1', snippet: 'Fast autonomous engine', url: '/doc/1' },
            { title: 'Result 2', snippet: 'Deterministic execution', url: '/doc/2' },
            { title: 'Result 3', snippet: 'Universal bridge', url: '/doc/3' }
          ]
        };
      }
      if (action === 'workflow_condition') return { matches: true };
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.results.extract_cards.count, 3);
  assert.equal(result.results.extract_cards.items[0].title, 'Result 1');
  assert.ok(calls.some(c => c.action === 'extract_collection'));
});

// 2. Multi-page Navigation with Dynamic Variable Binding
test('universal engine: multi-page navigation with bound URLs', async () => {
  const navigatedUrls = [];
  const plan = {
    stages: [
      { id: 'list_page', action: 'navigate', params: { url: 'https://store.test/products' } },
      {
        id: 'get_first', action: 'act', params: {
          steps: [{ action: 'extract', selector: '.product-link', attribute: 'href' }]
        }
      },
      {
        id: 'detail_page', action: 'navigate', params: {
          url: 'https://store.test{{results.get_first.results.0.value}}'
        }
      },
      {
        id: 'get_specs', action: 'act', params: {
          steps: [{ action: 'extract', selector: '#product-specs' }]
        }
      }
    ],
    verify: [{ selector: '#product-specs' }]
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 12 }),
    execute: async (action, params) => {
      if (action === 'navigate') {
        navigatedUrls.push(params.url);
        return { id: 12 };
      }
      if (action === 'act' && params.steps[0].selector === '.product-link') {
        return { ok: true, results: [{ value: '/item/999' }] };
      }
      if (action === 'act' && params.steps[0].selector === '#product-specs') {
        return { ok: true, results: [{ value: 'In Stock - 64GB' }] };
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(navigatedUrls, ['https://store.test/products', 'https://store.test/item/999']);
  assert.equal(result.results.get_specs.results[0].value, 'In Stock - 64GB');
});

// 3. Repeated List Processing (for_each)
test('universal engine: repeated list processing across extracted collection', async () => {
  const processedItems = [];
  const plan = {
    stages: [
      {
        id: 'catalog', action: 'extract_collection', params: {
          itemSelector: '.row',
          fields: { id: '.item-id' }
        }
      },
      {
        id: 'process_each',
        action: 'for_each',
        params: {
          items: '{{results.catalog.items}}',
          itemAs: 'row',
          maxIterations: 10,
          stages: [
            {
              id: 'click_row',
              action: 'act',
              params: {
                steps: [{ action: 'click', selector: '#item-{{row.id}}' }]
              }
            }
          ]
        }
      }
    ],
    verify: defaultVerify
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 15 }),
    execute: async (action, params) => {
      if (action === 'extract_collection') {
        return {
          ok: true, count: 3,
          items: [{ id: '101' }, { id: '102' }, { id: '103' }]
        };
      }
      if (action === 'act' && params.steps?.[0]?.action !== 'assert') {
        processedItems.push(params.steps[0].selector);
        return { ok: true };
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(processedItems, ['#item-101', '#item-102', '#item-103']);
  assert.equal(result.results.process_each.iterations.length, 3);
});

// 4. Paginated Tables with until loop
test('universal engine: paginated table scraping with until condition', async () => {
  let currentPage = 1;
  const scrapedPages = [];

  const plan = {
    stages: [
      {
        id: 'paginate_table',
        action: 'until',
        params: {
          condition: { selector: '.next-btn[disabled]' },
          maxIterations: 5,
          stages: [
            {
              id: 'scrape_page',
              action: 'extract_collection',
              params: { selector: 'table tr.data', fields: [{ name: 'val', selector: 'td' }] }
            },
            {
              id: 'next_page',
              action: 'act',
              params: { steps: [{ action: 'click', selector: '.next-btn' }] }
            }
          ]
        }
      }
    ],
    verify: defaultVerify
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 18 }),
    execute: async (action, params) => {
      if (action === 'workflow_condition') {
        // Disabled when reaching page 3
        return { matches: currentPage >= 3 };
      }
      if (action === 'extract_collection') {
        scrapedPages.push(`page-${currentPage}`);
        return { ok: true, count: 2, items: [{ val: `data-${currentPage}` }] };
      }
      if (action === 'act' && params.steps?.[0]?.selector === '.next-btn') {
        currentPage++;
        return { ok: true };
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(scrapedPages, ['page-1', 'page-2']);
  assert.equal(result.results.paginate_table.iterations.length, 2);
});

// 5. Dynamic Forms with Multi-field Submission and Verification
test('universal engine: dynamic form filling and submission', async () => {
  const submittedFields = [];
  const plan = {
    stages: [
      {
        id: 'fill_form',
        action: 'act',
        params: {
          steps: [
            { action: 'type', selector: '#username', value: 'automation_agent' },
            { action: 'select', selector: '#role', value: 'administrator' },
            { action: 'check', selector: '#terms' },
            { action: 'click', role: 'button', name: 'Submit Application' }
          ]
        }
      },
      {
        id: 'verify_submission',
        action: 'assert',
        params: { condition: { selector: '.toast-success', text: 'Application Submitted' } }
      }
    ],
    verify: [{ selector: '.toast-success' }]
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 20 }),
    execute: async (action, params) => {
      if (action === 'act') {
        submittedFields.push(...params.steps.filter(s => s.action !== 'assert').map(s => s.action));
        return { ok: true, completed: 4 };
      }
      if (action === 'workflow_condition') return { matches: true };
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(submittedFields, ['type', 'select', 'check', 'click']);
  assert.equal(result.verified, true);
});

// 6. File Downloads and Uploads
test('universal engine: file download and file upload stages', async () => {
  const operations = [];
  const plan = {
    stages: [
      {
        id: 'fetch_asset',
        action: 'download',
        params: { url: 'https://files.test/export.csv', filename: 'export.csv' }
      },
      {
        id: 'upload_asset',
        action: 'act',
        params: {
          steps: [{ action: 'upload', selector: '#file-picker', files: [{ name: 'sample.pdf', text: 'PDF data' }] }]
        }
      }
    ],
    verify: defaultVerify
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 22 }),
    execute: async (action, params) => {
      operations.push({ action, params });
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.ok(operations.some(op => op.action === 'download_file' && op.params.filename === 'export.csv'));
  assert.ok(operations.some(op => op.action === 'act' && op.params.steps[0].action === 'upload'));
});

// 7. Multi-tab Switching and Cleanup
test('universal engine: multi-tab switching and lifecycle', async () => {
  const tabLog = [];
  const plan = {
    stages: [
      { id: 'switch_to_oauth', action: 'switch_tab', params: { tabId: 88 } },
      { id: 'auth_click', action: 'act', params: { steps: [{ action: 'click', selector: '#authorize' }] } },
      { id: 'close_oauth', action: 'close_tab', params: { tabId: 88 } }
    ],
    verify: defaultVerify
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 10 }),
    execute: async (action, params) => {
      tabLog.push({ action, tabId: params.tabId });
      if (action === 'switch_tab') return { ok: true, tabId: 88 };
      if (action === 'close_tab') return { ok: true };
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.tabId, 88);
  assert.ok(tabLog.some(t => t.action === 'switch_tab' && t.tabId === 88));
  assert.ok(tabLog.some(t => t.action === 'close_tab' && t.tabId === 88));
});

// 8. SPA Rerenders and Reactive Condition Waits
test('universal engine: reactive condition waits resolve dynamically', async () => {
  let conditionChecks = 0;
  const plan = {
    stages: [
      { id: 'trigger_render', action: 'act', params: { steps: [{ action: 'click', selector: '#load-spa' }] } },
      {
        id: 'wait_for_spa_view',
        action: 'wait_for_element',
        params: { selector: '#spa-rendered-view', timeoutMs: 5000 }
      }
    ],
    verify: [{ selector: '#spa-rendered-view' }]
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 30 }),
    execute: async (action) => {
      if (action === 'wait_for_element') {
        conditionChecks++;
        return { ok: true, found: true, elapsedMs: 14.5 };
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(conditionChecks, 1);
});

// 9. Network Errors and Autonomous Recovery Snapshot
test('universal engine: network failure stops execution, captures snapshot and details failed stage', async () => {
  const calls = [];
  const plan = {
    stages: [
      { id: 'stage_1', action: 'act', params: { steps: [{ action: 'click', selector: '#ok' }] } },
      { id: 'stage_fail', action: 'act', params: { steps: [{ action: 'click', selector: '#stale' }] } },
      { id: 'stage_never', action: 'act', params: { steps: [{ action: 'click', selector: '#after' }] } }
    ],
    verify: defaultVerify
  };

  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 40 }),
    execute: async (action, params) => {
      calls.push({ action, selector: params?.steps?.[0]?.selector });
      if (action === 'snap') return { compact: 'Error DOM state: element #stale detached' };
      if (params?.steps?.[0]?.selector === '#stale') {
        return { ok: false, error: 'Element #stale not found in document', failedStep: 0 };
      }
      return { ok: true };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedStage, 'stage_fail');
  assert.equal(result.completed, 1);
  assert.equal(result.snapshot, 'Error DOM state: element #stale detached');
  assert.ok(!calls.some(c => c.selector === '#after'));
});

// 10. Interrupted Workflows and Cooperative Cancellation
test('universal engine: cancellation halts execution cleanly between stages', async () => {
  let executedStages = 0;
  const storage = createStorage();
  let cancelTrigger;

  const executor = createPlanExecutor({
    storage,
    resolveTab: async () => ({ id: 50, url: 'https://app.test/' }),
    validateOrigins: async () => {},
    run: async (planParams, hooks) => {
      return executeWorkflow(planParams, {
        getTargetTab: async () => ({ id: 50 }),
        execute: async (action, params) => {
          if (hooks.shouldCancel()) {
            return { ok: false, error: 'Cancelled' };
          }
          executedStages++;
          if (executedStages === 1) {
            cancelTrigger();
          }
          return { ok: true };
        },
        shouldCancel: hooks.shouldCancel
      });
    }
  });

  cancelTrigger = () => executor.cancel('task-cancel-001');

  const result = await executor.execute({
    idempotencyKey: 'task-cancel-001-key',
    taskId: 'task-cancel-001',
    stages: [
      { id: 'step_1', action: 'act', params: { steps: [{ action: 'click', selector: '#step1' }] } },
      { id: 'step_2', action: 'act', params: { steps: [{ action: 'click', selector: '#step2' }] } },
      { id: 'step_3', action: 'act', params: { steps: [{ action: 'click', selector: '#step3' }] } }
    ],
    verify: defaultVerify
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.failedStage, 'step_2');
  const journalEntry = (await storage.get('bridge_plan_journal')).bridge_plan_journal['task-cancel-001-key'];
  assert.equal(journalEntry.state, 'cancelled');
});

// 11. Auth Checkpoint and Resumability
test('universal engine: auth checkpoint executes cleanly and marks progress', async () => {
  const plan = {
    stages: [
      { id: 'open_secure_page', action: 'navigate', params: { url: 'https://secure.test/dashboard' } },
      {
        id: 'user_checkpoint',
        action: 'checkpoint',
        params: { reason: 'Please confirm 2FA prompt in browser tab', timeoutSec: 30 }
      },
      {
        id: 'post_auth_action',
        action: 'act',
        params: { steps: [{ action: 'extract', selector: '#auth-token' }] }
      }
    ],
    verify: [{ selector: '#auth-token' }]
  };

  const executedActions = [];
  const result = await executeWorkflow(plan, {
    getTargetTab: async () => ({ id: 60 }),
    execute: async (action, params) => {
      executedActions.push(action);
      if (action === 'checkpoint') return { ok: true, confirmed: true };
      if (action === 'act') return { ok: true, results: [{ value: 'SECURE_TOKEN_XYZ' }] };
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(executedActions, ['navigate', 'checkpoint', 'act', 'act']);
  assert.equal(result.results.post_auth_action.results[0].value, 'SECURE_TOKEN_XYZ');
});

// 12. Safe Retry and Non-Idempotent Action Protection
test('universal engine: duplicate idempotent submission never replays side-effects', async () => {
  const storage = createStorage();
  let mutationCount = 0;

  const executor = createPlanExecutor({
    storage,
    resolveTab: async () => ({ id: 70, url: 'https://billing.test/' }),
    validateOrigins: async () => {},
    run: async (planParams, hooks) => {
      return executeWorkflow(planParams, {
        getTargetTab: async () => ({ id: 70 }),
        execute: async (action, params) => {
          if (action === 'act' && params?.steps?.[0]?.action !== 'assert') mutationCount++;
          return { ok: true };
        },
        onCheckpoint: hooks.onCheckpoint
      });
    }
  });

  const planSpec = {
    idempotencyKey: 'idempotent-order-001',
    stages: [
      { id: 'charge_card', action: 'act', params: { steps: [{ action: 'click', selector: '#charge-btn' }] } }
    ],
    verify: defaultVerify
  };

  const res1 = await executor.execute(planSpec);
  assert.equal(res1.ok, true);
  assert.equal(mutationCount, 1);

  // Re-submit identical plan with same idempotencyKey
  const res2 = await executor.execute(planSpec);
  assert.equal(res2.ok, true);
  assert.equal(res2.duplicate, true);
  assert.equal(res2.state, 'completed');
  // Mutation count MUST NOT increase
  assert.equal(mutationCount, 1);
});
