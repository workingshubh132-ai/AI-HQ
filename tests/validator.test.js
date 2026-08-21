/**
 * AGENT DEFINITION VALIDATOR
 *
 * The Broker denies a bad tool CALL. This denies a bad agent EXISTING.
 * One validator protects every agent — the property that has to hold if the
 * workforce is ever to reach 250 without 250 bespoke test suites.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentVersion, validateAgentRecord, POLICY } from '../src/validator.js';
import { VERSION_STATE, RUNTIME_STATE } from '../src/agents.js';
import { createTools } from '../src/tools.js';
import { demoAgentVersion } from '../src/demo-agent.js';

const { tools } = createTools();
const validate = (v) => validateAgentVersion(v, { tools });

/** A known-good definition, mutated per test. */
function good(overrides = {}) {
  return { ...demoAgentVersion({ state: VERSION_STATE.APPROVED }), ...overrides };
}
const rejects = (v, needle) => {
  const r = validate(v);
  assert.equal(r.valid, false, `expected rejection: ${needle}`);
  assert.ok(r.errors.some((e) => e.includes(needle)), `expected an error mentioning "${needle}", got: ${r.errors.join(' | ')}`);
};

test('67. a valid definition is accepted', () => {
  const r = validate(good());
  assert.equal(r.valid, true, r.errors.join(' | '));
  assert.deepEqual(r.errors, []);
});

test('68. a non-object definition is rejected', () => {
  for (const bad of [null, undefined, 42, 'agent', []]) {
    assert.equal(validate(bad).valid, false);
  }
});

test('69. a missing required field is rejected', () => {
  for (const field of ['agent_id', 'purpose', 'department', 'clearance', 'allowed_tools', 'limits', 'state']) {
    const v = good(); delete v[field];
    rejects(v, `missing required field: ${field}`);
  }
});

test('70. a malformed version string is rejected', () => {
  for (const bad of ['1', 'v1.0.0', '1.0', 'latest', 1]) rejects(good({ version: bad }), 'semver');
});

test('71. an unrecognised version state is rejected', () => {
  rejects(good({ state: 'live' }), 'unrecognised version state');
});

test('72. RED clearance is prohibited', () => {
  rejects(good({ clearance: 'RED' }), 'RED clearance is prohibited');
});

test('73. an unknown clearance is rejected', () => {
  for (const bad of ['BLUE', 'green', '', null]) rejects(good({ clearance: bad }), 'clearance');
});

test('74. allowed_tools must be an array of strings', () => {
  rejects(good({ allowed_tools: 'text.wordcount' }), 'allowed_tools must be an array');
  rejects(good({ allowed_tools: [42] }), 'must be strings');
});

test('75. an unknown tool is rejected', () => {
  rejects(good({ allowed_tools: ['nonexistent.tool'] }), 'unknown tool');
});

test('76. a tool whose tier exceeds the clearance is rejected', () => {
  // This is the rule the file exists for: a GREEN agent must never be
  // ACTIVATABLE holding a YELLOW tool, even though the Broker would deny
  // every individual call.
  rejects(good({ clearance: 'GREEN', allowed_tools: ['fake.send_message'] }), 'is YELLOW but the agent');
  rejects(good({ clearance: 'YELLOW', allowed_tools: ['fake.transfer_funds'] }), 'is RED but the agent');
});

test('77. a tool mapping to an unreachable action type is rejected', () => {
  const broken = { ...tools, 'broken.tool': { tool_id: 'broken.tool', action_type: 'nowhere.action', cost: 1, scope_schema: null, handler() {} } };
  const r = validateAgentVersion(good({ allowed_tools: ['broken.tool'] }), { tools: broken });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('unreachable action type')));
});

test('78. a forbidden tool combination is rejected', () => {
  // Read the outside world and write to it in one agent = a one-hop path
  // from injected text to a published action.
  const withPublish = {
    ...tools,
    'fake.publish': { tool_id: 'fake.publish', action_type: 'content.publish', cost: 5, scope_schema: null, handler() {} },
  };
  const r = validateAgentVersion(
    good({ clearance: 'YELLOW', allowed_tools: ['text.wordcount', 'fake.publish'] }),
    { tools: withPublish },
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('forbidden tool combination')));
});

test('79. malformed contracts are rejected', () => {
  rejects(good({ input_contract: 'text' }), 'input_contract must be an object');
  rejects(good({ output_contract: { types: {} } }), 'output_contract must declare a "required" array');
});

test('80. missing limits are rejected', () => {
  rejects(good({ limits: {} }), 'limits.max_attempts is required');
  rejects(good({ limits: 'none' }), 'limits must be an object');
});

test('81. zero and negative limits are rejected', () => {
  rejects(good({ limits: { ...good().limits, max_attempts: 0 } }), 'greater than zero');
  rejects(good({ limits: { ...good().limits, max_cost_per_task: -1 } }), 'greater than zero');
});

test('82. limits above the policy ceiling are rejected', () => {
  rejects(good({ limits: { ...good().limits, max_attempts: POLICY.max_attempts + 1 } }), 'exceeds the policy ceiling');
  rejects(good({ limits: { ...good().limits, max_runtime_ms: POLICY.max_runtime_ms * 2 } }), 'exceeds the policy ceiling');
});

test('83. non-numeric limits are rejected', () => {
  rejects(good({ limits: { ...good().limits, max_attempts: 'three' } }), 'finite number');
  rejects(good({ limits: { ...good().limits, max_attempts: Infinity } }), 'finite number');
});

test('84. a non-empty model_config is rejected while no provider is approved', () => {
  rejects(good({ model_config: { model: 'some-model' } }), 'no model provider is approved yet');
  rejects(good({ model_config: 'fast' }), 'model_config must be an object');
});

test('85. malformed capabilities are rejected', () => {
  rejects(good({ capabilities: 'research' }), 'capabilities must be an array');
  rejects(good({ capabilities: [42] }), 'non-empty strings');
  rejects(good({ capabilities: [''] }), 'non-empty strings');
});

test('86. the agent record is validated separately from the version', () => {
  assert.equal(validateAgentRecord({ id: 'a', slug: 'wordcount-agent', lifecycle_state: RUNTIME_STATE.ACTIVE }).valid, true);
  assert.equal(validateAgentRecord({ id: 'a', slug: 'Wordcount Agent', lifecycle_state: 'active' }).valid, false);
  assert.equal(validateAgentRecord({ id: 'a', slug: 'ok-slug', lifecycle_state: 'approved' }).valid, false);
  assert.equal(validateAgentRecord({ slug: 'ok-slug', lifecycle_state: 'active' }).valid, false);
});

test('87. validation is deterministic', () => {
  const v = good({ clearance: 'GREEN', allowed_tools: ['fake.send_message', 'nope.tool'] });
  assert.deepEqual(validate(v).errors, validate(v).errors);
});
