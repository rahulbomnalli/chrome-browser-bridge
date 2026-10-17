// Self-contained: Chrome serializes this function into the selected page.
async function runDomWorkflow(options) {
  const started = performance.now();
  const results = [];
  const steps = options.steps;
  const budget = options.timeoutMs ?? 10000;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Provide 1 to 100 steps');
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) throw new Error('Invalid workflow timeout');
  const supported = new Set(['click', 'type', 'select', 'wait', 'assert', 'extract']);
  // Validate the complete plan before performing any mutation.
  for (const step of steps) {
    if (!step || !supported.has(step.action)) throw new Error('Each step needs a supported action');
    const targets = ['selector', 'role', 'label', 'placeholder'].filter(key => step[key] !== undefined);
    if (targets.length !== 1 || typeof step[targets[0]] !== 'string' || !step[targets[0]]) throw new Error('Each step needs exactly one nonempty selector, role, label, or placeholder');
    if (step.name !== undefined && (targets[0] !== 'role' || typeof step.name !== 'string' || !step.name)) throw new Error('name requires a role target');
    if (step.selector) document.querySelectorAll(step.selector); // Reject malformed selectors before starting.
    if (['type', 'select'].includes(step.action) && typeof step.value !== 'string') throw new Error('type/select require a string value');
  }
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName?.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag !== 'input') return null;
    const type = (el.type || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (['checkbox', 'radio'].includes(type)) return type;
    return type === 'hidden' ? null : 'textbox';
  }
  function accessibleName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    const referenced = labelledBy?.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    return el.getAttribute('aria-label') || referenced || [...(el.labels || [])].map(label => label.textContent).join(' ') ||
      el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.value || el.textContent || '';
  }
  function candidates(step) {
    if (step.selector) return document.querySelectorAll(step.selector);
    if (step.role) {
      const controls = document.querySelectorAll('[role], button, a[href], input, textarea, select, [contenteditable="true"]');
      return [...controls].filter(el => roleOf(el) === normalize(step.role) && (step.name === undefined || normalize(accessibleName(el)) === normalize(step.name)));
    }
    if (step.placeholder) return [...document.querySelectorAll('[placeholder]')].filter(el => normalize(el.getAttribute('placeholder')) === normalize(step.placeholder));
    const labels = [...document.querySelectorAll('label')].filter(el => normalize(el.textContent) === normalize(step.label));
    const controls = labels.map(el => el.control || (el.htmlFor && document.getElementById(el.htmlFor)) || el.querySelector('input, textarea, select, [contenteditable="true"]')).filter(Boolean);
    const ariaControls = [...document.querySelectorAll('input[aria-label], textarea[aria-label], select[aria-label], [contenteditable="true"][aria-label]')].filter(el => normalize(el.getAttribute('aria-label')) === normalize(step.label));
    return [...new Set([...controls, ...ariaControls])];
  }
  const targetName = step => step.selector || step.label || step.placeholder || `${step.role}${step.name ? `: ${step.name}` : ''}`;
  function resolve(step) {
    const matches = [...candidates(step)].filter(el => {
      if (!el.isConnected || !el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    if (matches.length > 1) throw new Error(`Ambiguous target: ${targetName(step)} (${matches.length} matches)`);
    const el = matches[0];
    if (!el) return null;
    if (step.text !== undefined && !el.textContent.includes(step.text)) return null;
    if (step.equals !== undefined && String('value' in el ? el.value : el.textContent) !== step.equals) return null;
    if (['click', 'type', 'select'].includes(step.action) && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return null;
    return el;
  }
  async function ready(step) {
    const immediate = resolve(step);
    if (immediate) return immediate;
    const remaining = budget - (performance.now() - started);
    if (remaining <= 0) throw new Error(`Deadline waiting for ${targetName(step)}`);
    return new Promise((resolvePromise, reject) => {
      let observer;
      const cleanup = () => { clearTimeout(timer); clearInterval(poll); observer?.disconnect(); };
      const check = () => {
        try { const el = resolve(step); if (el) { cleanup(); resolvePromise(el); } }
        catch (error) { cleanup(); reject(error); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Deadline waiting for ${targetName(step)}`)); }, remaining);
      // Property-only updates and visibility changes need a bounded fallback.
      const poll = setInterval(check, 50);
      observer = new MutationObserver(check);
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      check();
    });
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    try {
      if (performance.now() - started >= budget) throw new Error('Workflow deadline exceeded');
      const el = await ready(step);
      let value;
      switch (step.action) {
        case 'click': {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!hit || !(hit === el || el.contains(hit))) throw new Error(`Obstructed target: ${targetName(step)}`);
          el.click();
          break;
        }
        case 'type': {
          el.focus();
          if (el.isContentEditable) el.textContent = step.value;
          else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, step.value);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
        case 'select':
          if (!(el instanceof HTMLSelectElement) || ![...el.options].some(option => option.value === step.value && !option.disabled)) throw new Error('Select option unavailable');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, step.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        case 'extract':
          value = step.attribute === 'value' ? el.value : step.attribute ? el.getAttribute(step.attribute) : el.textContent;
          value = value == null ? null : String(value).slice(0, 8000);
          break;
      }
      results.push({ index, action: step.action, ok: true, ...(value !== undefined ? { value } : {}) });
    } catch (error) {
      return { ok: false, failedStep: index, completed: results.length, results, error: error.message, durationMs: performance.now() - started };
    }
  }
  return { ok: true, completed: results.length, results, durationMs: performance.now() - started };
}
if (typeof module !== 'undefined') module.exports = { runDomWorkflow };

// Self-contained for chrome.scripting.executeScript; DOM changes wake the wait immediately.
async function waitForVisibleElement(selector, text, timeoutMs = 10000) {
  if ((!selector || typeof selector !== 'string') && (!text || typeof text !== 'string')) throw new Error('Provide a selector or text');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) throw new Error('Invalid wait timeout');
  if (selector) document.querySelector(selector); // Reject malformed selectors before waiting.
  const started = performance.now();
  const needle = text?.toLowerCase();
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function find() {
    if (selector) {
      const el = document.querySelector(selector);
      if (visible(el)) return el;
    }
    if (!needle) return null;
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue?.toLowerCase().includes(needle) && visible(node.parentElement)) return node.parentElement;
    }
    return null;
  }
  const immediate = find();
  if (immediate) return { found: true, elapsedMs: performance.now() - started, tag: immediate.tagName, id: immediate.id };
  return new Promise(resolve => {
    let observer;
    const cleanup = () => { clearTimeout(timer); clearInterval(poll); observer?.disconnect(); };
    const check = () => {
      const el = find();
      if (!el) return;
      cleanup();
      resolve({ found: true, elapsedMs: performance.now() - started, tag: el.tagName, id: el.id });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, found: false, timeout: true, elapsedMs: performance.now() - started });
    }, timeoutMs);
    // CSS transitions and property-only updates do not always emit mutations.
    const poll = setInterval(check, 100);
    observer = new MutationObserver(check);
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    check();
  });
}

if (typeof module !== 'undefined') module.exports.waitForVisibleElement = waitForVisibleElement;

// One pending browser call replaces repeated snapshots while a client monitors a page.
async function watchDomChange(options) {
  const { selector, mode = 'text', attribute, timeoutMs = 20000 } = options;
  if (typeof selector !== 'string' || !selector) throw new Error('watch requires a CSS selector');
  if (!['text', 'count', 'attribute'].includes(mode)) throw new Error('Invalid watch mode');
  if (mode === 'attribute' && (typeof attribute !== 'string' || !attribute)) throw new Error('attribute mode requires an attribute name');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('Invalid watch timeout');
  document.querySelectorAll(selector); // Fail before starting the observer.
  const started = performance.now();
  function snapshot() {
    const nodes = [...document.querySelectorAll(selector)];
    const items = nodes.map(el => (mode === 'attribute' ? el.getAttribute(attribute) : el.textContent) || '').map(value => String(value).trim().slice(-1000));
    return { count: nodes.length, value: mode === 'count' ? nodes.length : items.join('\n').slice(-4000), items };
  }
  const initial = snapshot();
  const baseline = options.baseline === undefined ? initial.value : mode === 'count' ? Number(options.baseline) : String(options.baseline);
  if (mode === 'count' && !Number.isFinite(baseline)) throw new Error('Invalid count baseline');
  function changed(current) {
    const newText = mode === 'count' ? current.items.slice(baseline).slice(-10).join('\n') :
      typeof baseline === 'string' && current.value.startsWith(baseline) ? current.value.slice(baseline.length) : current.value;
    return { ok: true, changed: true, mode, count: current.count, previous: baseline, current: current.value, newText: newText.slice(-4000), elapsedMs: performance.now() - started };
  }
  if (initial.value !== baseline) return changed(initial);
  return new Promise(resolve => {
    let observer;
    let queued = false;
    let done = false;
    const cleanup = () => { clearTimeout(timer); observer?.disconnect(); };
    const check = () => {
      if (done) return;
      const current = snapshot();
      if (current.value === baseline) return;
      done = true;
      cleanup();
      resolve(changed(current));
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ ok: false, changed: false, timeout: true, current: initial.value, elapsedMs: performance.now() - started });
    }, timeoutMs);
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; check(); });
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: mode === 'attribute' });
    check(); // Close the gap between the first snapshot and observer registration.
  });
}

if (typeof module !== 'undefined') module.exports.watchDomChange = watchDomChange;
