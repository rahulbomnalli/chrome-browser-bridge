#!/usr/bin/env node
// Read-only benchmark. --mock measures transport, not Chrome or website latency.
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const WebSocket = require('ws');
const { createTransport } = require('../lib/transport');

async function main() {
  let child, socket;
  let url = process.env.BRIDGE_URL || 'http://127.0.0.1:8765';
  const mock = process.argv.includes('--mock');
  let transport;
  try {
    if (mock) {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const port = probe.address().port;
      await new Promise(resolve => probe.close(resolve));
      child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Benchmark server startup timed out')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Benchmark server exited: ${code}`)); });
        child.stdout.on('data', chunk => { if (chunk.toString().includes('HTTP API:')) { clearTimeout(timer); resolve(); } });
      });
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(socket, 'open');
      socket.on('message', raw => {
        const msg = JSON.parse(raw);
        socket.send(JSON.stringify({ id: msg.id, success: true, result: { pong: true } }));
      });
      url = `http://127.0.0.1:${port}`;
    }
    transport = createTransport(url);
    if (!(await transport.getStatus()).connected) throw new Error('Chrome extension disconnected. Load extension/ or pass --mock for a transport-only benchmark.');
    for (let i = 0; i < 10; i++) await transport.postAction('ping');
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await transport.postAction('ping');
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ mode: mock ? 'mock-extension-transport-only' : 'live-extension-ping',
      node: process.version, platform: process.platform, samples: samples.length,
      p50Ms: +samples[49].toFixed(3), p95Ms: +samples[94].toFixed(3),
      maxMs: +samples[99].toFixed(3), scope: 'HTTP + WebSocket round trip; excludes model reasoning, DOM actions and website loading' }, null, 2));
  } finally { transport?.close(); socket?.terminate(); child?.kill(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
