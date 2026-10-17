// Only remove successful DOM acknowledgements. Keep extracted values, native-input
// evidence and every failure detail. Arbitrary page/API data is never traversed.
function compactDom(result) {
  if (result?.ok !== true || !Array.isArray(result.results) || !result.results.every(item =>
    Number.isInteger(item.index) && ['click', 'type', 'select', 'wait', 'assert', 'extract', 'upload'].includes(item.action))) return result;
  return { ...result, results: result.results.filter(item => Object.prototype.hasOwnProperty.call(item, 'value') || item.trusted) };
}
function compactPipeline(result) {
  if (result?.ok !== true || !Array.isArray(result.results)) return result;
  const acknowledgementActions = new Set(['click', 'type', 'select', 'wait_for_element']);
  const acknowledgementKeys = new Set(['ok', 'success', 'found', 'durationMs', 'elapsedMs']);
  const results = result.results.flatMap((item, index) => {
    // Preserve anything with additional data, including false flags and warnings.
    const value = item.result;
    if (item.ok === true && acknowledgementActions.has(item.action) && value &&
        Object.keys(item).every(key => ['action', 'ok', 'result', 'index'].includes(key)) &&
        Object.keys(value).every(key => acknowledgementKeys.has(key)) &&
        !Object.values(value).some(entry => entry === false)) return [];
    return [{ ...item, index: item.index ?? index, ...(item.action === 'act' ? { result: compactDom(value) } : {}) }];
  });
  return { ...result, results };
}
function compactToolResult(name, result) {
  if (name === 'chrome_act') return compactDom(result);
  if (name === 'chrome_pipeline') return compactPipeline(result);
  if (name === 'chrome_run_macro' && result?.success === true) return { ...result, pipeline: compactPipeline(result.pipeline) };
  if (name === 'chrome_workflow' && result?.ok === true) {
    const { progress, ...summary } = result;
    // Completion count already acknowledges successful stages. Keep skipped stages
    // and unfamiliar progress entries, since they can change the outcome's meaning.
    const noteworthy = (progress || []).filter(item => item.ok !== true ||
      Object.keys(item).some(key => !['id', 'ok'].includes(key)));
    return {
      ...summary, ...(noteworthy.length ? { progress: noteworthy } : {}),
      results: Object.fromEntries(Object.entries(result.results || {}).map(([id, value]) => [id, compactDom(value)])),
      verification: compactDom(result.verification)
    };
  }
  return result;
}
module.exports = { compactToolResult };
