const PLAN_JOURNAL_KEY = 'bridge_plan_journal';
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_JOURNAL_ENTRIES = 128;
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function planFingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function createPlanExecutor({ storage, resolveTab, validateOrigins, run }) {
  const inFlight = new Map();
  const active = new Map();
  const queues = new Map();
  let journalTail = Promise.resolve();

  function updateJournal(key, update) {
    const operation = journalTail.then(async () => {
      const stored = await storage.get(PLAN_JOURNAL_KEY);
      const journal = stored?.[PLAN_JOURNAL_KEY] || {};
      const cutoff = Date.now() - JOURNAL_RETENTION_MS;
      for (const [entryKey, entry] of Object.entries(journal)) {
        if (!['queued', 'running'].includes(entry.state) && entry.updatedAt < cutoff) delete journal[entryKey];
      }
      if (!journal[key] && Object.keys(journal).length >= MAX_JOURNAL_ENTRIES) {
        throw new Error('Plan journal is full; completed idempotency records are retained for seven days');
      }
      journal[key] = { ...journal[key], ...update, idempotencyKey: key };
      await storage.set({
        [PLAN_JOURNAL_KEY]: journal,
        [`bridge_task:${key}`]: journal[key]
      });
    });
    journalTail = operation.catch(() => {});
    return operation;
  }

  async function readJournal() {
    await journalTail;
    const stored = await storage.get(PLAN_JOURNAL_KEY);
    return stored?.[PLAN_JOURNAL_KEY] || {};
  }

  function execute(params) {
    const key = params.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      return Promise.reject(new Error('idempotencyKey must be 8-128 letters, digits, dots, underscores, colons or hyphens'));
    }
    const taskId = params.taskId || key;
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)) return Promise.reject(new Error('Invalid taskId'));
    const plan = { ...params };
    delete plan.idempotencyKey;
    delete plan.taskId;
    const budget = plan.timeoutMs ?? 30000;
    if (!Number.isFinite(budget) || budget <= 0 || budget > 600000) {
      return Promise.reject(new Error('Plan timeout must be between 1 and 600000 milliseconds'));
    }
    const deadline = performance.now() + budget;
    const serialized = JSON.stringify(plan);
    if (new TextEncoder().encode(serialized).byteLength > MAX_PLAN_BYTES) {
      return Promise.reject(new Error(`Plan exceeds ${MAX_PLAN_BYTES} bytes`));
    }
    const fingerprintPromise = planFingerprint(serialized);
    const existingFlight = inFlight.get(key);
    if (existingFlight) {
      return Promise.all([fingerprintPromise, existingFlight.fingerprintPromise]).then(([fingerprint, existingFingerprint]) => {
        if (existingFingerprint !== fingerprint) throw new Error('idempotencyKey is already bound to a different plan');
        return existingFlight.promise;
      });
    }

    const promise = fingerprintPromise.then(fingerprint => executeOnce({ key, taskId, fingerprint, plan, deadline }));
    const entry = { fingerprintPromise, promise };
    inFlight.set(key, entry);
    promise.finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    }).catch(() => {});
    return promise;
  }

  async function executeOnce({ key, taskId, fingerprint, plan, deadline }) {
    const journal = await readJournal();
    const previous = journal[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.taskId !== taskId) throw new Error('idempotencyKey is already bound to a different plan');
      const isUncertain = ['running', 'queued', 'uncertain'].includes(previous.state);
      return {
        ok: previous.state === 'completed',
        verified: previous.state === 'completed',
        duplicate: true,
        taskId,
        state: previous.state,
        checkpoint: previous.checkpoint,
        completedStages: previous.checkpoint?.completedStages || (previous.checkpoint?.stageId ? [previous.checkpoint.stageId] : []),
        ...(isUncertain
          ? {
              code: 'MUTATION_UNCERTAIN',
              retrySafe: false,
              outcomeKnown: false,
              error: 'Task outcome is uncertain after executor restart; inspect the page before creating a new plan',
              suggestedRecovery: 'Inspect current tab DOM to verify whether partial actions completed. Never replay uncertain mutations.'
            } : {})
      };
    }

    const tab = await resolveTab(plan.tabId);
    await validateOrigins(tab, plan);
    const tabId = tab.id;

    // Collect all unique tabs targeted by this plan and sort in ascending order to prevent deadlocks
    const targetTabs = [tabId];
    if (Array.isArray(plan.stages)) {
      for (const stage of plan.stages) {
        if (stage?.params?.tabId !== undefined && stage.params.tabId !== null && !targetTabs.includes(stage.params.tabId)) {
          targetTabs.push(stage.params.tabId);
        }
      }
    }
    targetTabs.sort((a, b) => a - b);

    for (const tId of targetTabs) {
      if (!queues.has(tId)) {
        const activeCheckpoint = Object.values(journal).find(entry =>
          entry.tabId === tId && ['queued', 'running'].includes(entry.state));
        if (activeCheckpoint) {
          throw new Error(`Tab has an unfinished plan (${activeCheckpoint.taskId}); inspect its status before starting another plan`);
        }
      }
    }
    if (active.has(taskId)) throw new Error('taskId is already active');
    const controller = { taskId, key, cancelled: false, state: 'queued' };
    active.set(taskId, controller);

    // Multi-tab predecessor chain in ordered sequence
    const predecessors = targetTabs.map(tId => queues.get(tId) || Promise.resolve());
    let releaseQueue;
    const queueTail = new Promise(resolve => { releaseQueue = resolve; });
    for (const tId of targetTabs) {
      queues.set(tId, queueTail);
    }

    function cleanupQueues() {
      releaseQueue();
      for (const tId of targetTabs) {
        if (queues.get(tId) === queueTail) queues.delete(tId);
      }
    }

    try {
      await updateJournal(key, {
        taskId, fingerprint, tabId, state: 'queued',
        checkpoint: { state: 'queued', stageId: null, completedStages: [] }, updatedAt: Date.now()
      });
    } catch (error) {
      active.delete(taskId);
      cleanupQueues();
      throw new Error(`Cannot persist plan checkpoint before execution: ${error.message}`);
    }

    const started = performance.now();
    await Promise.all(predecessors.map(p => p.catch(() => {})));
    if (controller.cancelled) {
      const result = { ok: false, cancelled: true, taskId, error: 'Cancelled before execution' };
      await updateJournal(key, {
        state: 'cancelled', checkpoint: { state: 'cancelled', stageId: null, completedStages: [] }, updatedAt: Date.now()
      });
      active.delete(taskId);
      cleanupQueues();
      return result;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const result = { ok: false, taskId, error: 'Plan deadline exceeded while waiting for its tab queue' };
      await updateJournal(key, { state: 'expired', checkpoint: { state: 'expired', stageId: null, completedStages: [] }, updatedAt: Date.now() });
      active.delete(taskId);
      cleanupQueues();
      return result;
    }

    controller.state = 'running';
    let checkpoint = { state: 'started', stageId: null, completedStages: [] };
    const completedStages = [];
    try {
      await updateJournal(key, { state: 'running', checkpoint, updatedAt: Date.now() });
      const result = await run({ ...plan, idempotencyKey: key, taskId, timeoutMs: remaining }, {
        shouldCancel: () => controller.cancelled,
        onCheckpoint: next => {
          if (next.stageId && (next.state === 'completed' || next.ok) && !completedStages.includes(next.stageId)) {
            completedStages.push(next.stageId);
          }
          checkpoint = { ...next, completedStages: [...completedStages] };
          const isMutation = next.intent === true || ['click', 'type', 'select', 'upload', 'press', 'check', 'uncheck', 'native_click', 'act'].includes(next.action);
          const isTerminal = ['completed', 'failed', 'verified', 'uncertain', 'cancelled', 'expired'].includes(next.state);
          if (isMutation || isTerminal) {
            return updateJournal(key, { state: 'running', checkpoint, updatedAt: Date.now() });
          }
          return Promise.resolve();
        }
      });
      const state = result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed';
      await updateJournal(key, {
        state,
        checkpoint: { ...checkpoint, state, failedStage: result.failedStage ?? null, completed: result.completed ?? completedStages.length, completedStages },
        updatedAt: Date.now()
      });
      return {
        ...result,
        taskId,
        idempotencyKey: key,
        metrics: { ...result.metrics, queueWaitMs: Math.round((performance.now() - started - (result.durationMs || 0)) * 100) / 100, retries: 0 }
      };
    } catch (error) {
      const state = checkpoint.stageId ? 'uncertain' : 'failed';
      await updateJournal(key, {
        state, checkpoint: { ...checkpoint, state, error: error.message, completedStages }, updatedAt: Date.now()
      });
      throw error;
    } finally {
      active.delete(taskId);
      cleanupQueues();
    }
  }

  async function status(key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error('Invalid idempotencyKey');
    return (await readJournal())[key] || null;
  }

  function cancel(taskId) {
    for (const controller of active.values()) {
      if (controller.taskId !== taskId) continue;
      controller.cancelled = true;
      return { accepted: true, taskId, state: controller.state === 'queued' ? 'cancellation_requested' : 'cancellation_at_next_stage' };
    }
    return { accepted: false, taskId, state: 'not_active' };
  }

  return { execute, status, cancel };
}

if (typeof module !== 'undefined') module.exports = { createPlanExecutor, planFingerprint, MAX_PLAN_BYTES, PLAN_JOURNAL_KEY };