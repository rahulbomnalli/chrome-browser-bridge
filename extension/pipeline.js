// Ordered multi-document execution. Never retries a completed mutation.
function compileDomStep(step) {
  const p = step.params || {};
  if (step.action === 'act') return null; // Already a single injection with its own result contract.
  const selector = p.selector || (/^#\d+$/.test(p.target || '') ? '@' + p.target.slice(1) : /^[@#.\[]/.test(p.target || '') ? p.target : null);
  if (!selector || p.pressEnter || p.clear === false || p.highlight || p.trusted || p.timeoutMs || p.timeoutSec) return null;
  const allowed = new Set(['selector', 'target', 'tabId', 'returnSnap', 'text', 'clear', 'pressEnter', 'highlight']);
  if (Object.keys(p).some(key => !allowed.has(key))) return null;
  if (step.action === 'type' && typeof p.text === 'string') return { action: 'type', selector, value: p.text };
  if (step.action === 'click' && p.text === undefined) return { action: 'click', selector };
  if (step.action === 'wait_for_element' && p.text === undefined) return { action: 'wait', selector };
  return null;
}

async function executePipeline(params, { getTargetTab, execute, executeDom }) {
  const steps = params.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Pipeline requires 1 to 100 steps');
  for (const step of steps) {
    if (!step || typeof step.action !== 'string' || ['pipeline', 'run_macro'].includes(step.action)) throw new Error('Invalid or nested pipeline step');
    if (step.params !== undefined && (!step.params || typeof step.params !== 'object' || Array.isArray(step.params))) throw new Error('Step params must be an object');
    if (step.action === 'wait') throw new Error('Wait by duration is unsupported; use wait_for_element or an act wait with a state condition');
  }
  const budget = params.timeoutMs ?? 30000;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) throw new Error('Invalid pipeline timeout');
  const start = performance.now();
  let tabId = (await getTargetTab(params.tabId)).id;
  const results = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const stepParams = { ...step.params, tabId: step.params?.tabId ?? tabId, returnSnap: false };
    try {
      if (performance.now() - start >= budget) throw new Error('Pipeline deadline exceeded');
      let result;
      const group = [];
      if (executeDom && params.fuseDom !== false) {
        for (let cursor = index; cursor < steps.length; cursor++) {
          const candidate = steps[cursor];
          if ((candidate.params?.tabId ?? tabId) !== stepParams.tabId) break;
          const compiled = compileDomStep(candidate);
          if (!compiled) break;
          group.push(compiled);
          // A legacy click may navigate. Never carry the following step into that document.
          if (candidate.action === 'click') break;
        }
      }
      if (group.length > 1) {
        const batch = await executeDom({ steps: group, tabId: stepParams.tabId, timeoutMs: Math.max(1, budget - (performance.now() - start)) });
        for (let i = 0; i < batch.completed; i++) results.push({ action: steps[index + i].action, ok: true, result: { success: true, ...(group[i].action === 'wait' ? { found: true } : {}) } });
        if (!batch.ok) return { ok: false, failedStep: index + (batch.failedStep ?? batch.completed), count: results.length, results, error: batch.error, tabId, durationMs: performance.now() - start };
        index += group.length - 1;
        continue;
      }
      stepParams.timeoutMs = Math.min(step.params?.timeoutMs ?? budget, Math.max(1, budget - (performance.now() - start)));
      result = await execute(step.action, stepParams);
      if (result?.ok === false || result?.success === false) {
        results.push({ action: step.action, ok: false, result });
        return { ok: false, failedStep: index, count: index, results, durationMs: performance.now() - start };
      }
      if (['new_tab', 'navigate', 'smart_navigate', 'switch_tab'].includes(step.action)) tabId = result?.tabId ?? result?.id ?? stepParams.tabId;
      results.push({ action: step.action, ok: true, result });
    } catch (error) {
      return { ok: false, failedStep: index, count: index, results, error: error.message, durationMs: performance.now() - start };
    }
  }
  let snapshot = null;
  if (params.returnSnap !== false) {
    try { snapshot = (await execute('snap', { tabId })).compact; } catch {}
  }
  return { ok: true, count: steps.length, tabId, results, snapshot, durationMs: performance.now() - start };
}
if (typeof module !== 'undefined') module.exports = { executePipeline, compileDomStep };
