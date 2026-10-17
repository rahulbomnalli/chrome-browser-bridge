const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const start = source.indexOf('async function waitForPageLoad(');
const end = source.indexOf('\nconst MAX_BUFFER_SIZE', start);
const waitSource = source.slice(start, end);

test('page load wait cannot miss completion during the status lookup', async () => {
  let listener;
  let removed = false;
  const chrome = { tabs: {
    onUpdated: {
      addListener(callback) { listener = callback; },
      removeListener(callback) { assert.equal(callback, listener); removed = true; }
    },
    get() {
      listener?.(42, { status: 'complete' });
      return Promise.resolve({ status: 'loading' });
    }
  } };
  const waitForPageLoad = vm.runInNewContext(`${waitSource}\nwaitForPageLoad`, { chrome, setTimeout, clearTimeout });
  await Promise.race([
    waitForPageLoad(42, 1000),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Missed completion')), 100))
  ]);
  assert.equal(removed, true);
});
