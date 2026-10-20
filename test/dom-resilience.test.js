const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runDomWorkflow } = require('../extension/dom-workflow');

test('universal step parameter resilience normalizes bare text, target, scroll, and value mappings', async t => {
  let clicked = false;
  let typedVal = '';
  let scrolled = false;

  const btn = {
    isConnected: true, tagName: 'BUTTON', textContent: 'Select Community',
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
    scrollIntoView() {}, contains: c => c === btn,
    click() { clicked = true; }
  };
  const inp = {
    isConnected: true, tagName: 'INPUT', type: 'text',
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
    focus() {}, dispatchEvent() {}, getAttribute: () => null,
    get value() { return typedVal; },
    set value(v) { typedVal = v; }
  };
  const scroller = {
    isConnected: true, tagName: 'BODY',
    getClientRects: () => [{}],
    scrollBy() { scrolled = true; }
  };

  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === '#inp') return [inp];
      if (selector.includes('body')) return [scroller];
      return [btn, inp, scroller];
    },
    elementFromPoint: () => btn,
    scrollingElement: scroller
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  globalThis.HTMLInputElement = class {};
  globalThis.HTMLTextAreaElement = class {};

  t.after(() => {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
    delete globalThis.HTMLInputElement;
    delete globalThis.HTMLTextAreaElement;
  });

  // 1. Bare text normalization: { action: 'click', text: 'Select Community' }
  const r1 = await runDomWorkflow({
    steps: [{ action: 'click', text: 'Select Community' }]
  });
  assert.equal(r1.ok, true);
  assert.equal(clicked, true);

  // 2. Bare target + text to value mapping: { action: 'type', target: '#inp', text: 'Universal Input' }
  const r2 = await runDomWorkflow({
    steps: [{ action: 'type', target: '#inp', text: 'Universal Input' }]
  });
  assert.equal(r2.ok, true);
  assert.equal(typedVal, 'Universal Input');

  // 3. Bare scroll action without selector: { action: 'scroll', direction: 'down', amount: 500 }
  const r3 = await runDomWorkflow({
    steps: [{ action: 'scroll', direction: 'down', amount: 500 }]
  });
  assert.equal(r3.ok, true);
  assert.equal(scrolled, true);
});
