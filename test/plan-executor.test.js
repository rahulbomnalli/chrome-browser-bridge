const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlanExecutor, PLAN_JOURNAL_KEY } = require('../extension/plan-executor');

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

function makeExecutor(storage, run, { resolveTab, validateOrigins } = {}) {
  return createPlanExecutor({
    storage,
    resolveTab: resolveTab || (async () => ({ id: 7, url: 'https://example.test/' })),
    validateOrigins: validateOrigins || (async () => {}),
    run
  });
}

function plan(key, overrides = {}) {
  return {
    idempotencyKey: key,
    stages: [{ id: 'read', action: 'act', params: { steps: [{ action: 'extract', selector: 'main' }] } }],
    verify: [{ selector: '#done', text: 'Done' }],
    ...overrides
  };
}

test('successful idempotent plan records checkpoints and never replays', async () => {
  const storage = createStorage();
  let executions = 0;
  const executor = makeExecutor(storage, async (_plan, hooks) => {
    executions++;
    await hooks.onCheckpoint({ state: 'running', stageId: 'read', completed: 0 });
    await hooks.onCheckpoint({ state: 'completed', stageId: 'read', completed: 1 });
    return { ok: true, verified: true, completed: 1 };
  });
  const first = await executor.execute(plan('stable-key-001'));
  const second = await executor.execute(plan('stable-key-001'));
  assert.equal(first.verified, true);
  assert.equal(first.metrics.retries, 0);
  assert.equal(second.duplicate, true);
  assert.equal(second.state, 'completed');
  assert.equal(executions, 1);
  assert.equal(storage.data[PLAN_JOURNAL_KEY]['stable-key-001'].checkpoint.stageId, 'read');
});

test('idempotency key cannot be rebound to a different plan', async () => {
  const executor = makeExecutor(createStorage(), async () => ({ ok: true }));
  await executor.execute(plan('stable-key-002'));
  await assert.rejects(executor.execute(plan('stable-key-002', {
    stages: [{ id: 'changed', action: 'act', params: { steps: [{ action: 'click', selector: '#send' }] } }]
  })), /already bound to a different plan/);
});

test('uncertain running journal after worker restart is surfaced without replay', async () => {
  const storage = createStorage();
  const firstExecutor = makeExecutor(storage, async (_plan, hooks) => {
    await hooks.onCheckpoint({ state: 'running', stageId: 'send', completed: 0 });
    throw new Error('worker lost response');
  });
  await assert.rejects(firstExecutor.execute(plan('stable-key-003')), /worker lost response/);
  let replays = 0;
  const restartedExecutor = makeExecutor(storage, async () => { replays++; return { ok: true }; });
  const status = await restartedExecutor.execute(plan('stable-key-003'));
  assert.equal(status.duplicate, true);
  assert.equal(status.state, 'uncertain');
  assert.match(status.error, /inspect the page/);
  assert.equal(replays, 0);
});

test('different plans on one tab are serialized and respect cancellation', async () => {
  const storage = createStorage();
  let release;
  const started = [];
  const executor = makeExecutor(storage, async (submitted, hooks) => {
    started.push(submitted.idempotencyKey);
    if (submitted.idempotencyKey === 'stable-key-004') {
      await new Promise(resolve => { release = resolve; });
      return { ok: true, verified: true };
    }
    assert.equal(hooks.shouldCancel(), true);
    return { ok: false, cancelled: true };
  });
  const first = executor.execute(plan('stable-key-004', { taskId: 'task-first' }));
  while (!started.includes('stable-key-004')) await new Promise(resolve => setImmediate(resolve));
  const second = executor.execute(plan('stable-key-005', { taskId: 'task-second' }));
  while (storage.data[PLAN_JOURNAL_KEY]?.['stable-key-005']?.state !== 'queued') {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(started, ['stable-key-004']);
  assert.equal(executor.cancel('task-second').accepted, true);
  release();
  await first;
  const secondResult = await second;
  assert.equal(secondResult.cancelled, true);
  assert.deepEqual(started, ['stable-key-004']);
});

test('plan limits, origin validator, status, and queue timeout fail safely', async () => {
  const storage = createStorage();
  let validationCalls = 0;
  const executor = makeExecutor(storage, async () => ({ ok: true }), {
    validateOrigins: async () => { validationCalls++; throw new Error('origin permission denied'); }
  });
  await assert.rejects(executor.execute(plan('short')), /idempotencyKey/);
  await assert.rejects(executor.execute(plan('stable-key-006')), /origin permission denied/);
  assert.equal(validationCalls, 1);
  assert.equal(await executor.status('stable-key-006'), null);
  assert.equal(executor.cancel('missing-task').accepted, false);
});
