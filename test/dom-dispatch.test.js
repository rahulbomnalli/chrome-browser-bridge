const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeDomAction } = require('../extension/dom-dispatch');

test('native handoff resumes only the uncompleted suffix in the original document', async () => {
  const calls = [];
  const steps = [{ action: 'click', selector: '#go' }, { action: 'type', selector: '#field', value: 'value' }, { action: 'assert', selector: '#done' }];
  const result = await executeDomAction({ steps }, { tabId: 1,
    inject: async (options, documentId) => {
      calls.push(options);
      if (calls.length === 1) return [{ documentId: 'original', result: { needsTrustedInput: true, completed: 1, failedStep: 1, token: 'token', results: [{ index: 0, action: 'click', ok: true }] } }];
      assert.equal(documentId, 'original'); assert.equal(options.resumeToken, 'token');
      assert.deepEqual(options.steps, [steps[2]]);
      return [{ documentId, result: { ok: true, completed: 1, results: [{ index: 0, action: 'assert', ok: true }] } }];
    },
    insertText: async value => { assert.equal(value, 'value'); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 3);
  assert.deepEqual(result.results.map(item => item.index), [0, 1, 2]);
  assert.equal(calls.length, 2);
});

test('final trusted field requires verification and failed verification excludes that step', async () => {
  let calls = 0;
  const result = await executeDomAction({ steps: [{ action: 'type', selector: '#field', value: 'value', trusted: true }] }, { tabId: 1,
    inject: async options => {
      calls++;
      if (calls === 1) return [{ documentId: 'original', result: { needsTrustedInput: true, completed: 0, token: 'token', results: [] } }];
      assert.equal(options.verifyOnly, true); assert.equal(options.steps[0].action, 'assert');
      return [{ result: { ok: false, trustedInputFailed: true, error: 'Rejected', results: [] } }];
    }, insertText: async () => {}
  });
  assert.equal(result.ok, false); assert.equal(result.completed, 0); assert.equal(result.results.length, 0);
});

test('interrupted injection never replays mutations or invokes trusted input blindly', async () => {
  let calls = 0;
  await assert.rejects(executeDomAction({ steps: [{ action: 'click', selector: '#go' }] }, { tabId: 1,
    inject: async () => { calls++; throw new Error('Document navigated'); },
    insertText: async () => { throw new Error('Must not insert'); }
  }), /Document navigated/);
  assert.equal(calls, 1);
});
