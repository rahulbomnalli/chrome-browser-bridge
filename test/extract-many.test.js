const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const start = source.indexOf('function inPageExtractData(params) {');
const end = source.indexOf('\n// Alarm & Startup listeners', start);
const extractionFunctions = source.slice(start, end);

test('extract_many evaluates each selector and returns selector-specific errors in one page context', () => {
  const selectors = [];
  const document = {
    querySelectorAll(selector) {
      selectors.push(selector);
      if (selector === ':invalid') throw new Error('Invalid selector');
      return selector === 'h1'
        ? [{ innerText: 'Title', textContent: 'Title', outerHTML: '<h1>Title</h1>' }]
        : [{ innerText: 'Link', textContent: 'Link', getAttribute: name => name === 'href' ? '/target' : null }];
    }
  };
  const context = vm.createContext({ document });
  vm.runInContext(`${extractionFunctions}\nthis.extractMany = inPageExtractMany;`, context);

  const result = context.extractMany([
    { selector: 'h1' },
    { selector: 'a', attribute: 'href', multiple: false },
    { selector: ':invalid' }
  ]);

  assert.deepEqual(selectors, ['h1', 'a', ':invalid']);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].data[0], 'Title');
  assert.equal(result.results[1].data, '/target');
  assert.equal(result.results[2].error, 'Invalid selector');
});
