// Privacy-first locally stored workflow recipe library and failure reporter.
// Strictly local persistence in ~/.chrome-browser-bridge/recipes. Zero external telemetry.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { classifyError, RecoveryMatrix } = require('./errors');

function getRecipesDir() {
  const dir = path.join(os.homedir(), '.chrome-browser-bridge', 'recipes');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function validateRecipeSchema(recipe) {
  if (!recipe || typeof recipe !== 'object') throw new Error('Recipe must be an object');
  if (!Array.isArray(recipe.stages) || recipe.stages.length === 0) {
    throw new Error('Recipe must include at least one stage');
  }
  if (!Array.isArray(recipe.verify) || recipe.verify.length === 0) {
    throw new Error('Recipe must include verification assertions in verify');
  }
  for (const stage of recipe.stages) {
    if (!stage.id || !stage.action || !stage.params) {
      throw new Error(`Stage missing id, action, or params: ${JSON.stringify(stage)}`);
    }
  }
  return true;
}

function saveRecipe(name, recipe) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error('Recipe name must be 1-64 alphanumeric characters, dashes, or underscores');
  }
  validateRecipeSchema(recipe);
  const dir = getRecipesDir();
  const filePath = path.join(dir, `${name}.json`);
  const record = {
    name,
    description: recipe.description || `Workflow recipe ${name}`,
    createdAt: recipe.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inputs: recipe.inputs || {},
    stages: recipe.stages,
    verify: recipe.verify,
    allowedOrigins: recipe.allowedOrigins || []
  };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  return { ok: true, name, path: filePath };
}

function loadRecipe(name) {
  const dir = getRecipesDir();
  const filePath = path.join(dir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recipe not found: ${name}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function listRecipes() {
  const dir = getRecipesDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const list = [];
  for (const file of files) {
    try {
      const full = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      list.push({
        name: data.name || path.basename(file, '.json'),
        description: data.description || '',
        stagesCount: Array.isArray(data.stages) ? data.stages.length : 0,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
      });
    } catch {}
  }
  return list;
}

function exportRecipe(name) {
  const recipe = loadRecipe(name);
  return JSON.stringify({
    schemaVersion: '1.0.0',
    exportedAt: new Date().toISOString(),
    recipe
  }, null, 2);
}

function importRecipe(bundleOrJson) {
  let parsed = typeof bundleOrJson === 'string' ? JSON.parse(bundleOrJson) : bundleOrJson;
  const recipe = parsed.recipe || parsed;
  const name = recipe.name || `imported_${Date.now()}`;
  return saveRecipe(name, recipe);
}

function deleteRecipe(name) {
  const dir = getRecipesDir();
  const filePath = path.join(dir, `${name}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return { ok: true, deleted: name };
  }
  return { ok: false, error: 'Recipe not found' };
}

function generateFailureReport(resultOrError) {
  const classified = classifyError(resultOrError);
  const matrix = RecoveryMatrix[classified.code] || {};

  const lines = [
    '================================================================================',
    '                   AUTONOMOUS EXECUTION FAILURE REPORT                          ',
    '================================================================================',
    `Timestamp:           ${new Date().toISOString()}`,
    `Error Code:          ${classified.code}`,
    `Description:         ${matrix.description || 'Execution failed'}`,
    `Stage:               ${classified.stageId || 'Unknown'}`,
    `Tab ID:              ${classified.tabId ?? 'None'}`,
    `Outcome Known:       ${classified.outcomeKnown ? 'YES' : 'NO (Uncertain mutation)'}`,
    `Retry Safe:          ${classified.retrySafe ? 'YES (Side-effect free)' : 'NO (Do not replay)'}`,
    '--------------------------------------------------------------------------------',
    'DIAGNOSIS:',
    `  ${classified.message || 'No additional error details available'}`,
    '--------------------------------------------------------------------------------',
    'RECOMMENDED RECOVERY ACTION:',
    `  ${classified.suggestedRecovery || matrix.suggestedRecovery || 'Inspect DOM before retrying'}`,
    '================================================================================'
  ];

  if (resultOrError?.progress && Array.isArray(resultOrError.progress)) {
    lines.push('STAGE PROGRESSION:');
    for (const p of resultOrError.progress) {
      lines.push(`  - [${p.ok ? '✓ DONE' : p.skipped ? '↷ SKIP' : '✗ FAIL'}] ${p.id}`);
    }
    lines.push('--------------------------------------------------------------------------------');
  }

  if (resultOrError?.snapshot) {
    lines.push('RECOVERY DOM SNAPSHOT EXCERPT:');
    const snapLines = String(resultOrError.snapshot).split('\n').slice(0, 20);
    lines.push(snapLines.map(l => '  ' + l).join('\n'));
    if (snapLines.length >= 20) lines.push('  ... (snapshot truncated)');
    lines.push('================================================================================');
  }

  return lines.join('\n');
}

module.exports = {
  saveRecipe,
  loadRecipe,
  listRecipes,
  exportRecipe,
  importRecipe,
  deleteRecipe,
  generateFailureReport
};
