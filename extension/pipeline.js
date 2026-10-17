// Ordered multi-document execution. Never retries a completed mutation.
async function executePipeline(params, { getTargetTab, execute }) {
  const steps = params.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Pipeline requires 1 to 100 steps');
  for (const step of steps) {
    if (!step || typeof step.action !== 'string' || ['pipeline', 'run_macro'].includes(step.action)) throw new Error('Invalid or nested pipeline step');
    if (step.params !== undefined && (!step.params || typeof step.params !== 'object' || Array.isArray(step.params))) throw new Error('Step params must be an object');
    if (step.action === 'wait' && (!Number.isFinite(step.ms ?? 50) || (step.ms ?? 50) < 0 || (step.ms ?? 50) > 10000)) throw new Error('Wait must be between 0 and 10000ms');
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
      if (step.action === 'wait') {
        const ms = step.ms ?? 50;
        if (ms > budget - (performance.now() - start)) throw new Error('Wait exceeds remaining pipeline deadline');
        await new Promise(resolve => setTimeout(resolve, ms));
      }
      else result = await execute(step.action, stepParams);
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
if (typeof module !== 'undefined') module.exports = { executePipeline };
