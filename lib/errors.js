// Typed Failure Taxonomy and Error Classification for Chrome Browser Bridge
// Every error must have retrySafe, outcomeKnown, stageId, tabId, documentId, and suggestedRecovery.

const ErrorCode = Object.freeze({
  // Mandatory Universal Taxonomy
  INVALID_LOCATOR: 'INVALID_LOCATOR',
  AMBIGUOUS_TARGET: 'AMBIGUOUS_TARGET',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  STALE_ELEMENT: 'STALE_ELEMENT',
  ELEMENT_OBSTRUCTED: 'ELEMENT_OBSTRUCTED',
  NAVIGATION_INTERRUPTED: 'NAVIGATION_INTERRUPTED',
  DOCUMENT_CHANGED: 'DOCUMENT_CHANGED',
  EXTENSION_DISCONNECTED: 'EXTENSION_DISCONNECTED',
  SOCKET_CLOSED: 'SOCKET_CLOSED',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  MUTATION_UNCERTAIN: 'MUTATION_UNCERTAIN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Backward-compatible aliases
  INVALID_PLAN: 'INVALID_LOCATOR',
  NO_TAB: 'NO_TAB',
  NAVIGATION_REPLACED_DOCUMENT: 'DOCUMENT_CHANGED',
  ELEMENT_MISSING: 'ELEMENT_NOT_FOUND',
  AMBIGUOUS_LOCATOR: 'AMBIGUOUS_TARGET',
  OBSTRUCTED: 'ELEMENT_OBSTRUCTED',
  STALE_DOCUMENT: 'STALE_ELEMENT',
  NETWORK_TRANSIENT: 'NETWORK_TRANSIENT',
  DEADLINE_EXCEEDED: 'ACTION_TIMEOUT',
  CANCELLED: 'CANCELLED',
  VERIFY_FAILED: 'VERIFICATION_FAILED'
});

const RecoveryCategory = Object.freeze({
  READ_ONLY_RETRY: 'read_only_retry',
  VERIFY_THEN_RETRY: 'verify_then_retry',
  USER_INTERACTION_REQUIRED: 'user_interaction_required',
  NON_RETRYABLE: 'non_retryable',
  UNKNOWN_OUTCOME: 'unknown_outcome'
});

const baseMatrix = {
  [ErrorCode.INVALID_LOCATOR]: {
    retrySafe: false,
    outcomeKnown: true,
    category: RecoveryCategory.NON_RETRYABLE,
    suggestedRecovery: 'Validate selector or workflow declaration against the schema before resubmitting.'
  },
  [ErrorCode.AMBIGUOUS_TARGET]: {
    retrySafe: true,
    outcomeKnown: true,
    category: RecoveryCategory.READ_ONLY_RETRY,
    suggestedRecovery: 'Disambiguate locator with exact text, role, name, or index target before retrying.'
  },
  [ErrorCode.ELEMENT_NOT_FOUND]: {
    retrySafe: true,
    outcomeKnown: true,
    category: RecoveryCategory.READ_ONLY_RETRY,
    suggestedRecovery: 'Wait on observable DOM condition or refresh snapshot before re-locating element.'
  },
  [ErrorCode.STALE_ELEMENT]: {
    retrySafe: true,
    outcomeKnown: true,
    category: RecoveryCategory.READ_ONLY_RETRY,
    suggestedRecovery: 'Element detached from DOM after navigation or rerender; re-resolve target on current document.'
  },
  [ErrorCode.ELEMENT_OBSTRUCTED]: {
    retrySafe: true,
    outcomeKnown: true,
    category: RecoveryCategory.READ_ONLY_RETRY,
    suggestedRecovery: 'Target element is hidden or covered by modal overlay; dismiss overlay or scroll into view.'
  },
  [ErrorCode.NAVIGATION_INTERRUPTED]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'Navigation was cancelled or interrupted; check tab status and URL before proceeding.'
  },
  [ErrorCode.DOCUMENT_CHANGED]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'Document identity changed during action; inspect active page state.'
  },
  [ErrorCode.EXTENSION_DISCONNECTED]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'Chrome extension connection lost; verify extension is loaded and active.'
  },
  [ErrorCode.SOCKET_CLOSED]: {
    retrySafe: true,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'WebSocket control channel closed; verify whether prior mutation took effect before reconnect.'
  },
  [ErrorCode.ACTION_TIMEOUT]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'Execution exceeded budget; inspect current page state to check whether mutation succeeded.'
  },
  [ErrorCode.AUTH_REQUIRED]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.USER_INTERACTION_REQUIRED,
    suggestedRecovery: 'Trigger in-tab checkpoint (chrome_wait_for_user) for credential entry or 2FA resolution.'
  },
  [ErrorCode.RATE_LIMITED]: {
    retrySafe: false,
    outcomeKnown: true,
    category: RecoveryCategory.NON_RETRYABLE,
    suggestedRecovery: 'Target website or API rate limited request; apply exponential backoff before sending.'
  },
  [ErrorCode.PERMISSION_DENIED]: {
    retrySafe: false,
    outcomeKnown: true,
    category: RecoveryCategory.NON_RETRYABLE,
    suggestedRecovery: 'Action or origin rejected by allowedOrigins policy; request user approval.'
  },
  [ErrorCode.VERIFICATION_FAILED]: {
    retrySafe: false,
    outcomeKnown: true,
    category: RecoveryCategory.VERIFY_THEN_RETRY,
    suggestedRecovery: 'Workflow stages executed but final postcondition verify assertions failed; inspect DOM snapshot.'
  },
  [ErrorCode.MUTATION_UNCERTAIN]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'Potentially non-idempotent mutation was in-flight during crash or disconnect; never auto-replay.'
  },
  [ErrorCode.INTERNAL_ERROR]: {
    retrySafe: false,
    outcomeKnown: false,
    category: RecoveryCategory.NON_RETRYABLE,
    suggestedRecovery: 'Internal error occurred; check bridge logs and extension connection status.'
  },
  // Compatibility entries
  NO_TAB: {
    retrySafe: true,
    outcomeKnown: true,
    category: RecoveryCategory.READ_ONLY_RETRY,
    suggestedRecovery: 'Target tab is missing or was closed; resolve a valid active tab.'
  },
  NETWORK_TRANSIENT: {
    retrySafe: true,
    outcomeKnown: false,
    category: RecoveryCategory.UNKNOWN_OUTCOME,
    suggestedRecovery: 'Network request interrupted; verify whether side effect occurred.'
  },
  CANCELLED: {
    retrySafe: false,
    outcomeKnown: true,
    category: RecoveryCategory.NON_RETRYABLE,
    suggestedRecovery: 'Workflow was cancelled by client; resume only unfinished stages.'
  }
};

// Aliases mapped into RecoveryMatrix
baseMatrix['INVALID_PLAN'] = baseMatrix[ErrorCode.INVALID_LOCATOR];
baseMatrix['ELEMENT_MISSING'] = baseMatrix[ErrorCode.ELEMENT_NOT_FOUND];
baseMatrix['AMBIGUOUS_LOCATOR'] = baseMatrix[ErrorCode.AMBIGUOUS_TARGET];
baseMatrix['OBSTRUCTED'] = baseMatrix[ErrorCode.ELEMENT_OBSTRUCTED];
baseMatrix['STALE_DOCUMENT'] = baseMatrix[ErrorCode.STALE_ELEMENT];
baseMatrix['DEADLINE_EXCEEDED'] = baseMatrix[ErrorCode.ACTION_TIMEOUT];
baseMatrix['VERIFY_FAILED'] = baseMatrix[ErrorCode.VERIFICATION_FAILED];
baseMatrix['NAVIGATION_REPLACED_DOCUMENT'] = baseMatrix[ErrorCode.DOCUMENT_CHANGED];

const RecoveryMatrix = Object.freeze(baseMatrix);

class BridgeError extends Error {
  constructor(code, message, context = {}) {
    super(message || code);
    this.name = 'BridgeError';
    this.code = (code in RecoveryMatrix || code in ErrorCode || Object.values(ErrorCode).includes(code)) ? code : ErrorCode.INTERNAL_ERROR;
    const defaults = RecoveryMatrix[this.code] || RecoveryMatrix[ErrorCode.INTERNAL_ERROR];
    this.retrySafe = context.retrySafe !== undefined ? Boolean(context.retrySafe) : defaults.retrySafe;
    this.outcomeKnown = context.outcomeKnown !== undefined ? Boolean(context.outcomeKnown) : defaults.outcomeKnown;
    this.stageId = context.stageId || null;
    this.tabId = context.tabId || null;
    this.documentId = context.documentId || null;
    this.suggestedRecovery = context.suggestedRecovery || defaults.suggestedRecovery;
    this.category = context.category || defaults.category || RecoveryCategory.UNKNOWN_OUTCOME;
    this.details = context.details || null;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      category: this.category,
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
    if (err.code && (err.code in RecoveryMatrix || err.code in ErrorCode || Object.values(ErrorCode).includes(err.code))) {
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
