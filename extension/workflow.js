// Runs an AI-authored plan locally. No model calls and no automatic mutation retries.
async function executeWorkflow(plan, { getTargetTab, execute }) {
  const actions = new Set(['navigate', 'new_tab', 'act', 'wait_for_element', 'extract_data', 'read_page', 'native_click', 'wait_for_user']);
  const stages = plan.stages;
  const budget = plan.timeoutMs ?? 30000;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) throw new Error('Invalid workflow timeout');
  if (!Array.isArray(stages) || !stages.length || stages.length > 100) throw new Error('Workflow requires 1 to 100 stages');
  if (!Array.isArray(plan.verify) || !plan.verify.length || plan.verify.length > 100) throw new Error('Workflow requires final DOM assertions in verify');
  const ids = new Set();
  for (const stage of stages) {
    if (!stage || typeof stage.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(stage.id) || ids.has(stage.id) || ['__proto__', 'constructor', 'prototype'].includes(stage.id)) throw new Error('Stage ids must be unique simple names');
    ids.add(stage.id);
    if (!actions.has(stage.action)) throw new Error(`Unsupported workflow action: ${stage.action}`);
    if (!stage.params || typeof stage.params !== 'object' || Array.isArray(stage.params)) throw new Error('Stage params must be an object');
    if (stage.when && (typeof stage.when.selector !== 'string' || !stage.when.selector || (stage.when.exists !== undefined && typeof stage.when.exists !== 'boolean') || (stage.when.text !== undefined && typeof stage.when.text !== 'string'))) throw new Error('when requires a selector and optional exists/text');
    if (stage.action === 'act') validateTargets(stage.params.steps, false);
  }
  validateTargets(plan.verify, true);
  function validateTargets(steps, verification) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Provide 1 to 100 DOM steps');
    for (const step of steps) {
      if (!step || (verification ? step.action !== undefined && step.action !== 'assert' : !['click', 'type', 'select', 'wait', 'assert', 'extract'].includes(step.action))) throw new Error('Invalid DOM action; verify only permits assertions');
      const targets = ['selector', 'role', 'label', 'placeholder'].filter(key => step[key] !== undefined);
      if (targets.length !== 1 || typeof step[targets[0]] !== 'string' || !step[targets[0]]) throw new Error('DOM step requires exactly one target');
      if (['type', 'select'].includes(step.action) && typeof step.value !== 'string') throw new Error('type/select require a string value');
    }
  }
  const started = performance.now();
  let tabId = (await getTargetTab(plan.tabId)).id;
  const results = Object.create(null);
  const progress = [];
  let failedStage = null;
  let currentResult;
  function remaining() {
    const value = budget - (performance.now() - started);
    if (value <= 0) throw new Error('Workflow deadline exceeded');
    return Math.max(1, Math.floor(value));
  }
  function expand(value) {
    if (typeof value === 'string') return value.replace(/\{\{(inputs|results)\.([A-Za-z0-9_.]+)\}\}/g, (_, root, key) => {
      let found = root === 'inputs' ? plan.inputs : results;
      for (const part of key.split('.')) {
        if (['__proto__', 'constructor', 'prototype'].includes(part) || found == null || !Object.prototype.hasOwnProperty.call(found, part)) throw new Error(`Unresolved workflow value: ${root}.${key}`);
        found = found[part];
      }
      if (!['string', 'number', 'boolean'].includes(typeof found)) throw new Error('Workflow values must resolve to strings, numbers or booleans');
      return String(found);
    });
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
  }
  async function run(action, params) {
    const time = remaining();
    const requested = params.timeoutMs ?? (params.timeoutSec === undefined ? time : params.timeoutSec * 1000);
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('Invalid stage timeout');
    const bound = Math.min(time, requested);
    const result = await execute(action, { ...params, tabId: params.tabId ?? tabId, returnSnap: false,
      timeoutMs: bound, ...(params.timeoutSec !== undefined || action === 'wait_for_user' ? { timeoutSec: bound / 1000 } : {}) });
    currentResult = result;
    if (result?.ok === false || result?.success === false) throw new Error(result.error || `Stage action failed: ${action}`);
    return result;
  }
  try {
    for (const stage of stages) {
      failedStage = stage.id;
      currentResult = undefined;
      remaining();
      if (stage.when) {
        const condition = await run('workflow_condition', expand(stage.when));
        if (!condition.matches) { progress.push({ id: stage.id, skipped: true }); continue; }
      }
      const result = await run(stage.action, expand(stage.params));
      if (['navigate', 'new_tab'].includes(stage.action)) tabId = result?.tabId ?? result?.id ?? tabId;
      results[stage.id] = result;
      progress.push({ id: stage.id, ok: true });
    }
    failedStage = '$verify';
    currentResult = undefined;
    const verification = await run('act', { steps: expand(plan.verify).map(step => ({ ...step, action: 'assert' })) });
    return { ok: true, verified: true, tabId, completed: progress.length, progress, results, verification,
      durationMs: performance.now() - started };
  } catch (error) {
    // Report partial DOM progress. The caller must never replay a completed send/submit.
    const failedResult = currentResult;
    let snapshot = null;
    try { snapshot = (await execute('snap', { tabId })).compact; } catch {}
    return { ok: false, verified: false, tabId, failedStage, completed: progress.length, progress, results,
      failedResult, error: error.message, snapshot,
      recovery: 'Inspect failedResult for completed DOM steps. Resume only uncompleted actions; never replay a completed submission.',
      durationMs: performance.now() - started };
  }
}

// Conditions are immediate observations. Use a preceding wait stage for async UI.
function checkWorkflowCondition(condition) {
  const matches = [...document.querySelectorAll(condition.selector)].filter(el => {
    const style = getComputedStyle(el);
    return el.isConnected && el.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
      (condition.text === undefined || el.textContent.includes(condition.text));
  });
  return { matches: condition.exists === false ? matches.length === 0 : matches.length > 0, count: matches.length };
}
if (typeof module !== 'undefined') module.exports = { executeWorkflow, checkWorkflowCondition };
