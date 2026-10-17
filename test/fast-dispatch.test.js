const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { executePipeline } = require('../extension/pipeline');
const { executeWorkflow } = require('../extension/workflow');
const { inPageFetchMany } = require('../extension/page-api');
const { executeCdpBatch } = require('../extension/cdp-batch');
const { buildDebugBundle } = require('../extension/debug-bundle');

const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const dispatch = source.slice(source.indexOf('async function handleActionInner('), source.indexOf('\nfunction inPageGetCompactSnapshot('));

function createDispatch(executeScript, local, debuggerMocks = {}) {
  const context = {
    chrome: {
      scripting: { executeScript },
      debugger: { sendCommand: debuggerMocks.sendCommand || (async (_target, method, params) => ({ method, params })) },
      storage: { local: local || { get: async () => ({ agent_macros: { fast: { steps: [{ action: 'click', params: { target: '#go' } }] } } }) } }
    },
    getTargetTab: async () => ({ id: 7 }), ensureDebuggerAttached: debuggerMocks.ensureDebuggerAttached || (async () => true), executePipeline, executeWorkflow,
    getNetworkBuffer: debuggerMocks.getNetworkBuffer || (() => ({ toArray: () => [] })),
    getConsoleBuffer: debuggerMocks.getConsoleBuffer || (() => ({ toArray: () => [] })),
    inPageFetchMany,
    executeCdpBatch,
    buildDebugBundle,
    runDomWorkflow() {},
    inPageClick() {}, inPageType() {}, inPageGetCompactSnapshot() {}, inPageSmartBatchFill() {},
    elementCache: new Map(), performance, setTimeout
  };
  return vm.runInNewContext(`${dispatch}\nhandleActionInner`, context);
}

test('ready DOM actions do not wait for document_idle', async () => {
  const requests = [];
  const run = createDispatch(async options => {
    requests.push(options);
    return [{ result: options.func.name === 'inPageGetCompactSnapshot' ? { items: [], title: 'Ready', url: 'https://example.com' } : { success: true } }];
  });
  for (const action of ['click', 'type', 'batch_fill', 'snap']) {
    await run(action, { returnSnap: false });
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every(options => options.injectImmediately === true));
});

test('page fetch batch validates its limits and executes one immediate page injection', async () => {
  const requests = [];
  const run = createDispatch(async options => {
    requests.push(options);
    return [{ result: { ok: true, results: [] } }];
  });
  const params = {
    requests: [{ name: 'users', url: '/api/users' }, { name: 'teams', url: '/api/teams' }],
    timeoutMs: 5000,
    maxResponseChars: 2048,
    tabId: 12
  };

  const result = await run('page_fetch_many', params);

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].func, inPageFetchMany);
  assert.deepEqual(requests[0].args[0].requests.map(request => request.name), ['users', 'teams']);
  assert.equal(requests[0].args[0].timeoutMs, 5000);
  assert.equal(requests[0].target.tabId, 7);
  assert.equal(requests[0].injectImmediately, true);
  await assert.rejects(run('page_fetch_many', { requests: [] }), /1 to 20 requests/);
  assert.equal(requests.length, 1);
});

test('CDP batch attaches once and executes one ordered command batch', async () => {
  const calls = [];
  let attachments = 0;
  const run = createDispatch(async () => [], undefined, {
    ensureDebuggerAttached: async () => { attachments++; return true; },
    sendCommand: async (target, method, params) => {
      calls.push({ target, method, params });
      return { method };
    }
  });
  const result = await run('cdp_batch', {
    commands: [{ method: 'Page.enable' }, { method: 'Runtime.evaluate', params: { expression: '1 + 1' } }],
    tabId: 7
  });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
  assert.deepEqual(result.results.map(item => item.method), ['Page.enable', 'Runtime.evaluate']);
  assert.equal(attachments, 1);
  assert.deepEqual(calls.map(call => call.method), ['Page.enable', 'Runtime.evaluate']);
  assert.ok(calls.every(call => call.target.tabId === 7));
});

test('debug bundle collects network and console data in one dispatch and attaches once', async () => {
  let attachments = 0;
  const run = createDispatch(async () => [], undefined, {
    ensureDebuggerAttached: async () => { attachments++; return true; },
    getNetworkBuffer: () => ({ toArray: () => [{ requestId: 'r1', url: '/api/users', method: 'GET', status: 200 }] }),
    getConsoleBuffer: () => ({ toArray: () => [{ level: 'error', text: 'API failed', stack: 'app.js:1' }] })
  });

  const result = await run('debug_bundle', { filter: 'api', level: 'error', limit: 5 });

  assert.equal(result.tabId, 7);
  assert.equal(attachments, 1);
  assert.equal(result.network.logs[0].url, '/api/users');
  assert.equal(result.console.logs[0].txt, 'API failed');
});

test('saved workflows replay templates with fresh inputs without storing runtime inputs', async () => {
  let saved = {};
  const values = [];
  const run = createDispatch(async options => {
    values.push(options.args[0].steps[0].value);
    return [{ result: { ok: true, completed: 1 } }];
  }, { get: async () => saved, set: async value => { saved = value; } });
  const plan = { saveAs: 'search', inputs: { query: 'first' },
    stages: [{ id: 'fill', action: 'act', params: { steps: [{ action: 'type', selector: '#query', value: '{{inputs.query}}' }] } }],
    verify: [{ selector: '#query', equals: '{{inputs.query}}' }] };
  const first = await run('workflow', plan);
  assert.equal(first.savedAs, 'search');
  assert.equal(saved.agent_workflows.search.inputs, undefined);
  assert.equal(saved.agent_workflows.search.stages[0].params.steps[0].value, '{{inputs.query}}');
  const replay = await run('workflow', { name: 'search', inputs: { query: 'second' } });
  assert.equal(replay.verified, true);
  assert.equal(values[0], 'first');
  assert.equal(values[2], 'second');
});

test('storage failure after successful actions preserves success to prevent replay', async () => {
  const run = createDispatch(async () => [{ result: { ok: true } }], {
    get: async () => ({}), set: async () => { throw new Error('Storage unavailable'); }
  });
  const result = await run('workflow', { saveAs: 'test',
    stages: [{ id: 'go', action: 'act', params: { steps: [{ action: 'click', selector: '#go' }] } }],
    verify: [{ selector: '#done' }] });
  assert.equal(result.verified, true);
  assert.equal(result.ok, true);
  assert.equal(result.saveError, 'Storage unavailable');
});

test('macro can skip the final snapshot and respects its execution budget', async () => {
  let injections = 0;
  const run = createDispatch(async () => { injections++; return [{ result: { success: true } }]; });
  const result = await run('run_macro', { name: 'fast', returnSnap: false, timeoutMs: 1000 });
  assert.equal(result.success, true);
  assert.equal(injections, 1);
  assert.equal(result.pipeline.snapshot, null);
  await assert.rejects(run('run_macro', { name: 'fast', timeoutMs: -1 }), /Invalid pipeline timeout/);
  assert.equal(injections, 1);
});
