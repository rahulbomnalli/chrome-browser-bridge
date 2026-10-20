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

test('shadow DOM placeholder disambiguation resolves innermost input control over host components', async t => {
  let typedVal = '';
  const innerTextarea = {
    isConnected: true, tagName: 'TEXTAREA',
    getAttribute(k) { return k === 'placeholder' ? 'Join the discussion' : null; },
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 40 }),
    focus() {}, dispatchEvent() {},
    get value() { return typedVal; },
    set value(v) { typedVal = v; },
    parentNode: null
  };
  const hostComponent = {
    isConnected: true, tagName: 'CUSTOM-COMPOSER',
    getAttribute(k) { return k === 'placeholder' ? 'Join the discussion' : null; },
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    contains: () => false // standard Node.contains returns false across shadow boundaries
  };
  // Simulate shadow boundary: innerTextarea is inside host's shadowRoot
  const shadowRoot = { host: hostComponent };
  innerTextarea.parentNode = shadowRoot;

  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === '[placeholder]') return [hostComponent, innerTextarea];
      return [];
    }
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  globalThis.HTMLTextAreaElement = class {};
  globalThis.HTMLInputElement = class {};

  t.after(() => {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
    delete globalThis.HTMLTextAreaElement;
    delete globalThis.HTMLInputElement;
  });

  const res = await runDomWorkflow({
    steps: [{ action: 'type', placeholder: 'Join the discussion', value: 'Nested shadow input' }]
  });
  assert.equal(res.ok, true);
  assert.equal(typedVal, 'Nested shadow input');
});

test('icon button with screen-reader text handles obstruction hit-testing seamlessly', async t => {
  let clicked = false;
  const svgIcon = { tagName: 'SVG', getAttribute: () => null, closest() { return btn; } };
  const srSpan = {
    tagName: 'SPAN', textContent: 'Share',
    getAttribute: () => null, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 1, height: 1 }),
    closest(sel) { return sel.includes('button') ? btn : null; }
  };
  const btn = {
    isConnected: true, tagName: 'BUTTON', textContent: 'Share',
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 30 }),
    scrollIntoView() {}, click() { clicked = true; },
    contains(child) { return child === srSpan || child === svgIcon; },
    matches(sel) { return sel.includes('button'); },
    closest() { return null; }
  };
  srSpan.parentNode = btn;
  svgIcon.parentNode = btn;

  globalThis.document = {
    querySelectorAll(sel) {
      if (sel === '*') return [btn, srSpan];
      return [btn, srSpan];
    },
    // elementFromPoint hits the sibling SVG icon instead of the 1px span
    elementFromPoint: () => svgIcon
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });

  t.after(() => {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  });

  const res = await runDomWorkflow({
    steps: [{ action: 'click', text: 'Share' }]
  });
  assert.equal(res.ok, true);
  assert.equal(clicked, true);
});

