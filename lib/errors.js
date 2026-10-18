// Typed Failure Taxonomy and Error Classification for Chrome Browser Bridge
// Every error must have retrySafe, outcomeKnown, stageId, tabId, documentId, and suggestedRecovery.

const ErrorCode = Object.freeze({
  INVALID_PLAN: 'INVALID_PLAN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NO_TAB: 'NO_TAB',
  NAVIGATION_REPLACED_DOCUMENT: 'NAVIGATION_REPLACED_DOCUMENT',
  ELEMENT_MISSING: 'ELEMENT_MISSING',
  AMBIGUOUS_LOCATOR: 'AMBIGUOUS_LOCATOR',
  OBSTRUCTED: 'OBSTRUCTED',
  STALE_DOCUMENT: 'STALE_DOCUMENT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_TRANSIENT: 'NETWORK_TRANSIENT',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  CANCELLED: 'CANCELLED',
  MUTATION_UNCERTAIN: 'MUTATION_UNCERTAIN',
  VERIFY_FAILED: 'VERIFY_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

const RecoveryMatrix = Object.freeze({
  [ErrorCode.INVALID_PLAN]: {
    retrySafe: false,
    outcomeKnown: true,
    suggestedRecovery: 'Validate workflow declaration against the schema before resubmitting.'
  },
  [ErrorCode.PERMISSION_DENIED]: {
    retrySafe: false,
    outcomeKnown: true,
    suggestedRecovery: 'Verify allowedOrigins policy or prompt user for origin permission.'
  },
  [ErrorCode.NO_TAB]: {
    retrySafe: true,
    outcomeKnown: true,
    suggestedRecovery: 'Query chrome.tabs to resolve or open an active target tab.'
  },
  [ErrorCode.NAVIGATION_REPLACED_DOCUMENT]: {
    retrySafe: false,
    outcomeKnown: false,
    suggestedRecovery: 'Inspect the newly navigated page before retrying subsequent actions.'
  },
  [ErrorCode.ELEMENT_MISSING]: {
    retrySafe: true,
    outcomeKnown: true,
    suggestedRecovery: 'Refresh DOM snapshot or wait on observable condition before re-locating element.'
  },
  [ErrorCode.AMBIGUOUS_LOCATOR]: {
    retrySafe: true,
    outcomeKnown: true,
    suggestedRecovery: 'Use a more specific selector, role, name, or index target.'
  },
  [ErrorCode.OBSTRUCTED]: {
    retrySafe: true,
    outcomeKnown: true,
    suggestedRecovery: 'Wait for modal or overlay to clear, scroll target into view, or use trusted input.'
  },
  [ErrorCode.STALE_DOCUMENT]: {
    retrySafe: true,
    outcomeKnown: true,
    suggestedRecovery: 'Document reference expired during execution; re-resolve target on current document.'
  },
  [ErrorCode.AUTH_REQUIRED]: {
    retrySafe: false,
    outcomeKnown: false,
    suggestedRecovery: 'Trigger chrome_wait_for_user in-tab checkpoint for credentials or 2FA resolution.'
  },
  [ErrorCode.RATE_LIMITED]: {
    retrySafe: false,
    outcomeKnown: true,
    suggestedRecovery: 'Apply exponential backoff before sending additional requests.'
  },
  [ErrorCode.NETWORK_TRANSIENT]: {
    retrySafe: true,
    outcomeKnown: false,
    suggestedRecovery: 'Verify whether mutation took effect; retry only idempotent requests.'
  },
  [ErrorCode.DEADLINE_EXCEEDED]: {
    retrySafe: false,
    outcomeKnown: false,
    suggestedRecovery: 'Execution exceeded budget; inspect page state to check whether mutation succeeded.'
  },
  [ErrorCode.CANCELLED]: {
    retrySafe: false,
    outcomeKnown: true,
    suggestedRecovery: 'Workflow was aborted by client; resume only uncompleted stages.'
  },
  [ErrorCode.MUTATION_UNCERTAIN]: {
    retrySafe: false,
    outcomeKnown: false,
    suggestedRecovery: 'Side-effect may have partially applied; inspect DOM state before any retry.'
  },
  [ErrorCode.VERIFY_FAILED]: {
    retrySafe: false,
    outcomeKnown: true,
    suggestedRecovery: 'Workflow stages executed but postcondition assertion failed; inspect DOM snapshot.'
  },
  [ErrorCode.INTERNAL_ERROR]: {
    retrySafe: false,
    outcomeKnown: false,
    suggestedRecovery: 'Internal error occurred; check bridge logs and extension connection status.'
  }
});

class BridgeError extends Error {
  constructor(code, message, context = {}) {
    super(message || code);
    this.name = 'BridgeError';
    this.code = code in ErrorCode ? code : ErrorCode.INTERNAL_ERROR;
    const defaults = RecoveryMatrix[this.code] || RecoveryMatrix[ErrorCode.INTERNAL_ERROR];
    this.retrySafe = context.retrySafe !== undefined ? Boolean(context.retrySafe) : defaults.retrySafe;
    this.outcomeKnown = context.outcomeKnown !== undefined ? Boolean(context.outcomeKnown) : defaults.outcomeKnown;
    this.stageId = context.stageId || null;
    this.tabId = context.tabId || null;
    this.documentId = context.documentId || null;
    this.suggestedRecovery = context.suggestedRecovery || defaults.suggestedRecovery;
    this.details = context.details || null;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      retrySafe: this.retrySafe,
      outcomeKnown: this.outcomeKnown,
      stageId: this.stageId,
      tabId: this.tabId,
      documentId: this.documentId,
      suggestedRecovery: this.suggestedRecovery,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

function classifyError(err, context = {}) {
  if (err instanceof BridgeError) return err;
  if (err && typeof err === 'object') {
    const mergedContext = {
      stageId: err.stageId || err.failedStage || context.stageId,
      tabId: err.tabId || context.tabId,
      documentId: err.documentId || context.documentId,
      suggestedRecovery: err.suggestedRecovery || err.recovery || context.suggestedRecovery,
      ...context
    };
    if (err.code && Object.values(ErrorCode).includes(err.code)) {
      return new BridgeError(err.code, err.message || err.error || err.code, mergedContext);
    }
  }
  const msg = String(err?.message || err?.error || err || '');
  let code = ErrorCode.INTERNAL_ERROR;

  if (/deadline|timeout|timed out/i.test(msg)) code = ErrorCode.DEADLINE_EXCEEDED;
  else if (/cancel/i.test(msg)) code = ErrorCode.CANCELLED;
  else if (/not found|missing element|no element/i.test(msg)) code = ErrorCode.ELEMENT_MISSING;
  else if (/ambiguous|multiple elements/i.test(msg)) code = ErrorCode.AMBIGUOUS_LOCATOR;
  else if (/obstruct|intercepted|not visible/i.test(msg)) code = ErrorCode.OBSTRUCTED;
  else if (/stale|detached|context destroyed/i.test(msg)) code = ErrorCode.STALE_DOCUMENT;
  else if (/auth|password|login|2fa|checkpoint/i.test(msg)) code = ErrorCode.AUTH_REQUIRED;
  else if (/verify|assertion failed|postcondition/i.test(msg)) code = ErrorCode.VERIFY_FAILED;
  else if (/origin|permission|unauthorized|forbidden/i.test(msg)) code = ErrorCode.PERMISSION_DENIED;
  else if (/invalid plan|unsupported|schema/i.test(msg)) code = ErrorCode.INVALID_PLAN;
  else if (/no tab|closed tab/i.test(msg)) code = ErrorCode.NO_TAB;
  else if (/network|disconnect|econnreset|econnrefused/i.test(msg)) code = ErrorCode.NETWORK_TRANSIENT;

  return new BridgeError(code, msg, context);
}

if (typeof module !== 'undefined') {
  module.exports = { ErrorCode, RecoveryMatrix, BridgeError, classifyError };
}
