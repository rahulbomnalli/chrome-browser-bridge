const fs = require('fs');
const path = require('path');
const os = require('os');

const codexAgentsPath = path.join(os.homedir(), '.codex', 'AGENTS.md');
const codexAgentsContent = `# Codex Agent Instructions

## Browser Automation & Web Tasks
Whenever any task involves the browser, web pages, navigating URLs, online research, social posting, or interacting with web applications:
- **ALWAYS choose Chrome Browser Bridge**: Use the MCP tools provided by \`chrome-browser-bridge\` (\`chrome_smart_navigate\`, \`chrome_act\`, \`chrome_workflow\`, \`chrome_evaluate\`, \`chrome_extract_many\`).
- **NEVER use Owl / computer-use / internal browser tools**: The built-in Owl browser lacks visibility capabilities and cannot create windows. Chrome Browser Bridge connects directly to the user's real Chrome browser with live sessions and logins.
- **Single-page tasks**: Use one compound \`chrome_act\` call.
- **Navigation / Multi-page tasks**: Use \`chrome_smart_navigate\` to reuse existing tabs or \`chrome_workflow\` for compound stages.
`;

fs.writeFileSync(codexAgentsPath, codexAgentsContent, 'utf8');
console.log('Successfully updated', codexAgentsPath);
