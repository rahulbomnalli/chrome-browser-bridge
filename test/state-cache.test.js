const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTabCache, createStorageCache } = require('../extension/state-cache');
function event() { let callback; return { addListener(fn) { callback = fn; }, emit(...args) { callback(...args); } }; }
test('tab metadata is cached and invalidated on browser lifecycle events', async () => {
  let reads = 0;
  const tabs = { onUpdated: event(), onRemoved: event(), onReplaced: event(), onActivated: event(), get: async id => { reads++; return { id, url: 'first' }; } };
  const cache = createTabCache(tabs);
  await cache.get(7); await cache.get(7); assert.equal(reads, 1);
  tabs.onUpdated.emit(7, {}, { id: 7, url: 'next' });
  assert.equal((await cache.get(7)).url, 'next'); assert.equal(reads, 1);
  tabs.onRemoved.emit(7); await cache.get(7); assert.equal(reads, 2);
});
test('saved plans deduplicate cold reads and invalidate when storage changes', async () => {
  let reads = 0;
  const storage = { onChanged: event(), local: { get: async key => { reads++; return { [key]: { version: reads } }; } } };
  const cache = createStorageCache(storage);
  const pair = await Promise.all([cache.get('plans'), cache.get('plans')]);
  assert.equal(reads, 1); assert.equal(pair[0], pair[1]);
  storage.onChanged.emit({ plans: {} }, 'local');
  assert.equal((await cache.get('plans')).version, 2);
});
