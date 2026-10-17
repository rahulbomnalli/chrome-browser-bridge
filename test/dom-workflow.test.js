const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runDomWorkflow, waitForVisibleElement, watchDomChange } = require('../extension/dom-workflow');

test('DOM workflows validate plans, stop on failure and preserve completed steps', async t => {
  let clicks = 0;
  const element = {
    isConnected: true, textContent: 'Ready', disabled: false,
    getClientRects: () => [{}], getAttribute: () => null,
    scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
    contains: candidate => candidate === element, click() { clicks++; }
  };
  const document = {
    querySelectorAll: selector => selector === '#missing' ? [] : selector === '.ambiguous' ? [element, element] : [element],
    elementFromPoint: () => element, documentElement: {}
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.document = document;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { delete globalThis.getComputedStyle; delete globalThis.document; delete globalThis.MutationObserver; });
  await assert.rejects(runDomWorkflow({ steps: [{ action: 'click', selector: '#go' }, { action: 'unknown', selector: '#go' }] }), /supported action/);
  assert.equal(clicks, 0);
  const result = await runDomWorkflow({ steps: [{ action: 'click', selector: '#go' }, { action: 'assert', selector: '.ambiguous' }, { action: 'click', selector: '#go' }] });
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 1);
  assert.equal(result.completed, 1);
  assert.equal(clicks, 1);
  const timed = await runDomWorkflow({ timeoutMs: 30, steps: [{ action: 'wait', selector: '#missing' }] });
  assert.equal(timed.ok, false);
  assert.match(timed.error, /Deadline/);
  document.elementFromPoint = () => null;
  const obstructed = await runDomWorkflow({ steps: [{ action: 'click', selector: '#go' }] });
  assert.match(obstructed.error, /Obstructed/);
});

test('typing uses the native setter and dispatches framework input events', async t => {
  const events = [];
  let setterCalls = 0;
  class Input {
    get value() { return this.current || ''; }
    set value(value) { this.current = value; setterCalls++; }
    getClientRects() { return [{}]; }
    getAttribute() { return null; }
    focus() {}
    dispatchEvent(event) { events.push(event.type); }
  }
  const field = new Input();
  field.isConnected = true;
  globalThis.document = { querySelectorAll: () => [field] };
  globalThis.HTMLInputElement = Input;
  globalThis.HTMLTextAreaElement = class {};
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  t.after(() => {
    for (const name of ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle']) delete globalThis[name];
  });
  const result = await runDomWorkflow({ steps: [
    { action: 'type', selector: '#query', value: 'browser bridge' },
    { action: 'assert', selector: '#query', equals: 'browser bridge' },
    { action: 'extract', selector: '#query', attribute: 'value' }
  ] });
  assert.equal(result.ok, true);
  assert.equal(setterCalls, 1);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(result.results[2].value, 'browser bridge');
});

test('element waits wake on DOM changes and report timeout as failure', async t => {
  let current = null;
  let wake;
  let disconnected = false;
  globalThis.document = { querySelector: () => current };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  globalThis.MutationObserver = class {
    constructor(callback) { wake = callback; }
    observe(target) { assert.equal(target, document); }
    disconnect() { disconnected = true; }
  };
  t.after(() => {
    for (const name of ['document', 'getComputedStyle', 'MutationObserver']) delete globalThis[name];
  });
  const waiting = waitForVisibleElement('#ready', undefined, 1000);
  current = { isConnected: true, tagName: 'BUTTON', id: 'ready', getBoundingClientRect: () => ({ width: 20, height: 20 }) };
  wake();
  assert.equal((await waiting).found, true);
  assert.equal(disconnected, true);
  current = null;
  const timed = await waitForVisibleElement('#missing', undefined, 10);
  assert.equal(timed.ok, false);
  assert.equal(timed.timeout, true);
});

test('text waits match visible text nodes without scanning every element', async t => {
  const parent = { isConnected: true, tagName: 'SPAN', id: 'label', getBoundingClientRect: () => ({ width: 80, height: 20 }) };
  let visited = 0;
  globalThis.document = {
    body: {},
    createTreeWalker() { return { nextNode() { visited++; return visited === 1 ? { nodeValue: 'Task ready', parentElement: parent } : null; } }; }
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = () => ({ display: 'inline', visibility: 'visible', opacity: '1' });
  t.after(() => {
    for (const name of ['document', 'NodeFilter', 'getComputedStyle']) delete globalThis[name];
  });
  const result = await waitForVisibleElement(null, 'ready', 100);
  assert.equal(result.found, true);
  assert.equal(result.id, 'label');
  assert.equal(visited, 1);
});

test('same-page workflow resolves exact role, label, and placeholder targets', async t => {
  const events = [];
  class Input {
    constructor() { this.isConnected = true; this.tagName = 'INPUT'; this.type = 'text'; }
    get value() { return this.current || ''; }
    set value(value) { this.current = value; }
    getAttribute(key) { return key === 'placeholder' ? 'Message' : null; }
    getClientRects() { return [{}]; }
    focus() {}
    dispatchEvent(event) { events.push(event.type); }
  }
  const input = new Input();
  const label = { textContent: 'Message', control: input };
  input.labels = [label];
  let clicks = 0;
  const button = {
    isConnected: true, tagName: 'BUTTON', textContent: 'Send',
    getAttribute(key) { return key === 'aria-label' ? 'Send' : null; },
    getClientRects() { return [{}]; },
    scrollIntoView() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; },
    contains(candidate) { return candidate === this; }, click() { clicks++; }
  };
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector.startsWith('[role]')) return [button, input];
      if (selector === '[placeholder]') return [input];
      if (selector === 'label') return [label];
      return [];
    },
    elementFromPoint: () => button
  };
  globalThis.HTMLInputElement = Input;
  globalThis.HTMLTextAreaElement = class {};
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  t.after(() => {
    for (const name of ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'getComputedStyle']) delete globalThis[name];
  });
  const result = await runDomWorkflow({ steps: [
    { action: 'type', label: 'Message', value: 'Hello' },
    { action: 'assert', placeholder: 'Message', equals: 'Hello' },
    { action: 'click', role: 'button', name: 'Send' }
  ] });
  assert.equal(result.ok, true);
  assert.equal(clicks, 1);
  assert.deepEqual(events, ['input', 'change']);
  const duplicate = { ...button, click() { clicks++; } };
  document.querySelectorAll = selector => selector.startsWith('[role]') ? [button, duplicate] : [];
  const ambiguous = await runDomWorkflow({ steps: [{ action: 'click', role: 'button', name: 'Send' }] });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /Ambiguous target/);
  assert.equal(clicks, 1);
});

test('DOM watcher returns new content on mutation and bounds an idle wait', async t => {
  const message = { textContent: 'first message' };
  let wake;
  globalThis.document = { querySelectorAll: () => [message] };
  globalThis.MutationObserver = class {
    constructor(callback) { wake = callback; }
    observe(target) { assert.equal(target, document); }
    disconnect() {}
  };
  t.after(() => { delete globalThis.document; delete globalThis.MutationObserver; });
  const waiting = watchDomChange({ selector: '.message', timeoutMs: 1000 });
  message.textContent = 'first message\nnew message';
  wake();
  const changed = await waiting;
  assert.equal(changed.ok, true);
  assert.equal(changed.newText, '\nnew message');
  const timed = await watchDomChange({ selector: '.message', mode: 'count', timeoutMs: 10 });
  assert.equal(timed.ok, false);
  assert.equal(timed.timeout, true);
  assert.equal(timed.current, 1);
  const resumed = await watchDomChange({ selector: '.message', mode: 'count', baseline: 0, timeoutMs: 10 });
  assert.equal(resumed.changed, true);
  assert.equal(resumed.newText, 'first message\nnew message');
});
