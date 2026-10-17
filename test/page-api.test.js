const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/page-api.js'), 'utf8');

function createFetchMany(fetchImpl) {
  const context = {
    window: { fetch: fetchImpl },
    AbortController,
    setTimeout,
    clearTimeout
  };
  return vm.runInNewContext(`${source}\ninPageFetchMany`, context);
}

test('page API batch starts requests concurrently and correlates parsed results by name', async () => {
  const started = [];
  const fetchMany = createFetchMany(async (url, options) => {
    started.push(url);
    assert.equal(options.credentials, 'include');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ url })
    };
  });

  const result = await fetchMany({ requests: [
    { name: 'users', url: '/api/users' },
    { name: 'teams', url: '/api/teams' }
  ] });

  assert.deepEqual(started, ['/api/users', '/api/teams']);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.results.map(item => [item.name, item.data.url]))), [
    ['users', '/api/users'],
    ['teams', '/api/teams']
  ]);
});

test('page API batch preserves individual HTTP/network failures and bounds response text', async () => {
  const fetchMany = createFetchMany(async url => {
    if (url === '/network-error') throw new Error('offline');
    return {
      ok: url !== '/http-error',
      status: url === '/http-error' ? 503 : 200,
      statusText: url === '/http-error' ? 'Unavailable' : 'OK',
      text: async () => url === '/large' ? 'x'.repeat(300) : 'service unavailable'
    };
  });

  const result = await fetchMany({
    maxResponseChars: 256,
    requests: [
      { url: '/http-error' },
      { url: '/network-error' },
      { url: '/large' }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 503);
  assert.equal(result.results[1].error, 'offline');
  assert.equal(result.results[2].truncated, true);
  assert.equal(result.results[2].data.length, 256);
});

test('page API batch rejects invalid limits and missing URLs before dispatch', async () => {
  let calls = 0;
  const fetchMany = createFetchMany(async () => {
    calls++;
    throw new Error('Must not dispatch');
  });

  await assert.rejects(fetchMany({ requests: [] }), /1 to 20 requests/);
  await assert.rejects(fetchMany({ requests: [{ url: '' }] }), /requires a URL/);
  await assert.rejects(fetchMany({ requests: [{ url: '/api' }], timeoutMs: 120001 }), /Invalid page fetch timeout/);
  assert.equal(calls, 0);
});

test('page API batch aborts timed-out requests and reports the failure per request', async () => {
  const fetchMany = createFetchMany((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  }));

  const result = await fetchMany({ requests: [{ name: 'slow', url: '/api/slow' }], timeoutMs: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].name, 'slow');
  assert.match(result.results[0].error, /timed out after 5ms/);
});
