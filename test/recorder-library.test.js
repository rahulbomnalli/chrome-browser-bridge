const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getSemanticSelector, isSensitiveField, generateWorkflowPlan } = require('../extension/recorder');
const {
  saveRecipe,
  loadRecipe,
  listRecipes,
  exportRecipe,
  importRecipe,
  deleteRecipe,
  generateFailureReport
} = require('../lib/workflow-library');
const { ErrorCode, classifyError, RecoveryMatrix } = require('../lib/errors');

test('recorder: generates resilient semantic selectors', () => {
  // Mock element with data-testid
  const testIdEl = {
    nodeType: 1,
    hasAttribute: (a) => a === 'data-testid',
    getAttribute: (a) => a === 'data-testid' ? 'login-submit' : null
  };
  assert.equal(getSemanticSelector(testIdEl), '[data-testid="login-submit"]');

  // Mock element with ID
  const idEl = {
    nodeType: 1,
    id: 'user-email-input',
    hasAttribute: () => false,
    getAttribute: () => null
  };
  assert.equal(getSemanticSelector(idEl), '#user-email-input');

  // Mock form element with name
  const nameEl = {
    nodeType: 1,
    tagName: 'INPUT',
    name: 'search_query',
    hasAttribute: () => false,
    getAttribute: () => null
  };
  assert.equal(getSemanticSelector(nameEl), 'input[name="search_query"]');
});

test('recorder: identifies sensitive credential fields for placeholder redaction', () => {
  const pwdEl = {
    getAttribute: (a) => a === 'type' ? 'password' : null
  };
  assert.equal(isSensitiveField(pwdEl), true);

  const tokenEl = {
    getAttribute: (a) => a === 'name' ? 'csrf_token' : null
  };
  assert.equal(isSensitiveField(tokenEl), true);

  const regularEl = {
    getAttribute: (a) => a === 'type' ? 'text' : a === 'name' ? 'username' : null
  };
  assert.equal(isSensitiveField(regularEl), false);
});

test('recorder: generates valid chrome_workflow schema from recorded steps', () => {
  const rawSteps = [
    { action: 'type', selector: '#user', value: 'admin', sensitive: false, fieldName: 'user' },
    { action: 'type', selector: '#pass', value: '{{inputs.password}}', sensitive: true, fieldName: 'password' },
    { action: 'click', selector: '#submit' }
  ];

  const plan = generateWorkflowPlan(rawSteps, 'https://example.test/login');
  assert.ok(Array.isArray(plan.stages));
  assert.equal(plan.stages[0].action, 'navigate');
  assert.equal(plan.stages[0].params.url, 'https://example.test/login');
  assert.ok(plan.stages.some(s => s.action === 'act'));
  assert.ok(Array.isArray(plan.verify));
  assert.equal(plan.verify[0].selector, '#submit');
  assert.equal(plan.inputs.password, '');
});

test('workflow-library: saves, loads, lists, exports, imports and deletes recipes', () => {
  const testRecipe = {
    description: 'Automated test recipe',
    stages: [
      { id: 'step_1', action: 'navigate', params: { url: 'https://test.local' } }
    ],
    verify: [{ selector: '#app' }]
  };

  const recipeName = `test_recipe_${Date.now()}`;
  const saveRes = saveRecipe(recipeName, testRecipe);
  assert.equal(saveRes.ok, true);

  const loaded = loadRecipe(recipeName);
  assert.equal(loaded.name, recipeName);
  assert.equal(loaded.stages[0].action, 'navigate');

  const list = listRecipes();
  assert.ok(list.some(r => r.name === recipeName));

  const exported = exportRecipe(recipeName);
  assert.ok(typeof exported === 'string');
  assert.ok(exported.includes(recipeName));

  const importedName = `imported_${recipeName}`;
  const importRes = importRecipe({ ...JSON.parse(exported), recipe: { ...testRecipe, name: importedName } });
  assert.equal(importRes.ok, true);

  deleteRecipe(recipeName);
  deleteRecipe(importedName);
  assert.throws(() => loadRecipe(recipeName), /not found/);
});

test('workflow-library: generates human-readable diagnostic failure reports', () => {
  const failure = {
    code: 'ELEMENT_MISSING',
    stageId: 'click_checkout',
    tabId: 4,
    error: 'Could not find element matching #checkout-btn',
    progress: [
      { id: 'navigate_cart', ok: true },
      { id: 'click_checkout', ok: false }
    ],
    snapshot: '<div>Cart is empty</div>'
  };

  const report = generateFailureReport(failure);
  assert.ok(report.includes('ELEMENT_MISSING'));
  assert.ok(report.includes('click_checkout'));
  assert.ok(report.includes('RECOMMENDED RECOVERY ACTION'));
  assert.ok(report.includes('Cart is empty'));
});

test('errors: taxonomy enforces retry safety and recovery rules', () => {
  assert.equal(RecoveryMatrix[ErrorCode.ELEMENT_MISSING].retrySafe, true);
  assert.equal(RecoveryMatrix[ErrorCode.MUTATION_UNCERTAIN].retrySafe, false);
  assert.equal(RecoveryMatrix[ErrorCode.AUTH_REQUIRED].retrySafe, false);

  const classified = classifyError(new Error('Deadline exceeded after 30000ms'));
  assert.equal(classified.code, ErrorCode.DEADLINE_EXCEEDED);
  assert.equal(classified.retrySafe, false);
});
