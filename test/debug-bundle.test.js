const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDebugBundle } = require('../extension/debug-bundle');

test('debug bundle filters and bounds network and console output', () => {
  const bundle = buildDebugBundle({
    networkEntries: [
      { requestId: '1', method: 'GET', url: '/api/users', status: 200 },
      { requestId: '2', method: 'POST', url: '/api/orders', status: 500 }
    ],
    consoleEntries: [
      { level: 'error', text: 'API call failed', stack: 'app.js:10\nnext' },
      { level: 'info', text: 'page ready' }
    ],
    filter: 'api',
    level: 'error',
    limit: 1
  });

  assert.equal(bundle.network.total, 2);
  assert.equal(bundle.network.count, 1);
  assert.equal(bundle.network.logs[0].url, '/api/orders');
  assert.equal(bundle.console.count, 1);
  assert.equal(bundle.console.logs[0].loc, 'app.js:10');
});

test('debug bundle rejects limits outside its bounded output contract', () => {
  assert.throws(() => buildDebugBundle({ networkEntries: [], consoleEntries: [], limit: 0 }), /between 1 and 50/);
});
