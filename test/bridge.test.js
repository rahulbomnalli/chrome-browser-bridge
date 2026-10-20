const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const path = require('node:path');
const WebSocket = require('ws');
const { createTransport, actionTimeout } = require('../lib/transport');
const { clientConfig } = require('../lib/client-config');
const root = path.resolve(__dirname, '..');

test('default fast profile exposes all universal browser controls', () => {
  const response = spawnSync(process.execPath, ['mcp-server.js'], {
    cwd: root,
    encoding: 'utf8',
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`
  });
  assert.equal(response.status, 0, response.stderr);
  const result = JSON.parse(response.stdout.trim()).result;
  const names = new Set(result.tools.map(tool => tool.name));
  assert.equal(result.tools.length, 33);
  for (const name of [
    'chrome_switch_tab', 'chrome_new_tab', 'chrome_navigate', 'chrome_snapshot', 'chrome_click',
    'chrome_type', 'chrome_scroll', 'chrome_select', 'chrome_wait_for_element', 'chrome_dismiss_overlays'
  ]) assert.ok(names.has(name), `${name} should be in the default fast profile`);
  assert.ok(!names.has('whatsapp_send_message'));
});

test('client configs use absolute executable and entry paths', () => {
  for (const client of ['claude', 'antigravity']) {
    const config = JSON.parse(clientConfig(client)).mcpServers['chrome-browser-bridge'];
    assert.equal(config.command, process.execPath);
    assert.ok(path.isAbsolute(config.args[0]));
    assert.equal(config.env.BRIDGE_TOOL_PROFILE, 'fast');
  }
  assert.match(clientConfig('codex'), /tool_timeout_sec = 180/);
  assert.match(clientConfig('codex'), /BRIDGE_TOOL_PROFILE = "fast"/);
  assert.throws(() => clientConfig('unknown'));
});

test('timeouts are finite and include human checkpoints', () => {
  assert.equal(actionTimeout({ timeoutSec: 120 }), 120000);
  assert.equal(actionTimeout({}, 'wait_for_user'), 120000);
  assert.equal(actionTimeout({}, 'watch'), 20000);
  assert.equal(actionTimeout({}, 'whatsapp_send'), 30000);
  assert.equal(actionTimeout({ timeoutMs: 150000 }), 150000);
  const previousDefault = process.env.BRIDGE_DEFAULT_TIMEOUT_MS;
  process.env.BRIDGE_DEFAULT_TIMEOUT_MS = '45000';
  assert.equal(actionTimeout(), 45000);
  if (previousDefault === undefined) delete process.env.BRIDGE_DEFAULT_TIMEOUT_MS;
  else process.env.BRIDGE_DEFAULT_TIMEOUT_MS = previousDefault;
  for (const timeoutMs of [-1, 0, Infinity, NaN, 600001]) assert.throws(() => actionTimeout({ timeoutMs }));
});

test('transport terminates stalled responses without retrying', async t => {
  let requests = 0;
  const server = http.createServer((_req, _res) => { requests++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createTransport(`http://127.0.0.1:${server.address().port}`);
  t.after(() => { client.close(); server.closeAllConnections(); server.close(); });
  await assert.rejects(client.postAction('click', {}, 40), /deadline exceeded/);
  assert.equal(requests, 1);
});

test('real HTTP + WebSocket routing and stdio MCP compatibility', async t => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Bridge exited: ${code}`)));
    server.stdout.on('data', chunk => { if (chunk.toString().includes('HTTP API:')) resolve(); });
  });
  const url = `http://127.0.0.1:${port}`;
  const transport = createTransport(url);
  t.after(() => transport.close());
  assert.equal((await transport.getStatus()).connected, false);
  const forbidden = await fetch(`${url}/action`, { method: 'POST', headers: { Origin: 'https://malicious.example' } });
  assert.equal(forbidden.status, 403);

  // Security test: unauthorized /action POST without bearer token returns 401
  const unauthorized = await fetch(`${url}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://mock-extension-id' },
    body: JSON.stringify({ action: 'echo', params: {} })
  });
  assert.equal(unauthorized.status, 401);

  const { getAuthToken } = require('../lib/token');
  const token = getAuthToken();
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`, {
    headers: { Origin: 'chrome-extension://mock-extension-id' }
  });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (!msg.action || msg.action === 'hold') return;
    ws.send(JSON.stringify({ id: msg.id, success: true, result: msg.action === 'act'
      ? { ok: false, failedStep: 1, completed: 1, error: 'Target unavailable' }
      : { action: msg.action, params: msg.params } }));
  });
  const routed = await Promise.all(Array.from({ length: 20 }, (_, i) => transport.postAction('echo', { i })));
  assert.deepEqual(routed.map(result => result.params.i), Array.from({ length: 20 }, (_, i) => i));
  const metrics = await (await fetch(`${url}/metrics`)).json();
  assert.equal(metrics.actions.length, 20);
  assert.ok(metrics.actions.every(item => item.action === 'echo' && item.requestBytes > 0 && item.responseBytes > 0));
  assert.ok(metrics.actions.every(item => !('params' in item) && !('result' in item)));
  // Replacement sockets cannot resolve another connection's pending request.
  const held = transport.postAction('hold');
  await once(ws, 'message');
  const replacement = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`, {
    headers: { Origin: 'chrome-extension://mock-extension-id' }
  });
  await once(replacement, 'open');
  t.after(() => replacement.terminate());
  replacement.on('message', raw => {
    const msg = JSON.parse(raw);
    setTimeout(() => replacement.send(JSON.stringify({ id: msg.id, success: true, result: { replacement: true } })), 25);
  });
  const newerPending = transport.postAction('echo');
  await once(replacement, 'message');
  const rejection = assert.rejects(held, /disconnected/);
  ws.close();
  await rejection;
  assert.deepEqual(await newerPending, { replacement: true });
  replacement.close();
  await once(replacement, 'close');
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`, {
    headers: { Origin: 'chrome-extension://mock-extension-id' }
  });
  await once(ws2, 'open');
  t.after(() => ws2.terminate());
  let whatsappTimeout;
  const routedActions = [];
  ws2.on('message', raw => {
    const msg = JSON.parse(raw);
    routedActions.push({ action: msg.action, params: msg.params });
    if (msg.action === 'whatsapp_send') whatsappTimeout = msg.params.timeoutMs;
    const result = msg.action === 'click' && msg.params.selector === '#expected-failure'
      ? { ok: false }
      : ['switch_tab', 'new_tab', 'navigate', 'snapshot', 'click', 'type', 'scroll', 'select', 'wait_for_element', 'dismiss_overlays'].includes(msg.action)
      ? { ok: true, success: true }
      : msg.action === 'api_catalog' ? { tabId: msg.params.tabId || 7, total: 1, count: 1, requests: [{ method: 'GET', url: '/api/users' }] }
      : msg.action === 'debug_bundle' ? { tabId: msg.params.tabId || 7, network: { logs: [] }, console: { logs: [] } }
      : msg.action === 'cdp_batch' ? { ok: true, completed: msg.params.commands.length, results: msg.params.commands.map(command => ({ method: command.method, ok: true })) }
      : msg.action === 'page_fetch' ? { ok: true, status: 200, request: msg.params, data: { items: [1] } }
      : msg.action === 'page_fetch_many' ? { ok: true, results: msg.params.requests.map(request => ({ name: request.name, url: request.url, ok: true, status: 200 })) }
      : msg.action === 'watch' ? { ok: false, changed: false, timeout: true, current: 'initial' }
      : msg.action === 'extract_many' ? { ok: true, results: msg.params.queries.map(query => ({ selector: query.selector, count: 1, data: [query.selector] })) }
      : { ok: false, failedStep: 1, completed: 1 };
    ws2.send(JSON.stringify({ id: msg.id, success: true, result }));
  });

  const mcp = spawn(process.execPath, ['mcp-server.js'], { cwd: root, env: { ...process.env, BRIDGE_URL: url, BRIDGE_TOOL_PROFILE: 'compact' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => mcp.kill());
  const lines = readline.createInterface({ input: mcp.stdout });
  const pending = new Map();
  let id = 0;
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  function rpc(method, params) {
    const next = ++id;
    return new Promise(resolve => {
      pending.set(next, resolve);
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    });
  }
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /ULTRA-FAST/);
  assert.match(init.result.instructions, /chrome_workflow/);
  assert.deepEqual((await rpc('ping')).result, {});
  const list = await rpc('tools/list');
  assert.ok(list.result.tools.some(tool => tool.name === 'chrome_act'));
  for (const name of ['chrome_workflow', 'browser.execute_plan', 'browser.cancel_plan', 'browser.plan_status', 'browser.metrics', 'chrome_cdp_command', 'chrome_cdp_batch', 'chrome_debug_bundle', 'chrome_api_catalog', 'chrome_api_sequence', 'chrome_run_page_script', 'chrome_page_fetch', 'chrome_page_fetch_many', 'whatsapp_send_message', 'chrome_parallel_scrape', 'chrome_save_macro', 'chrome_run_macro', 'chrome_watch', 'chrome_extract_many']) {
    assert.ok(list.result.tools.some(tool => tool.name === name));
  }
  const executePlanTool = list.result.tools.find(tool => tool.name === 'browser.execute_plan');
  assert.deepEqual(executePlanTool.inputSchema.required, ['idempotencyKey', 'stages', 'verify']);
  assert.ok(!executePlanTool.inputSchema.properties.stages.items.properties.action.enum.includes('run_page_script'));
  const fetchTool = list.result.tools.find(tool => tool.name === 'chrome_page_fetch');
  assert.match(fetchTool.description, /Do not guess endpoints/);
  const fetchManyTool = list.result.tools.find(tool => tool.name === 'chrome_page_fetch_many');
  assert.equal(fetchManyTool.inputSchema.properties.requests.maxItems, 20);
  assert.match(fetchManyTool.description, /concurrently/);
  const cdpBatchTool = list.result.tools.find(tool => tool.name === 'chrome_cdp_batch');
  assert.equal(cdpBatchTool.inputSchema.properties.commands.maxItems, 20);
  assert.match(cdpBatchTool.description, /completed prefix/);
  const debugBundleTool = list.result.tools.find(tool => tool.name === 'chrome_debug_bundle');
  assert.equal(debugBundleTool.inputSchema.properties.limit.maximum, 50);
  assert.match(debugBundleTool.description, /network and console/);
  const apiCatalogTool = list.result.tools.find(tool => tool.name === 'chrome_api_catalog');
  assert.match(apiCatalogTool.description, /never returns cookies/);
  assert.ok(list.result.tools.length <= 50);
  for (const name of [
    'chrome_switch_tab', 'chrome_new_tab', 'chrome_navigate', 'chrome_snapshot', 'chrome_click',
    'chrome_type', 'chrome_scroll', 'chrome_select', 'chrome_wait_for_element', 'chrome_dismiss_overlays'
  ]) {
    assert.ok(list.result.tools.some(tool => tool.name === name));
  }
  const universalCalls = [
    ['chrome_switch_tab', { tabId: 7 }, 'switch_tab'],
    ['chrome_new_tab', { url: 'https://example.com', active: false }, 'new_tab'],
    ['chrome_navigate', { url: 'https://example.com', tabId: 7 }, 'navigate'],
    ['chrome_snapshot', { tabId: 7 }, 'snapshot'],
    ['chrome_click', { target: '#go', tabId: 7 }, 'click'],
    ['chrome_type', { selector: '#query', text: 'bridge test', tabId: 7 }, 'type'],
    ['chrome_scroll', { direction: 'down', amount: 250, tabId: 7 }, 'scroll'],
    ['chrome_select', { selector: '#choice', value: 'first', tabId: 7 }, 'select'],
    ['chrome_wait_for_element', { selector: '#ready', timeoutMs: 100, tabId: 7 }, 'wait_for_element'],
    ['chrome_dismiss_overlays', { tabId: 7 }, 'dismiss_overlays']
  ];
  const firstUniversalAction = routedActions.length;
  for (const [name, args] of universalCalls) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, false, `${name} should dispatch successfully`);
  }
  assert.deepEqual(
    routedActions.slice(firstUniversalAction).map(({ action }) => action),
    universalCalls.map(([, , action]) => action)
  );
  assert.deepEqual(routedActions[firstUniversalAction + 4].params.selector, '#go');
  assert.equal(routedActions[firstUniversalAction + 2].params.forceNewWindow, false);
  assert.equal((await rpc('tools/call', { name: 'chrome_act', arguments: {} })).result.isError, true);
  const failed = await rpc('tools/call', { name: 'chrome_act', arguments: { steps: [{ action: 'click', selector: '#go' }] } });
  assert.equal(failed.result.isError, true);
  assert.equal(JSON.parse(failed.result.content[0].text).completed, 1);
  assert.equal((await rpc('tools/call', { name: 'whatsapp_send_message', arguments: {
    contact: 'Test', message: 'Hello', timeoutMs: 54321
  } })).result.isError, true);
  assert.equal(whatsappTimeout, 54321);
  assert.equal((await rpc('tools/call', { name: 'chrome_run_macro', arguments: { name: 'missing' } })).result.isError, true);
  assert.equal((await rpc('tools/call', { name: 'chrome_watch', arguments: { selector: '#feed', timeoutMs: 10 } })).result.isError, false);
  const fetched = await rpc('tools/call', { name: 'chrome_page_fetch', arguments: { url: '/api/items', method: 'GET' } });
  assert.equal(fetched.result.isError, false);
  const fetchResult = JSON.parse(fetched.result.content[0].text);
  assert.deepEqual(fetchResult.data.items, [1]);
  assert.equal(fetchResult.request.url, '/api/items');
  assert.equal(fetchResult.request.method, 'GET');
  const fetchedMany = await rpc('tools/call', { name: 'chrome_page_fetch_many', arguments: {
    requests: [{ name: 'users', url: '/api/users' }, { name: 'teams', url: '/api/teams' }]
  } });
  assert.equal(fetchedMany.result.isError, false);
  const manyResult = JSON.parse(fetchedMany.result.content[0].text);
  assert.deepEqual(manyResult.results.map(result => result.name), ['users', 'teams']);
  const cdpBatch = await rpc('tools/call', { name: 'chrome_cdp_batch', arguments: {
    commands: [{ method: 'Page.enable' }, { method: 'Runtime.evaluate', params: { expression: '1 + 1' } }]
  } });
  assert.equal(cdpBatch.result.isError, false);
  assert.equal(JSON.parse(cdpBatch.result.content[0].text).completed, 2);
  const debugBundle = await rpc('tools/call', { name: 'chrome_debug_bundle', arguments: { filter: 'api', level: 'error', limit: 10 } });
  assert.equal(debugBundle.result.isError, false);
  assert.ok(JSON.parse(debugBundle.result.content[0].text).network);
  const apiCatalog = await rpc('tools/call', { name: 'chrome_api_catalog', arguments: { filter: 'api', limit: 5 } });
  assert.equal(apiCatalog.result.isError, false);
  assert.equal(JSON.parse(apiCatalog.result.content[0].text).requests[0].url, '/api/users');
  const extracted = await rpc('tools/call', { name: 'chrome_extract_many', arguments: {
    queries: [{ selector: 'h1' }, { selector: 'a', attribute: 'href' }]
  } });
  assert.equal(extracted.result.isError, false);
  assert.deepEqual(JSON.parse(extracted.result.content[0].text).results.map(item => item.selector), ['h1', 'a']);
  const metricsCall = await rpc('tools/call', { name: 'browser.metrics', arguments: {} });
  assert.equal(metricsCall.result.isError, false);
  assert.match(JSON.parse(metricsCall.result.content[0].text).scope, /model\/client reasoning is unavailable/);
  assert.equal((await rpc('missing')).error.code, -32601);
  assert.ok((await transport.getStatus()).latencyMs.samples >= 20);
  mcp.stdin.end();
  await once(mcp, 'exit');

  const fullMcp = spawn(process.execPath, ['mcp-server.js'], { cwd: root, env: { ...process.env, BRIDGE_URL: url, BRIDGE_TOOL_PROFILE: 'full' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => fullMcp.kill());
  const fullLines = readline.createInterface({ input: fullMcp.stdout });
  const fullPending = new Map();
  let fullId = 0;
  fullLines.on('line', line => {
    const message = JSON.parse(line);
    fullPending.get(message.id)?.(message);
    fullPending.delete(message.id);
  });
  function fullRpc(method, params) {
    const next = ++fullId;
    return new Promise(resolve => {
      fullPending.set(next, resolve);
      fullMcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    });
  }
  const fullInit = await fullRpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(fullInit.result.instructions, /ULTRA-FAST/);
  const click = await fullRpc('tools/call', { name: 'chrome_click', arguments: { target: '#expected-failure' } });
  assert.equal(click.result.isError, true);
  assert.equal(JSON.parse(click.result.content[0].text).ok, false);
  const challenge = await fullRpc('tools/call', { name: 'chrome_detect_challenge', arguments: {} });
  assert.equal(challenge.result.isError, true);
  assert.doesNotMatch(challenge.result.content[0].text, /No security challenges/);
  fullMcp.stdin.end();
  await once(fullMcp, 'exit');
});
