#!/usr/bin/env node
// Real HTTP -> WebSocket -> extension -> Chrome benchmark on an ephemeral local fixture.
// No writes unless --output is supplied. Never touches an existing page or submits data.
const http = require('node:http');
const fs = require('node:fs');
const { once } = require('node:events');
const { createTransport } = require('../lib/transport');

const fixture = `<!doctype html><title>Bridge latency fixture</title>
<style>body{font:16px sans-serif}input,button{display:block;margin:6px}</style>
<input id="a"><input id="b"><input id="c"><input id="d">
<button id="go" onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#done').textContent='done'">Apply</button>
<output id="done">ready</output><input id="reject"><input id="file" type="file"><div id="host"></div>
<script>
document.querySelector('#reject').addEventListener('input', e => { if (!e.isTrusted) e.target.value = ''; });
const root = document.querySelector('#host').attachShadow({mode:'open'});
root.innerHTML='<input id="shadow" aria-label="Shadow field"><slot></slot>';
document.querySelector('#host').innerHTML='<button id="slotted">Slotted</button>';
document.body.insertAdjacentHTML('beforeend', '<div>'+'<span>static text</span>'.repeat(1500)+'</div>');
<\/script>`;

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = p => +sorted[Math.ceil(sorted.length * p) - 1].toFixed(3);
  return { samples: sorted.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) };
}
async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const samples = Number(arg('--samples') || 40);
  if (!Number.isInteger(samples) || samples < 5 || samples > 1000) throw new Error('samples must be 5..1000');
  const transport = createTransport();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
  let tabId;
  try {
    if (!(await transport.getStatus()).connected) throw new Error('Load/reload extension first: bridge disconnected');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    tabId = (await transport.postAction('new_tab', { url: `http://127.0.0.1:${server.address().port}`, active: true, returnSnap: false, timeoutMs: 10000 })).id;
    const steps = ['a', 'b', 'c', 'd'].map(id => ({ action: 'type', params: { selector: '#' + id, text: 'benchmark' } }));
    steps.push({ action: 'click', params: { selector: '#go' } });
    const timings = { sequentialPipeline: [], fusedPipeline: [], singleInjectionAct: [] };
    const actions = {
      sequentialPipeline: () => transport.postAction('pipeline', { steps, tabId, returnSnap: false, fuseDom: false }),
      fusedPipeline: () => transport.postAction('pipeline', { steps, tabId, returnSnap: false }),
      singleInjectionAct: () => transport.postAction('act', { tabId, steps: [
        ...['a', 'b', 'c', 'd'].map(id => ({ action: 'type', selector: '#' + id, value: 'benchmark' })), { action: 'click', selector: '#go' }
      ] })
    };
    // Alternate mode order to reduce warm-cache, scheduling, and thermal bias.
    for (let round = -5; round < samples; round++) {
      const names = Object.keys(actions); if (round % 2) names.reverse();
      for (const name of names) {
        const started = performance.now();
        const result = await actions[name]();
        const elapsed = performance.now() - started;
        if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result)}`);
        if (round >= 0) timings[name].push(elapsed);
      }
    }
    const checked = await transport.postAction('act', { tabId, steps: [
      ...['a', 'b', 'c', 'd'].map(id => ({ action: 'assert', selector: '#' + id, equals: 'benchmark' })),
      { action: 'assert', selector: '#done', text: 'done' }
    ] });
    if (!checked.ok) throw new Error('Final fixture state is incorrect');
    const report = { mode: 'live-extension-dom', node: process.version, platform: process.platform,
      scope: 'Dispatch-to-completion HTTP + WebSocket + Chrome execution on a local fixture; excludes model and external website latency',
      workload: 'Four native-setter field replacements and one button click; five warmups per mode; alternating order',
      ...Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, stats(values)])) };
    if (process.argv.includes('--verify')) {
      const native = await transport.postAction('act', { tabId, steps: [
        { action: 'type', selector: '#reject', value: 'trusted replacement' },
        { action: 'assert', selector: '#reject', equals: 'trusted replacement' },
        { action: 'type', selector: '#shadow', value: 'shadow input' },
        { action: 'assert', selector: '#shadow', equals: 'shadow input' },
        { action: 'upload', selector: '#file', files: [{ name: 'fixture.txt', text: 'local bytes' }] }
      ] });
      if (!native.ok || !native.results.some(item => item.trusted)) throw new Error(`Native/shadow/upload verification failed: ${JSON.stringify(native)}`);
      const snap = await transport.postAction('snap', { tabId });
      if (!snap.compact.includes('Shadow field') || (snap.compact.match(/Slotted/g) || []).length !== 1) throw new Error('Shadow/slot snapshot verification failed');
      const shadowRef = snap.compact.split('\n').find(line => line.includes('Shadow field')).match(/^@\d+/)[0];
      const indexed = await transport.postAction('type', { tabId, target: shadowRef, text: 'indexed', returnSnap: false });
      if (indexed.success === false) throw new Error('Indexed shadow typing failed');
      report.verification = { nativeFallback: true, shadowTargets: true, slottedDeduplication: true, localFileSynthesis: true };
    }
    const baseline = arg('--baseline-snapshot');
    if (baseline) {
      const source = fs.readFileSync(baseline, 'utf8');
      const start = source.indexOf('function inPageGetCompactSnapshot() {');
      const snapshot = source.slice(start, source.indexOf('\nfunction inPageClick(', start));
      const current = fs.readFileSync(require.resolve('../extension/background.js'), 'utf8');
      const from = current.indexOf('function inPageGetCompactSnapshot() {');
      const updated = current.slice(from, current.indexOf('\nfunction inPageClick(', from));
      report.snapshot = await transport.postAction('run_page_script', { tabId, code: `
        const versions = [${snapshot}, ${updated}];
        return versions.map(fn => { const durations = []; let value; for (let i=0;i<50;i++) { const start=performance.now(); value=fn(); if(i>=5) durations.push(performance.now()-start); }
          durations.sort((a,b)=>a-b); return { p50Ms:durations[22], p95Ms:durations[42], bytes:new TextEncoder().encode(JSON.stringify(value)).length, targets:value.items.length }; });
      ` });
    }
    report.p50ReductionPercent = +(100 * (1 - report.fusedPipeline.p50Ms / report.sequentialPipeline.p50Ms)).toFixed(1);
    const output = JSON.stringify(report, null, 2);
    if (arg('--output')) fs.writeFileSync(arg('--output'), output + '\n');
    console.log(output);
  } finally {
    if (tabId) await transport.postAction('close_tab', { tabId }).catch(() => {});
    server.close(); server.closeAllConnections(); transport.close();
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
