const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const targets = [
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp', 'chrome-browser-bridge'),
  path.join(os.homedir(), '.gemini', 'antigravity-ide', 'mcp', 'chrome-browser-bridge')
].filter(target => fs.existsSync(target));

function getFastTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'mcp-server.js')], {
      cwd: root,
      env: { ...process.env, BRIDGE_TOOL_PROFILE: 'fast' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    let stderr = '';
    let timeout;
    const finish = (error, tools) => {
      clearTimeout(timeout);
      child.stdin.end();
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(tools);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(output.slice(0, newline));
        if (response.id !== 1 || !Array.isArray(response.result?.tools)) {
          throw new Error('MCP tools/list returned an invalid response');
        }
        finish(null, response.result.tools);
      } catch (error) {
        finish(error);
      }
    });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (code && !output.includes('"id":1')) finish(new Error(stderr || `MCP exited with code ${code}`));
    });
    timeout = setTimeout(() => finish(new Error('Timed out waiting for MCP tools/list')), 10000);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    })}\n`);
  });
}

async function main() {
  if (!targets.length) {
    console.log('No Antigravity MCP install directories found; nothing to deploy.');
    return;
  }

  const tools = await getFastTools();
  for (const target of targets) {
    fs.copyFileSync(path.join(root, 'mcp-server.js'), path.join(target, 'mcp-server.js'));
    fs.cpSync(path.join(root, 'lib'), path.join(target, 'lib'), { recursive: true, force: true });
    for (const tool of tools) {
      fs.writeFileSync(path.join(target, `${tool.name}.json`), `${JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }, null, 2)}\n`);
    }
    console.log(`Deployed MCP server, libraries, and ${tools.length} fast-profile tool schemas to ${target}`);
  }

  // Sync skills and global configurations for AGY CLI and Antigravity IDE
  try {
    require('./configure-agy.js');
  } catch (err) {
    console.warn('Could not run configure-agy.js:', err.message);
  }

  // Sync Codex configuration
  try {
    require('./configure-codex.js');
  } catch (err) {
    console.warn('Could not run configure-codex.js:', err.message);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
