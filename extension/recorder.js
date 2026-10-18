// Workflow Recorder for chrome-browser-bridge
// Records user interactions in the active page, generates resilient semantic selectors,
// redacts sensitive credentials, creates variable placeholders, and exports a validated chrome_workflow plan.

function escapeCss(str) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
  return String(str).replace(/["\\]/g, '\\$&');
}

function getSemanticSelector(el) {
  if (!el || el.nodeType !== 1) return null;

  // 1. Check data-testid or data-cy (highest stability)
  for (const attr of ['data-testid', 'data-cy', 'data-test', 'data-qa']) {
    if (el.hasAttribute && el.hasAttribute(attr)) {
      const val = el.getAttribute(attr);
      return `[${attr}="${escapeCss(val)}"]`;
    }
  }

  // 2. Check id if not dynamic / auto-generated
  if (el.id && !/^[0-9]|[:._\d]{6,}|ember\d+|react-|vue-|ng-/.test(el.id)) {
    return `#${escapeCss(el.id)}`;
  }

  // 3. Form control specifics (name, placeholder, type)
  const tag = (el.tagName || '').toLowerCase();
  if (el.name && ['input', 'select', 'textarea'].includes(tag)) {
    return `${tag}[name="${escapeCss(el.name)}"]`;
  }
  if (el.getAttribute && el.getAttribute('placeholder')) {
    return `${tag}[placeholder="${escapeCss(el.getAttribute('placeholder'))}"]`;
  }

  // 4. Accessibility attributes (role, aria-label)
  const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
  if (ariaLabel) {
    return `[aria-label="${escapeCss(ariaLabel)}"]`;
  }
  const role = el.getAttribute ? el.getAttribute('role') : null;
  if (role && ['button', 'link', 'tab', 'menuitem'].includes(role)) {
    const text = (el.textContent || '').trim().slice(0, 30);
    if (text) return `[role="${escapeCss(role)}"]`;
  }

  // 5. Semantic tag with distinctive class or text
  if (['button', 'a'].includes(tag)) {
    const text = (el.textContent || '').trim();
    if (text && text.length <= 40 && !text.includes('\n')) {
      const classes = el.classList ? [...el.classList].filter(c => !/(active|focus|hover|selected|\d{4,})/i.test(c)) : [];
      if (classes.length) return `${tag}.${classes[0]}`;
      return `${tag}`;
    }
  }

  // 6. Minimal hierarchical path (max 3 levels)
  let path = [];
  let curr = el;
  while (curr && curr.nodeType === 1 && curr !== (typeof document !== 'undefined' ? document.body : null) && path.length < 3) {
    let segment = (curr.tagName || '').toLowerCase();
    if (curr.id && !/^[0-9]|[:._\d]{6,}/.test(curr.id)) {
      segment = `#${escapeCss(curr.id)}`;
      path.unshift(segment);
      break;
    }
    const cleanClasses = curr.classList ? [...curr.classList].filter(c => !/(active|focus|hover|selected|\d{4,})/i.test(c)) : [];
    if (cleanClasses.length) {
      segment += `.${cleanClasses[0]}`;
    }
    path.unshift(segment);
    curr = curr.parentElement;
  }
  return path.join(' > ') || tag;
}

function isSensitiveField(el) {
  if (!el) return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const name = (el.getAttribute('name') || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  const sensitivePatterns = /password|secret|token|api[-_]?key|credit[-_]?card|cc[-_]?number|cvv|cvc|ssn|otp|pin/i;
  return sensitivePatterns.test(type) || sensitivePatterns.test(name) || sensitivePatterns.test(id) || sensitivePatterns.test(autocomplete);
}

function createRecorder({ onRecipeReady = () => {} } = {}) {
  let recording = false;
  let recordedSteps = [];
  let initialUrl = '';
  let listenerDisposers = [];

  function start() {
    if (recording) return;
    recording = true;
    recordedSteps = [];
    initialUrl = typeof window !== 'undefined' ? window.location.href : '';

    if (typeof document === 'undefined') return;

    // Click tracker
    const clickHandler = (e) => {
      if (!recording) return;
      const target = e.target;
      if (!target || target.closest('[data-bridge-recorder-ui]')) return;
      const selector = getSemanticSelector(target);
      if (!selector) return;

      // Group or add
      recordedSteps.push({
        action: 'click',
        selector,
        tagName: target.tagName.toLowerCase(),
        timestamp: Date.now()
      });
    };

    // Input / Change tracker
    const changeHandler = (e) => {
      if (!recording) return;
      const target = e.target;
      if (!target || target.closest('[data-bridge-recorder-ui]')) return;
      const selector = getSemanticSelector(target);
      if (!selector) return;

      const sensitive = isSensitiveField(target);
      const val = target.value;
      const fieldName = target.name || target.id || 'value';
      const placeholder = sensitive ? `{{inputs.${fieldName}}}` : val;

      recordedSteps.push({
        action: 'type',
        selector,
        value: placeholder,
        sensitive,
        fieldName,
        timestamp: Date.now()
      });
    };

    document.addEventListener('click', clickHandler, true);
    document.addEventListener('change', changeHandler, true);

    listenerDisposers.push(() => {
      document.removeEventListener('click', clickHandler, true);
      document.removeEventListener('change', changeHandler, true);
    });
  }

  function stop() {
    if (!recording) return null;
    recording = false;
    for (const dispose of listenerDisposers) dispose();
    listenerDisposers = [];

    const recipe = generateWorkflowPlan(recordedSteps, initialUrl);
    onRecipeReady(recipe);
    return recipe;
  }

  function getSteps() {
    return [...recordedSteps];
  }

  return { start, stop, getSteps, isRecording: () => recording };
}

function generateWorkflowPlan(rawSteps, initialUrl = '') {
  const stages = [];
  const inputs = {};
  let stageIdx = 1;

  if (initialUrl && initialUrl !== 'about:blank') {
    stages.push({
      id: `navigate_initial`,
      action: 'navigate',
      params: { url: initialUrl }
    });
  }

  // Deduplicate and coalesce consecutive input steps on same selector
  const coalesced = [];
  for (const step of rawSteps) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.action === 'type' && step.action === 'type' && prev.selector === step.selector) {
      coalesced[coalesced.length - 1] = step;
    } else {
      coalesced.push(step);
    }
  }

  // Group adjacent DOM interactions into act stages
  let currentBatch = [];
  function flushBatch() {
    if (!currentBatch.length) return;
    stages.push({
      id: `stage_${stageIdx++}`,
      action: 'act',
      params: {
        steps: currentBatch.map(s => ({
          action: s.action,
          selector: s.selector,
          ...(s.value !== undefined ? { value: s.value } : {})
        }))
      }
    });
    currentBatch = [];
  }

  for (const step of coalesced) {
    if (step.sensitive && step.fieldName) {
      inputs[step.fieldName] = '';
    }
    currentBatch.push(step);
  }
  flushBatch();

  // Generate robust terminal verify assertions
  const verify = [];
  if (coalesced.length > 0) {
    const last = coalesced[coalesced.length - 1];
    verify.push({ selector: last.selector });
  } else {
    verify.push({ selector: 'body' });
  }

  return {
    description: `Recorded workflow recipe from ${new URL(initialUrl || 'http://localhost').hostname}`,
    inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
    stages,
    verify
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createRecorder, getSemanticSelector, isSensitiveField, generateWorkflowPlan };
}
