// Self-contained: Chrome serializes this function into the selected page.
async function runDomWorkflow(options) {
  const started = performance.now();
  const results = [];
  const steps = options.steps;
  const budget = options.timeoutMs ?? 10000;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Provide 1 to 100 steps');
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) throw new Error('Invalid workflow timeout');
  const supported = new Set(['click', 'type', 'select', 'wait', 'assert', 'extract', 'upload', 'check', 'uncheck', 'scroll']);
  // Helper to parse and normalize Playwright pseudo-selectors and snapshot references
  function parsePlaywrightSelector(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (/^@\d+$/.test(s)) {
      return { type: 'snapshot', id: Number(s.slice(1)), raw: s, base: null };
    }
    // text="..." or text='...'
    let m = s.match(/^text=(?:"([^"]*)"|'([^']*)'|([^\s>+~]+))$/i);
    if (m) {
      return { type: 'text', base: '*', text: m[1] ?? m[2] ?? m[3], exact: false };
    }
    // :has-text("...")
    m = s.match(/^(.*?):has-text\((?:"([^"]*)"|'([^']*)')\)$/i);
    if (m) {
      return { type: 'has-text', base: m[1].trim() || '*', text: m[2] ?? m[3], exact: false };
    }
    // :text-is("...")
    m = s.match(/^(.*?):text-is\((?:"([^"]*)"|'([^']*)')\)$/i);
    if (m) {
      return { type: 'text-is', base: m[1].trim() || '*', text: m[2] ?? m[3], exact: true };
    }
    // :text("...")
    m = s.match(/^(.*?):text\((?:"([^"]*)"|'([^']*)')\)$/i);
    if (m) {
      return { type: 'has-text', base: m[1].trim() || '*', text: m[2] ?? m[3], exact: false };
    }
    return { type: 'css', base: s };
  }

  // Validate the complete plan before performing any mutation.
  for (const step of steps) {
    if (!step || !supported.has(step.action)) throw new Error('Each step needs a supported action');
    // Universal parameter resilience across all LLM models and websites:
    // A) If action is 'scroll' and no target is specified, default to scrollingElement or html/body
    if (step.action === 'scroll' && !step.selector && !step.role && !step.label && !step.placeholder) {
      step.selector = 'body';
    }
    // B) If step.value is missing for type/select, but step.text is provided, map text -> value
    if (['type', 'select'].includes(step.action) && step.value === undefined && typeof step.text === 'string') {
      step.value = step.text;
      delete step.text;
    }
    // C) If step has target but no selector/role/label/placeholder, map target -> selector
    if (!step.selector && !step.role && !step.label && !step.placeholder && typeof step.target === 'string' && step.target.trim()) {
      const t = step.target.trim();
      step.selector = (t.startsWith('@') || t.startsWith('#') || t.startsWith('.') || t.includes('[') || t.includes('>')) ? t : `text=${JSON.stringify(t)}`;
    }
    // D) If step has bare text without selector/role/label/placeholder, map text -> selector: text="<text>"
    if (!step.selector && !step.role && !step.label && !step.placeholder && typeof step.text === 'string' && step.text.trim()) {
      step.selector = `text=${JSON.stringify(step.text.trim())}`;
    }
    // E) If step has bare name without role/selector/label/placeholder, default role to 'button' for click, 'textbox' for type
    if (!step.selector && !step.role && !step.label && !step.placeholder && typeof step.name === 'string' && step.name.trim()) {
      step.role = step.action === 'type' ? 'textbox' : 'button';
    }

    const targets = ['selector', 'role', 'label', 'placeholder'].filter(key => step[key] !== undefined);
    if (targets.length !== 1) throw new Error('Each step needs exactly one nonempty selector, role, label, or placeholder');
    const targetVal = step[targets[0]];
    const isTargetValid = typeof targetVal === 'string' ? Boolean(targetVal) : (Array.isArray(targetVal) && targetVal.length > 0 && targetVal.every(t => typeof t === 'string' && Boolean(t)));
    if (!isTargetValid) throw new Error('Each step needs exactly one nonempty selector, role, label, or placeholder');
    if (step.name !== undefined && (targets[0] !== 'role' || typeof step.name !== 'string' || !step.name)) throw new Error('name requires a role target');
    if (step.selector) {
      const sels = Array.isArray(step.selector) ? step.selector : [step.selector];
      for (const sel of sels) {
        const parsed = parsePlaywrightSelector(sel);
        if (parsed && parsed.base && parsed.base !== '*' && parsed.type !== 'snapshot') {
          try {
            (document.createDocumentFragment?.() || document).querySelectorAll(parsed.base);
          } catch (e) {
            throw new Error(`Invalid CSS selector '${sel}': ${e.message}`);
          }
        }
      }
    }
    if (['type', 'select'].includes(step.action) && typeof step.value !== 'string') throw new Error('type/select require a string value');
    if (step.trusted !== undefined && (step.action !== 'type' || typeof step.trusted !== 'boolean')) throw new Error('trusted is only supported for type');
    if (step.action === 'upload') {
      if (!Array.isArray(step.files) || !step.files.length || step.files.length > 10) throw new Error('upload requires 1 to 10 files');
      for (const file of step.files) {
        if (!file || typeof file.name !== 'string' || !file.name ||
          [file.text, file.base64, file.canvas].filter(value => value !== undefined).length !== 1) throw new Error('Each file needs a name and one of text, base64, canvas');
        if (file.text !== undefined && (typeof file.text !== 'string' || file.text.length > 4000000)) throw new Error('Invalid file text');
        if (file.base64 !== undefined && (typeof file.base64 !== 'string' || file.base64.length > 5500000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))) throw new Error('Invalid file base64');
        if (file.canvas !== undefined && (!file.canvas || !Number.isInteger(file.canvas.width) || !Number.isInteger(file.canvas.height) || file.canvas.width < 1 || file.canvas.height < 1 || file.canvas.width * file.canvas.height > 4000000)) throw new Error('Invalid canvas size');
      }
    }
  }
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  let rootIndex = globalThis.__bridgeRootIndex;
  if (!rootIndex || rootIndex.document !== document) {
    rootIndex?.observer?.disconnect();
    rootIndex = { document, roots: null, dirty: false };
    rootIndex.observer = typeof MutationObserver === 'function' ? new MutationObserver(() => { rootIndex.dirty = true; }) : null;
    globalThis.__bridgeRootIndex = rootIndex;
  }
  const rootObserver = rootIndex.observer;
  function queryAll(selector) {
    if (rootObserver?.takeRecords?.().length) rootIndex.dirty = true;
    if (!rootIndex.roots || rootIndex.dirty) {
      const roots = rootIndex.roots = [document]; rootIndex.dirty = false;
      rootObserver?.disconnect();
      for (let i = 0; i < roots.length; i++) {
        rootObserver?.observe(roots[i], { childList: true, subtree: true });
        if (!document.createTreeWalker || typeof NodeFilter === 'undefined') continue;
        const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
          if (node.tagName === 'IFRAME') {
            try {
              const doc = node.contentDocument;
              if (doc && !roots.includes(doc)) roots.push(doc);
            } catch (_) {}
          }
        }
      }
    }
    return rootIndex.roots.flatMap(root => {
      try { return [...root.querySelectorAll(selector)]; } catch { return []; }
    });
  }
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
    if (step.selector) {
      const sels = Array.isArray(step.selector) ? step.selector : [step.selector];
      for (const sel of sels) {
        const parsed = parsePlaywrightSelector(sel);
        if (!parsed) continue;
        if (parsed.type === 'snapshot') {
          const el = globalThis.__bridgeTargets?.get(parsed.id);
          if (el?.isConnected) return [el];
          throw new Error(`Stale snapshot reference: ${sel}`);
        }
        let matched = queryAll(parsed.base || '*');
        if (parsed.text !== undefined) {
          const targetText = parsed.text;
          matched = matched.filter(el => {
            const content = (el.innerText || el.textContent || '').trim();
            if (parsed.exact) {
              return content === targetText || normalize(content) === normalize(targetText);
            }
            return content.includes(targetText) || normalize(content).includes(normalize(targetText));
          });
        }
        if (matched.length > 0) return matched;
      }
      return [];
    }
    if (step.role) {
      const controls = queryAll('[role], button, a[href], input, textarea, select, [contenteditable="true"]');
      return [...controls].filter(el => roleOf(el) === normalize(step.role) && (step.name === undefined || normalize(accessibleName(el)) === normalize(step.name)));
    }
    if (step.placeholder) return queryAll('[placeholder]').filter(el => normalize(el.getAttribute('placeholder')) === normalize(step.placeholder));
    const labels = queryAll('label').filter(el => normalize(el.textContent) === normalize(step.label));
    const controls = labels.map(el => el.control || (el.htmlFor && document.getElementById(el.htmlFor)) || el.querySelector('input, textarea, select, [contenteditable="true"]')).filter(Boolean);
    const ariaControls = queryAll('input[aria-label], textarea[aria-label], select[aria-label], [contenteditable="true"][aria-label]').filter(el => normalize(el.getAttribute('aria-label')) === normalize(step.label));
    return [...new Set([...controls, ...ariaControls])];
  }
  const targetName = step => (Array.isArray(step.selector) ? step.selector.join(' | ') : step.selector) || step.label || step.placeholder || `${step.role}${step.name ? `: ${step.name}` : ''}`;
  function resolve(step) {
    let matches = [...candidates(step)].filter(el => {
      if (!el.isConnected) return false;
      if (step.action === 'upload' && el.type === 'file') return true;
      if (!el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });

    // Semantic Disambiguation Engine: narrow candidates using all available constraints
    if (matches.length > 1) {
      // 1. Text constraint disambiguation
      if (step.text !== undefined) {
        const textMatches = matches.filter(el => (el.textContent || '').includes(step.text));
        const exactText = textMatches.filter(el => normalize(el.textContent) === normalize(step.text));
        if (exactText.length === 1) return exactText[0];
        if (exactText.length > 1) matches = exactText;
        else if (textMatches.length > 0) matches = textMatches;
      }

      // 1b. Innermost descendant priority (filter out wrapper containers like html, body, main, wrapper divs)
      if (matches.length > 1) {
        const innermost = matches.filter(el => !matches.some(child => child !== el && el.contains(child)));
        if (innermost.length === 1) return innermost[0];
        if (innermost.length > 1 && innermost.length < matches.length) matches = innermost;
      }

      // 2. Exact accessible name disambiguation
      if (step.name !== undefined) {
        const exactName = matches.filter(el => normalize(accessibleName(el)) === normalize(step.name));
        if (exactName.length === 1) return exactName[0];
        if (exactName.length > 1) matches = exactName;
      }

      // 3. Active open modal/dialog priority
      const openModal = document.querySelector?.('dialog[open], [role="dialog"], .modal.show, [aria-modal="true"]');
      if (openModal) {
        const inModal = matches.filter(el => openModal.contains(el));
        if (inModal.length === 1) return inModal[0];
        if (inModal.length > 1) matches = inModal;
      }

      // 4. Interactive enabled priority (filter out disabled/aria-disabled)
      const interactive = matches.filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.readOnly);
      if (interactive.length === 1) return interactive[0];
      if (interactive.length > 1 && interactive.length < matches.length) matches = interactive;

      // 5. Button tag specificity over wrapper divs
      if (step.action === 'click' || step.role === 'button') {
        const directButtons = matches.filter(el => {
          const tag = el.tagName?.toLowerCase();
          return tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button' || el.hasAttribute('tabindex');
        });
        if (directButtons.length === 1) return directButtons[0];
        if (directButtons.length > 1) matches = directButtons;
      }
    }

    if (matches.length > 1) {
      // Never guess among multiple potentially destructive targets
      const isDestructive = step.action === 'click' && /delete|remove|destroy|drop|terminate|wipe|clear|cancel/i.test(targetName(step) + ' ' + (matches[0].textContent || ''));
      if (isDestructive) {
        throw new Error(`Ambiguous destructive target: ${targetName(step)} (${matches.length} matches). Disambiguate before clicking.`);
      }
      const candidateList = matches.slice(0, 3).map(m => `<${m.tagName?.toLowerCase() || 'el'}${m.id ? '#' + m.id : ''}> "${(m.textContent || '').trim().slice(0, 25)}"`).join(', ');
      throw new Error(`Ambiguous target: ${targetName(step)} (${matches.length} matches: [${candidateList}])`);
    }

    const el = matches[0];
    if (!el) return null;
    if (step.text !== undefined && !(el.textContent || '').includes(step.text)) return null;
    if (step.equals !== undefined && String('value' in el ? el.value : el.textContent) !== step.equals) return null;
    if (['click', 'type', 'select', 'upload'].includes(step.action) && (el.disabled || el.getAttribute?.('aria-disabled') === 'true' || el.readOnly)) return null;
    return el;
  }
  async function ready(step) {
    const immediate = resolve(step);
    if (immediate) return immediate;
    const remaining = budget - (performance.now() - started);
    if (remaining <= 0) throw new Error(`Deadline waiting for ${targetName(step)}`);
    return new Promise((resolvePromise, reject) => {
      let observer, interval, done = false;
      const cleanup = () => {
        done = true;
        clearTimeout(timer);
        if (interval !== undefined) clearInterval(interval);
        observer?.disconnect();
      };
      const check = () => {
        if (done) return;
        try { const el = resolve(step); if (el) { cleanup(); resolvePromise(el); } }
        catch (error) { cleanup(); reject(error); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Deadline waiting for ${targetName(step)}`)); }, remaining);
      // Mutations wake immediately; throttled 100ms interval covers property-only changes and CSS transitions without CPU burn.
      observer = new MutationObserver(() => { rootIndex.dirty = true; check(); });
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      for (const root of rootIndex.roots || []) if (root !== document) observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      interval = setInterval(check, 100);
      check();
    });
  }
  if (options.resumeToken) {
    const pending = globalThis.__bridgeTrustedInput;
    delete globalThis.__bridgeTrustedInput;
    if (!pending || pending.token !== options.resumeToken || !pending.el.isConnected ||
        String(pending.el.isContentEditable ? pending.el.textContent : pending.el.value) !== pending.value) {
      return { ok: false, trustedInputFailed: true, completed: 0, failedStep: 0, results, error: 'Trusted input verification failed; inspect state before resuming' };
    }
  }
  if (options.verifyOnly) return { ok: true, completed: 0, results };
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
          const root = el.getRootNode?.() || document;
          const hit = (root.elementFromPoint ? root : document).elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          const isHitOk = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el) ||
            (root.host && (hit === root.host || hit.contains(root.host) || root.host.contains(hit)))));
          if (!isHitOk) throw new Error(`Obstructed target: ${targetName(step)}`);
          el.click();
          break;
        }
        case 'scroll': {
          const direction = step.direction || 'down';
          const amount = Number(step.amount ?? 400);
          const delta = direction === 'up' ? -amount : amount;
          const target = (el && el !== document.body && el !== document.documentElement) ? el : (document.scrollingElement || window);
          if (typeof target.scrollBy === 'function') target.scrollBy({ top: delta, behavior: 'smooth' });
          else window.scrollBy(0, delta);
          break;
        }
        case 'check':
        case 'uncheck': {
          const shouldCheck = step.action === 'check';
          if (el instanceof HTMLInputElement && el.type === 'checkbox') {
            if (el.checked !== shouldCheck) {
              el.checked = shouldCheck;
              el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
          } else {
            el.click();
          }
          break;
        }
        case 'type': {
          el.focus();
          if (!step.trusted && el.isContentEditable) {
            let execOk = false;
            try {
              const sel = window.getSelection ? window.getSelection() : null;
              if (sel) {
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(range);
              }
              execOk = document.execCommand && document.execCommand('insertText', false, step.value);
            } catch (_) {}
            if (!execOk) el.textContent = step.value;
          } else if (!step.trusted) {
            // Support React/Vue/Svelte/Angular controlled inputs via prototype setter + tracker reset
            const tracker = el._valueTracker;
            if (tracker) {
              tracker.setValue(tracker.getValue() === '' ? 'a' : '');
            }
            const isTextarea = el instanceof HTMLTextAreaElement || el.tagName?.toLowerCase() === 'textarea';
            const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (descriptor?.set) descriptor.set.call(el, step.value);
            else el.value = step.value;
          }
          if (!step.trusted) {
            try {
              el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: step.value }));
            } catch (_) {}
            try {
              el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: step.value }));
            } catch (_) {
              el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            }
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            await Promise.resolve(); // Allow synchronous framework reconciliation and queued microtasks.
          }
          const actualText = el.isContentEditable ? (el.textContent || '').trim() : String(el.value ?? '');
          const expectedText = el.isContentEditable ? step.value.trim() : step.value;
          if (step.trusted || actualText !== expectedText) {
            if (el.isContentEditable) {
              const range = document.createRange(); range.selectNodeContents(el);
              const selection = window.getSelection ? window.getSelection() : null;
              if (selection) { selection.removeAllRanges(); selection.addRange(range); }
            } else if (typeof el.select === 'function') {
              el.select();
            } else {
              try { el.focus(); document.execCommand('selectAll', false, null); } catch (_) {}
            }
            const token = crypto.randomUUID();
            globalThis.__bridgeTrustedInput = { token, el, value: step.value };
            return { ok: false, needsTrustedInput: true, token, failedStep: index, completed: results.length, results, durationMs: performance.now() - started };
          }
          break;
        }
        case 'select':
          if (!(el instanceof HTMLSelectElement) || ![...el.options].some(option => option.value === step.value && !option.disabled)) throw new Error('Select option unavailable');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, step.value);
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          break;
        case 'upload': {
          if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('upload requires a file input');
          if (!el.multiple && step.files.length > 1) throw new Error('File input does not allow multiple files');
          const transfer = new DataTransfer();
          for (const file of step.files) {
            let bytes = file.text;
            let type = file.type || 'text/plain';
            if (file.base64 !== undefined) { bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)); type = file.type || 'application/octet-stream'; }
            if (file.canvas) {
              const canvas = document.createElement('canvas');
              canvas.width = file.canvas.width; canvas.height = file.canvas.height;
              const ctx = canvas.getContext('2d'); ctx.fillStyle = file.canvas.color || '#000000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
              bytes = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
              if (!bytes) throw new Error('Canvas encoding failed');
              type = 'image/png';
            }
            transfer.items.add(new File([bytes], file.name, { type }));
          }
          if (performance.now() - started >= budget) throw new Error('Workflow deadline exceeded before upload');
          el.files = transfer.files;
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          value = { files: transfer.files.length };
          break;
        }
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
    let observer, interval, done = false;
    const cleanup = () => { done = true; clearTimeout(timer); if (interval !== undefined) clearInterval(interval); observer?.disconnect(); };
    const check = () => {
      if (done) return;
      const el = find();
      if (!el) return;
      cleanup();
      resolve({ found: true, elapsedMs: performance.now() - started, tag: el.tagName, id: el.id });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, found: false, timeout: true, elapsedMs: performance.now() - started });
    }, timeoutMs);
    // Mutations wake immediately; throttled 100ms interval checks for CSS/property updates.
    observer = new MutationObserver(check);
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    interval = setInterval(check, 100);
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
