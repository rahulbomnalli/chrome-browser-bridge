const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeCdpBatch } = require('../extension/cdp-batch');

test('CDP batch executes commands in order and returns compact results', async () => {
  const calls = [];
  const result = await executeCdpBatch({
    commands: [
      { method: 'Page.enable' },
      { method: 'Runtime.evaluate', params: { expression: '2 + 2' } }
    ]
  }, {
    sendCommand: async (method, params) => {
      calls.push({ method, params });
      return { method, value: method === 'Runtime.evaluate' ? 4 : undefined };
    }
  });

  assert.deepEqual(calls.map(call => call.method), ['Page.enable', 'Runtime.evaluate']);
  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
  assert.equal(result.results[0].result.method, 'Page.enable');
  assert.deepEqual(JSON.parse(JSON.stringify(result.results[1].result)), { method: 'Runtime.evaluate', value: 4 });
});

test('CDP batch stops on command failure and returns the completed prefix', async () => {
  const calls = [];
  const result = await executeCdpBatch({
    commands: [
      { method: 'Page.enable' },
      { method: 'Runtime.evaluate' },
      { method: 'Page.captureScreenshot' }
    ]
  }, {
    sendCommand: async method => {
      calls.push(method);
      if (method === 'Runtime.evaluate') throw new Error('Execution context unavailable');
      return { method };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.completed, 1);
  assert.equal(result.failedStep, 1);
  assert.deepEqual(calls, ['Page.enable', 'Runtime.evaluate']);
  assert.match(result.error, /Execution context unavailable/);
});

test('CDP batch validates the entire plan before issuing commands and caps large results', async () => {
  let calls = 0;
  const deps = {
    sendCommand: async () => {
      calls++;
      return { value: 'x'.repeat(400) };
    }
  };

  await assert.rejects(executeCdpBatch({
    commands: [{ method: 'Page.enable' }, { method: 'not-a-method' }]
  }, deps), /domain.method/);
  assert.equal(calls, 0);

  const result = await executeCdpBatch({
    commands: [{ method: 'Runtime.evaluate' }],
    maxResultChars: 256
  }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].result.truncated, true);
  assert.equal(result.results[0].result.preview.length, 256);
  assert.equal(result.results[0].result.originalChars, 412);
});
