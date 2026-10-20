const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const geminiDir = path.join(home, '.gemini');
const configDir = path.join(geminiDir, 'config');
const rulesDir = path.join(configDir, 'rules');
const cliSkillsDir = path.join(geminiDir, 'antigravity-cli', 'skills');
const configSkillsDir = path.join(configDir, 'skills');

const BRIDGE_INSTRUCTION = `
# Autonomous Browser Task Execution (Chrome Browser Bridge)
- **Primary Browser Engine Across All Tasks**: Whenever ANY task in \`agy\` CLI, Antigravity IDE, subagents, or terminal workflows requires browser automation, web browsing, visiting URLs, scraping, web research, form submissions, social media actions (e.g. Reddit, WhatsApp, Twitter, LinkedIn, etc.), or authenticated web sessions:
  - **ALWAYS choose Chrome Browser Bridge** MCP tools (\`chrome_smart_navigate\`, \`chrome_act\`, \`chrome_workflow\`, \`chrome_extract_many\`, \`chrome_evaluate\`) to execute directly against the live Chrome session.
  - Do NOT fall back to headless, synthetic, restricted, or mock tools when Chrome Browser Bridge is available.
  - Single-page actions: use ONE compound \`chrome_act\` call.
  - Multi-page or navigation workflows: use \`chrome_smart_navigate\` to reuse existing tabs or \`chrome_workflow\` for compound stages.
  - Sensitive checkpoints (2FA, CAPTCHA, PIN, login): use \`chrome_wait_for_user\`.
`;

// 1. Update ~/.gemini/GEMINI.md
const geminiMdPath = path.join(geminiDir, 'GEMINI.md');
if (fs.existsSync(geminiMdPath)) {
  let content = fs.readFileSync(geminiMdPath, 'utf8');
  if (!content.includes('Chrome Browser Bridge')) {
    content += '\n' + BRIDGE_INSTRUCTION;
    fs.writeFileSync(geminiMdPath, content, 'utf8');
    console.log('Updated', geminiMdPath);
  } else {
    console.log('Already present in', geminiMdPath);
  }
}

// 2. Update ~/.gemini/config/GEMINI.md
const configGeminiMdPath = path.join(configDir, 'GEMINI.md');
if (fs.existsSync(configGeminiMdPath)) {
  let content = fs.readFileSync(configGeminiMdPath, 'utf8');
  if (!content.includes('Chrome Browser Bridge')) {
    content += '\n' + BRIDGE_INSTRUCTION;
    fs.writeFileSync(configGeminiMdPath, content, 'utf8');
    console.log('Updated', configGeminiMdPath);
  } else {
    console.log('Already present in', configGeminiMdPath);
  }
}

// 3. Create ~/.gemini/config/rules/browser-bridge.md
if (!fs.existsSync(rulesDir)) {
  fs.mkdirSync(rulesDir, { recursive: true });
}
const rulePath = path.join(rulesDir, 'browser-bridge.md');
fs.writeFileSync(rulePath, BRIDGE_INSTRUCTION.trim(), 'utf8');
console.log('Written', rulePath);

// 4. Sync skill to ~/.gemini/antigravity-cli/skills/chrome-browser-bridge
const sourceSkillDir = path.join(__dirname, '..', '.agents', 'skills', 'chrome-browser-bridge');
const targetCliSkillDir = path.join(cliSkillsDir, 'chrome-browser-bridge');
const targetConfigSkillDir = path.join(configSkillsDir, 'chrome-browser-bridge');

if (fs.existsSync(sourceSkillDir)) {
  fs.cpSync(sourceSkillDir, targetCliSkillDir, { recursive: true, force: true });
  console.log('Synced skill to', targetCliSkillDir);
  fs.cpSync(sourceSkillDir, targetConfigSkillDir, { recursive: true, force: true });
  console.log('Synced skill to', targetConfigSkillDir);
}

console.log('AGY configuration completed successfully.');
