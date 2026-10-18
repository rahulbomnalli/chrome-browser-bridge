// Chrome Browser Bridge — Persistent Isolated-World Content Script Executor
// Executes bounded DOM actions locally without executeScript round-trips.

(function initBridgeContentScript() {
  if (globalThis.__bridgeContentScriptInitialized) return;
  globalThis.__bridgeContentScriptInitialized = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'bridge_ping') {
      sendResponse({ ok: true, active: true, url: location.href });
      return true;
    }

    if (message.type === 'run_dom_workflow') {
      if (typeof runDomWorkflow !== 'function') {
        sendResponse({ ok: false, error: 'runDomWorkflow is not defined in content script context' });
        return true;
      }
      runDomWorkflow(message.options)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
      return true; // Keep sendResponse channel open for async execution
    }

    if (message.type === 'check_condition') {
      if (typeof checkWorkflowCondition === 'function') {
        try {
          const res = checkWorkflowCondition(message.condition);
          sendResponse({ ok: true, result: res });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      } else {
        const matches = [...document.querySelectorAll(message.condition.selector || '*')].filter(el => {
          const style = getComputedStyle(el);
          return el.isConnected && el.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
            (message.condition.text === undefined || el.textContent.includes(message.condition.text));
        });
        sendResponse({ ok: true, result: { matches: message.condition.exists === false ? matches.length === 0 : matches.length > 0, count: matches.length } });
      }
      return true;
    }

    return false;
  });
})();
