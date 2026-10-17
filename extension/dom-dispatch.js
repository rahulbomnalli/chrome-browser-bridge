// Normal execution is one injection. Only a confirmed setter rejection or an explicit
// trusted type step crosses back to the debugger. Completed mutations are never replayed.
async function executeDomAction(params, { tabId, inject, insertText }) {
  const started = performance.now();
  const budget = params.timeoutMs ?? 10000;
  let offset = 0;
  const results = [];
  let resumeToken, documentId;
  while (offset < params.steps.length || resumeToken) {
    const remaining = budget - (performance.now() - started);
    if (remaining <= 0) return { ok: false, completed: offset, failedStep: offset, results, error: 'Workflow deadline exceeded', tabId };
    // A final assertion acknowledges trusted input when there are no remaining actions.
    const pendingSteps = params.steps.slice(offset);
    const verifyOnly = pendingSteps.length === 0;
    const execution = await inject({ steps: verifyOnly ? [{ ...params.steps[offset - 1], action: 'assert', trusted: undefined }] : pendingSteps,
      timeoutMs: remaining, resumeToken, verifyOnly }, documentId);
    const result = execution[0]?.result;
    if (!result) throw new Error('Page execution interrupted; inspect page before retrying');
    documentId = execution[0].documentId || documentId;
    if (result.trustedInputFailed) {
      results.pop(); offset--;
      return { ...result, completed: offset, failedStep: offset, results, tabId };
    }
    if (verifyOnly && result.ok) return { ok: true, completed: offset, results, tabId, durationMs: performance.now() - started };
    results.push(...(result.results || []).map(item => ({ ...item, index: item.index + offset })));
    if (!result.needsTrustedInput) return { ...result, results, completed: results.length,
      ...(result.failedStep !== undefined ? { failedStep: offset + result.failedStep } : {}), tabId, durationMs: performance.now() - started };
    offset += result.completed;
    // Pin continuation to the original document, never a replacement page after navigation.
    if (!documentId) return { ok: false, completed: offset, failedStep: offset, results, tabId, error: 'Trusted input requires a document ID' };
    try { await insertText(params.steps[offset].value, { documentId, token: result.token, deadline: started + budget }); }
    catch (error) { return { ok: false, completed: offset, failedStep: offset, results, tabId, error: error.message }; }
    results.push({ index: offset, action: 'type', ok: true, trusted: true });
    offset++;
    resumeToken = result.token;
  }
}
if (typeof module !== 'undefined') module.exports = { executeDomAction };
