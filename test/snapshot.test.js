const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const start = source.indexOf('function inPageGetCompactSnapshot() {');
const end = source.indexOf('\nfunction inPageClick(', start);
const snapshotSource = source.slice(start, end);

test('compact snapshot reads each candidate layout once and prioritizes the viewport', () => {
  const counters = { rects: 0, labels: 0 };
  function element(id, top, label) {
    return {
      id, tagName: 'BUTTON', type: 'button', value: '',
      get innerText() { counters.labels++; return label; },
      getBoundingClientRect() { counters.rects++; return { top, width: 80, height: 20 }; },
      getAttribute() { return null; },
      matches() { return false; },
      setAttribute(key, value) { this[key] = value; }
    };
  }
  const elements = [element('below', 1200, 'Below'), element('visible', 40, 'Visible'), element('above', -50, 'Above')];
  const context = {
    document: { title: 'Example', querySelectorAll: () => elements },
    window: { innerHeight: 800, location: { href: 'https://example.com/' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    CSS: { escape: value => value }
  };
  const getSnapshot = vm.runInNewContext(`${snapshotSource}\ninPageGetCompactSnapshot`, context);
  const result = getSnapshot();
  assert.deepEqual(Array.from(result.items, item => item.n), ['Visible', 'Above', 'Below']);
  assert.equal(counters.rects, elements.length);
  assert.equal(counters.labels, elements.length);
  assert.equal(elements[1]['data-bridge-idx'], '1');
});
