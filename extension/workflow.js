// Runs an AI-authored plan locally. No model calls and no automatic mutation retries.
async function executeWorkflow(plan, { getTargetTab, execute, shouldCancel = () => false, onCheckpoint = async () => {} }) {
  const actions = new Set([
    'navigate', 'new_tab', 'switch_tab', 'close_tab',
    'act', 'wait_for_element', 'extract_data', 'extract_collection',
    'scroll', 'download', 'read_page', 'native_click', 'wait_for_user',
    'if', 'for_each', 'while', 'until', 'filter', 'aggregate', 'assert'
  ]);
  const stages = plan.stages;
  const budget = plan.timeoutMs ?? 30000;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) throw new Error('Invalid workflow timeout');
  if (!Array.isArray(stages) || !stages.length || stages.length > 100) throw new Error('Workflow requires 1 to 100 stages');
  if (!Array.isArray(plan.verify) || !plan.verify.length || plan.verify.length > 100) throw new Error('Workflow requires final DOM assertions in verify');
  let stageCount = 0;
  const ids = new Set();
  function validateStages(list, depth = 0) {
    if (!Array.isArray(list) || !list.length || list.length > 100 || depth > 5) throw new Error('Workflow branches require 1-100 stages and at most five nesting levels');
    for (const stage of list) {
      stageCount++;
      if (stageCount > 100) throw new Error('Workflow is limited to 100 declared stages');
      if (!stage || typeof stage.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(stage.id) || ids.has(stage.id) || ['__proto__', 'constructor', 'prototype'].includes(stage.id)) throw new Error('Stage ids must be unique simple names');
      for (const key of Object.keys(stage)) if (!['id', 'action', 'params', 'when', 'requiresConfirmation'].includes(key)) throw new Error(`Unsupported workflow stage field: ${key}`);
      ids.add(stage.id);
      if (!actions.has(stage.action)) throw new Error(`Unsupported workflow action: ${stage.action}`);
      if (!stage.params || typeof stage.params !== 'object' || Array.isArray(stage.params)) throw new Error('Stage params must be an object');
      if (stage.when) validateCondition(stage.when);
      if (stage.requiresConfirmation !== undefined && typeof stage.requiresConfirmation !== 'boolean') throw new Error('requiresConfirmation must be boolean');
      const paramFields = {
        navigate: ['url', 'tabId', 'forceNewWindow', 'returnSnap', 'timeoutMs'],
        new_tab: ['url', 'tabId', 'active', 'returnSnap', 'timeoutMs'],
        switch_tab: ['tabId', 'url', 'title'],
        close_tab: ['tabId'],
        act: ['steps', 'tabId', 'timeoutMs'],
        wait_for_element: ['selector', 'text', 'tabId', 'timeoutMs'],
        extract_data: ['selector', 'attribute', 'multiple', 'limit', 'tabId'],
        extract_collection: ['selector', 'fields', 'limit', 'tabId'],
        scroll: ['direction', 'amount', 'selector', 'tabId'],
        download: ['url', 'filename', 'conflictAction'],
        read_page: ['tabId', 'maxLength', 'maxChars'],
        native_click: ['selector', 'target', 'x', 'y', 'tabId'],
        wait_for_user: ['reason', 'timeoutSec', 'tabId'],
        if: ['condition', 'then', 'else'],
        for_each: ['items', 'itemAs', 'maxIterations', 'stages'],
        while: ['condition', 'maxIterations', 'stages'],
        until: ['condition', 'maxIterations', 'stages'],
        filter: ['items', 'field', 'operator', 'value'],
        aggregate: ['items', 'op', 'field', 'delimiter'],
        assert: ['condition', 'steps']
      }[stage.action];
      for (const key of Object.keys(stage.params)) if (!paramFields.includes(key)) throw new Error(`Unsupported ${stage.action} parameter: ${key}`);
      if (['navigate', 'new_tab'].includes(stage.action) && typeof stage.params.url !== 'string') throw new Error(`${stage.action} requires a URL`);
      if (stage.action === 'download' && typeof stage.params.url !== 'string') throw new Error('download requires a URL');
      if (stage.action === 'extract_collection') {
        if (typeof stage.params.selector !== 'string' || !stage.params.selector) throw new Error('extract_collection requires a container selector');
        if (stage.params.fields !== undefined && (!Array.isArray(stage.params.fields) || !stage.params.fields.length || stage.params.fields.length > 50)) {
          throw new Error('extract_collection fields must be an array of 1 to 50 field definitions');
        }
      }
      if (stage.action === 'scroll') {
        if (stage.params.direction !== undefined && !['down', 'up'].includes(stage.params.direction)) throw new Error('scroll direction must be "down" or "up"');
        if (stage.params.amount !== undefined && (!Number.isFinite(stage.params.amount) || stage.params.amount <= 0)) throw new Error('scroll amount must be positive');
      }
      if (stage.action === 'act') validateTargets(stage.params.steps, false);
      if (stage.action === 'assert') {
        if (!stage.params.condition && !stage.params.steps) throw new Error('assert stage requires condition or steps');
        if (stage.params.condition) validateCondition(stage.params.condition);
        if (stage.params.steps) validateTargets(stage.params.steps, true);
      }
      if (stage.action === 'if') {
        validateCondition(stage.params.condition);
        validateStages(stage.params.then, depth + 1);
        if (stage.params.else !== undefined) {
          if (!Array.isArray(stage.params.else)) throw new Error('if else must be an array of stages');
          if (stage.params.else.length) validateStages(stage.params.else, depth + 1);
        }
      }
      if (stage.action === 'for_each') {
        if (typeof stage.params.items !== 'string' || typeof stage.params.itemAs !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_]*$/.test(stage.params.itemAs) || !Number.isInteger(stage.params.maxIterations) ||
            stage.params.maxIterations < 1 || stage.params.maxIterations > 100) throw new Error('for_each requires items, itemAs, and maxIterations from 1 to 100');
        validateStages(stage.params.stages, depth + 1);
      }
      if (['while', 'until'].includes(stage.action)) {
        validateCondition(stage.params.condition);
        if (!Number.isInteger(stage.params.maxIterations) || stage.params.maxIterations < 1 || stage.params.maxIterations > 50) {
          throw new Error(`${stage.action} requires maxIterations from 1 to 50`);
        }
        validateStages(stage.params.stages, depth + 1);
      }
      if (stage.action === 'filter') {
        if (typeof stage.params.items !== 'string' || typeof stage.params.field !== 'string' || !stage.params.field) {
          throw new Error('filter requires items reference and field name');
        }
        if (stage.params.operator !== undefined && !['equals', 'not_equals', 'contains', 'gt', 'lt', 'exists'].includes(stage.params.operator)) {
          throw new Error('Unsupported filter operator');
        }
      }
      if (stage.action === 'aggregate') {
        if (typeof stage.params.items !== 'string') throw new Error('aggregate requires items reference');
        if (stage.params.op !== undefined && !['count', 'sum', 'join', 'first', 'last'].includes(stage.params.op)) {
          throw new Error('Unsupported aggregate operation');
        }
      }
    }
  }
  function validateCondition(condition) {
    if (!condition || typeof condition.selector !== 'string' || !condition.selector ||
        (condition.exists !== undefined && typeof condition.exists !== 'boolean') ||
        (condition.text !== undefined && typeof condition.text !== 'string')) throw new Error('Condition requires a selector and optional text/exists');
    for (const key of Object.keys(condition)) if (!['selector', 'text', 'exists'].includes(key)) throw new Error(`Unsupported condition field: ${key}`);
  }
  validateStages(stages);
  validateTargets(plan.verify, true);
  function validateTargets(steps, verification) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Provide 1 to 100 DOM steps');
    for (const step of steps) {
      if (!step || (verification ? step.action !== undefined && step.action !== 'assert' : !['click', 'type', 'select', 'wait', 'assert', 'extract', 'upload'].includes(step.action))) throw new Error('Invalid DOM action; verify only permits assertions');
      const fields = ['action', 'selector', 'role', 'name', 'label', 'placeholder', 'value', 'text', 'equals', 'attribute', 'trusted', 'files'];
      for (const key of Object.keys(step)) if (!fields.includes(key)) throw new Error(`Unsupported DOM step field: ${key}`);
      const targets = ['selector', 'role', 'label', 'placeholder'].filter(key => step[key] !== undefined);
      if (targets.length !== 1 || typeof step[targets[0]] !== 'string' || !step[targets[0]]) throw new Error('DOM step requires exactly one target');
      if (step.role !== undefined && step.name !== undefined && typeof step.name !== 'string') throw new Error('Role target name must be a string');
      if (step.trusted !== undefined && typeof step.trusted !== 'boolean') throw new Error('trusted must be boolean');
      if (['type', 'select'].includes(step.action) && typeof step.value !== 'string') throw new Error('type/select require a string value');
    }
  }
  const started = performance.now();
  let tabId = (await getTargetTab(plan.tabId)).id;
  const results = Object.create(null);
  const progress = [];
  const trace = [];
  let failedStage = null;
  let currentResult;
  function remaining() {
    const value = budget - (performance.now() - started);
    if (value <= 0) throw new Error('Workflow deadline exceeded');
    return Math.max(1, Math.floor(value));
  }
  function resolveReference(root, key, variables, scope = results) {
    let found = root === 'inputs' ? plan.inputs : root === 'vars' ? variables : scope;
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    for (const part of parts) {
      if (['__proto__', 'constructor', 'prototype'].includes(part) || found == null) {
        throw new Error(`Unresolved workflow value: ${root}.${key}`);
      }
      if (Array.isArray(found) && /^\d+$/.test(part)) {
        const idx = Number(part);
        if (idx < 0 || idx >= found.length) throw new Error(`Index out of bounds: ${root}.${key}`);
        found = found[idx];
      } else if (part === 'length' && (Array.isArray(found) || typeof found === 'string')) {
        found = found.length;
      } else if (Object.prototype.hasOwnProperty.call(found, part)) {
        found = found[part];
      } else {
        throw new Error(`Unresolved workflow value: ${root}.${key}`);
      }
    }
    return found;
  }
  function expand(value, variables = {}, scope = results) {
    if (typeof value === 'string') {
      const direct = value.match(/^\{\{(inputs|results|vars)\.([A-Za-z0-9_.\[\]]+)\}\}$/);
      if (direct) {
        return resolveReference(direct[1], direct[2], variables, scope);
      }
      return value.replace(/\{\{(inputs|results|vars)\.([A-Za-z0-9_.\[\]]+)\}\}/g, (_, root, key) => {
        const found = resolveReference(root, key, variables, scope);
        if (!['string', 'number', 'boolean'].includes(typeof found)) throw new Error('Interpolated workflow values must be strings, numbers or booleans');
        return String(found);
      });
    }
    if (Array.isArray(value)) return value.map(item => expand(item, variables, scope));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, variables, scope)]));
    return value;
  }
  async function run(action, params) {
    const time = remaining();
    const requested = params.timeoutMs ?? (params.timeoutSec === undefined ? time : params.timeoutSec * 1000);
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('Invalid stage timeout');
    const bound = Math.min(time, requested);
    const actionStarted = performance.now();
    const result = await execute(action, { ...params, tabId: params.tabId ?? tabId, returnSnap: false,
      timeoutMs: bound, ...(params.timeoutSec !== undefined || action === 'wait_for_user' ? { timeoutSec: bound / 1000 } : {}) });
    trace.push({ action, durationMs: Math.round((performance.now() - actionStarted) * 100) / 100,
      ok: result?.ok !== false && result?.success !== false });
    currentResult = result;
    if (result?.ok === false || result?.success === false) throw new Error(result.error || `Stage action failed: ${action}`);
    return result;
  }
  function throwIfCancelled() {
    if (!shouldCancel()) return;
    const error = new Error('Plan cancellation requested; stopped at the next stage boundary');
    error.cancelled = true;
    throw error;
  }
  async function executeStages(list, variables = {}, path = '', parentResults = results) {
    const localResults = Object.assign(Object.create(null), parentResults);
    const producedResults = Object.create(null);
    for (const stage of list) {
      const stageId = path ? `${path}.${stage.id}` : stage.id;
      failedStage = stageId;
      throwIfCancelled();
      currentResult = undefined;
      remaining();
      await onCheckpoint({ state: 'running', stageId, completed: progress.length });
      if (stage.when) {
        const condition = await run('workflow_condition', expand(stage.when, variables, localResults));
        if (!condition.matches) {
          progress.push({ id: stageId, skipped: true });
          await onCheckpoint({ state: 'skipped', stageId, completed: progress.length });
          continue;
        }
      }
      if (stage.requiresConfirmation) {
        const confirmation = await run('wait_for_user', { reason: `Confirm browser action: ${stage.id}` });
        if (confirmation.success === false || confirmation.resumed === false) throw new Error(`User confirmation timed out for ${stageId}`);
      }

      let result;
      if (stage.action === 'if') {
        const condition = await run('workflow_condition', expand(stage.params.condition, variables, localResults));
        const branch = condition.matches ? stage.params.then : (stage.params.else || []);
        result = { branch: condition.matches ? 'then' : 'else',
          results: branch.length ? await executeStages(branch, variables, stageId, localResults) : {} };
      } else if (stage.action === 'for_each') {
        const collection = expand(stage.params.items, variables, localResults);
        if (!Array.isArray(collection)) throw new Error('for_each items must resolve to an array');
        if (collection.length > stage.params.maxIterations) throw new Error('for_each collection exceeds maxIterations');
        const iterations = [];
        for (let index = 0; index < collection.length; index++) {
          const stageIterationId = `${stageId}.${index}`;
          failedStage = stageIterationId;
          throwIfCancelled();
          const iterationVars = { ...variables, [stage.params.itemAs]: collection[index], index };
          iterations.push({ index, results: await executeStages(stage.params.stages, iterationVars, stageIterationId, localResults) });
        }
        result = { count: iterations.length, iterations };
      } else if (stage.action === 'while') {
        const iterations = [];
        for (let index = 0; index < stage.params.maxIterations; index++) {
          const stageIterationId = `${stageId}.${index}`;
          failedStage = stageIterationId;
          throwIfCancelled();
          const condition = await run('workflow_condition', expand(stage.params.condition, variables, localResults));
          if (!condition.matches) break;
          iterations.push({ index, results: await executeStages(stage.params.stages, { ...variables, index }, stageIterationId, localResults) });
        }
        if (iterations.length === stage.params.maxIterations) {
          const finalCondition = await run('workflow_condition', expand(stage.params.condition, variables, localResults));
          if (finalCondition.matches) throw new Error(`while exceeded maxIterations (${stage.params.maxIterations})`);
        }
        result = { count: iterations.length, iterations };
      } else if (stage.action === 'until') {
        const iterations = [];
        for (let index = 0; index < stage.params.maxIterations; index++) {
          const stageIterationId = `${stageId}.${index}`;
          failedStage = stageIterationId;
          throwIfCancelled();
          const condition = await run('workflow_condition', expand(stage.params.condition, variables, localResults));
          if (condition.matches) break;
          iterations.push({ index, results: await executeStages(stage.params.stages, { ...variables, index }, stageIterationId, localResults) });
        }
        result = { count: iterations.length, iterations };
      } else if (stage.action === 'filter') {
        const raw = expand(stage.params.items, variables, localResults);
        const collection = Array.isArray(raw) ? raw : [];
        const field = stage.params.field;
        const op = stage.params.operator || 'equals';
        const targetVal = expand(stage.params.value, variables, localResults);
        const filtered = collection.filter(item => {
          if (!item || typeof item !== 'object') return false;
          const v = item[field];
          switch (op) {
            case 'equals': return String(v) === String(targetVal);
            case 'not_equals': return String(v) !== String(targetVal);
            case 'contains': return String(v ?? '').includes(String(targetVal));
            case 'gt': return Number(v) > Number(targetVal);
            case 'lt': return Number(v) < Number(targetVal);
            case 'exists': return v !== undefined && v !== null && v !== '';
            default: return true;
          }
        });
        result = { count: filtered.length, items: filtered };
      } else if (stage.action === 'aggregate') {
        const raw = expand(stage.params.items, variables, localResults);
        const collection = Array.isArray(raw) ? raw : [];
        const op = stage.params.op || 'count';
        const field = stage.params.field;
        let value;
        switch (op) {
          case 'count': value = collection.length; break;
          case 'sum': value = collection.reduce((acc, it) => acc + (Number(field ? it?.[field] : it) || 0), 0); break;
          case 'join': value = collection.map(it => String(field ? it?.[field] : it)).join(stage.params.delimiter ?? ', '); break;
          case 'first': value = collection.length ? collection[0] : null; break;
          case 'last': value = collection.length ? collection[collection.length - 1] : null; break;
          default: value = collection.length;
        }
        result = { op, value };
      } else if (stage.action === 'assert') {
        if (stage.params.condition) {
          const condition = await run('workflow_condition', expand(stage.params.condition, variables, localResults));
          if (!condition.matches) throw new Error(`Assertion failed for condition: ${JSON.stringify(stage.params.condition)}`);
        }
        if (stage.params.steps) {
          await run('act', { steps: expand(stage.params.steps, variables, localResults).map(s => ({ ...s, action: 'assert' })) });
        }
        result = { ok: true, asserted: true };
      } else if (stage.action === 'switch_tab') {
        result = await run('switch_tab', expand(stage.params, variables, localResults));
        tabId = result?.tabId ?? result?.id ?? stage.params.tabId ?? tabId;
      } else if (stage.action === 'close_tab') {
        result = await run('close_tab', expand(stage.params, variables, localResults));
      } else if (stage.action === 'download') {
        result = await run('download_file', expand(stage.params, variables, localResults));
      } else {
        result = await run(stage.action, expand(stage.params, variables, localResults));
        if (['navigate', 'new_tab'].includes(stage.action)) tabId = result?.tabId ?? result?.id ?? tabId;
      }
      localResults[stage.id] = result;
      producedResults[stage.id] = result;
      progress.push({ id: stageId, ok: true });
      await onCheckpoint({ state: 'completed', stageId, completed: progress.length });
    }
    return producedResults;
  }

  try {
    const completedResults = await executeStages(stages);
    for (const [key, value] of Object.entries(completedResults)) results[key] = value;
    throwIfCancelled();
    failedStage = '$verify';
    currentResult = undefined;
    await onCheckpoint({ state: 'running', stageId: '$verify', completed: progress.length });
    const verification = await run('act', { steps: expand(plan.verify).map(step => ({ ...step, action: 'assert' })) });
    await onCheckpoint({ state: 'verified', stageId: '$verify', completed: progress.length });
    return { ok: true, verified: true, tabId, completed: progress.length, progress, results, verification,
      durationMs: performance.now() - started, metrics: { extensionActions: trace.length, retries: 0, actions: trace } };
  } catch (error) {
    if (error.cancelled) return { ok: false, verified: false, cancelled: true, tabId, failedStage,
      completed: progress.length, progress, results, error: error.message, durationMs: performance.now() - started,
      metrics: { extensionActions: trace.length, retries: 0, actions: trace } };
    // Report partial DOM progress. The caller must never replay a completed send/submit.
    const failedResult = currentResult;
    let snapshot = null;
    try { snapshot = (await execute('snap', { tabId })).compact; } catch {}
    return { ok: false, verified: false, tabId, failedStage, completed: progress.length, progress, results,
      failedResult, error: error.message, snapshot,
      recovery: 'Inspect failedResult for completed DOM steps. Resume only uncompleted actions; never replay a completed submission.',
      durationMs: performance.now() - started, metrics: { extensionActions: trace.length, retries: 0, actions: trace } };
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
