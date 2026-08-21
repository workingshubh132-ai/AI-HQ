/**
 * AGENT DEFINITION VALIDATOR
 *
 * One validator for every agent, now and at 250.
 *
 * The Broker denies a bad tool CALL. This denies a bad agent EXISTING. They
 * are different jobs: a GREEN agent holding an email tool would be refused
 * every time it tried to send — but it should never have been activatable in
 * the first place, and a definition that only fails at call time is a latent
 * incident waiting for the right task.
 *
 * This is NOT a replacement for the Broker. The Broker remains the final
 * authority on every individual action. This is the gate before activation.
 *
 * Deterministic: same input, same errors, same order. No I/O, no clock.
 *
 * Constitution: sections 8, 15, 25.
 */

import { lookupAction, tierRank, TIER } from './actions.js';
import { VERSION_STATE, RUNTIME_STATE } from './agents.js';

/**
 * Policy ceilings. A version may declare limits at or below these; anything
 * above is rejected, so no agent definition can quietly grant itself more
 * headroom than policy allows.
 */
export const POLICY = Object.freeze({
  max_attempts: 10,
  max_cost_per_task: 1000,
  max_runtime_ms: 300_000,
});

/**
 * Action types that may not be held by one agent at the same time.
 *
 * The pattern being blocked: an agent that can read from the outside world
 * AND write to it is a one-hop path from a prompt injection in fetched text
 * to a published action. Splitting them across two agents forces the output
 * through a task record, where it is inspectable.
 *
 * Declared as explicit pairs rather than a heuristic, so the rule is
 * auditable and testable rather than a judgement call at validation time.
 */
export const FORBIDDEN_ACTION_PAIRS = Object.freeze([
  Object.freeze(['text.analyze', 'content.publish']),
  Object.freeze(['data.score', 'content.publish']),
  Object.freeze(['text.analyze', 'message.send']),
]);

const REQUIRED_VERSION_FIELDS = [
  'agent_id', 'version', 'purpose', 'department',
  'clearance', 'allowed_tools', 'limits',
  'input_contract', 'output_contract', 'state',
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} version
 * @param {{tools: Record<string,object>}} deps
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateAgentVersion(version, { tools }) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  // ── shape ─────────────────────────────────────────────────────────────
  if (!isPlainObject(version)) {
    return { valid: false, errors: ['definition is not an object'] };
  }
  for (const field of REQUIRED_VERSION_FIELDS) {
    if (version[field] === undefined || version[field] === null) fail(`missing required field: ${field}`);
  }
  if (typeof version.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version.version ?? '')) {
    fail('version must be a semver-shaped string, e.g. 1.0.0');
  }
  if (!Object.values(VERSION_STATE).includes(version.state)) {
    fail(`unrecognised version state: ${JSON.stringify(version.state)}`);
  }

  // ── clearance ─────────────────────────────────────────────────────────
  if (version.clearance === TIER.RED) {
    fail('RED clearance is prohibited: RED actions are human-only and no agent may hold it');
  } else if (![TIER.GREEN, TIER.YELLOW].includes(version.clearance)) {
    fail(`unknown clearance: ${JSON.stringify(version.clearance)}`);
  }

  // ── tools ─────────────────────────────────────────────────────────────
  if (!Array.isArray(version.allowed_tools)) {
    fail('allowed_tools must be an array');
  } else {
    const heldActions = [];
    for (const toolId of version.allowed_tools) {
      if (typeof toolId !== 'string') { fail('allowed_tools entries must be strings'); continue; }

      const tool = Object.hasOwn(tools, toolId) ? tools[toolId] : null;
      if (!tool) { fail(`unknown tool: ${toolId}`); continue; }

      const action = lookupAction(tool.action_type);
      if (!action.known) {
        fail(`tool ${toolId} maps to an unreachable action type: ${tool.action_type}`);
        continue;
      }
      heldActions.push(action.action_type);

      // The rule that matters most in this file.
      if (tierRank(action.tier) > tierRank(version.clearance)) {
        fail(`tool ${toolId} is ${action.tier} but the agent's clearance is ${version.clearance}`);
      }
    }

    for (const [a, b] of FORBIDDEN_ACTION_PAIRS) {
      if (heldActions.includes(a) && heldActions.includes(b)) {
        fail(`forbidden tool combination: an agent may not hold both ${a} and ${b}`);
      }
    }
  }

  // ── contracts ─────────────────────────────────────────────────────────
  for (const key of ['input_contract', 'output_contract']) {
    const contract = version[key];
    if (contract !== undefined && contract !== null && !isPlainObject(contract)) {
      fail(`${key} must be an object`);
    } else if (isPlainObject(contract) && !Array.isArray(contract.required)) {
      fail(`${key} must declare a "required" array, even if empty`);
    }
  }

  // ── limits ────────────────────────────────────────────────────────────
  const limits = version.limits;
  if (!isPlainObject(limits)) {
    fail('limits must be an object');
  } else {
    for (const [key, ceiling] of Object.entries(POLICY)) {
      const value = limits[key];
      if (value === undefined) { fail(`limits.${key} is required`); continue; }
      if (!Number.isFinite(value)) { fail(`limits.${key} must be a finite number`); continue; }
      if (value <= 0) { fail(`limits.${key} must be greater than zero`); continue; }
      if (value > ceiling) fail(`limits.${key} of ${value} exceeds the policy ceiling of ${ceiling}`);
    }
  }

  // ── model configuration ───────────────────────────────────────────────
  if (version.model_config !== undefined && version.model_config !== null) {
    if (!isPlainObject(version.model_config)) {
      fail('model_config must be an object');
    } else if (Object.keys(version.model_config).length > 0) {
      // No model provider exists yet. A version claiming one is either a
      // mistake or an attempt to reach capability that has not been built,
      // reviewed or budgeted. Fail closed until Milestone 5.3.
      fail('model_config must be empty: no model provider is approved yet');
    }
  }

  // ── capabilities (advisory, but must be well-formed) ──────────────────
  if (version.capabilities !== undefined) {
    if (!Array.isArray(version.capabilities)) {
      fail('capabilities must be an array');
    } else if (!version.capabilities.every((c) => typeof c === 'string' && c !== '')) {
      fail('capabilities must be non-empty strings');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the mutable agent record. Separate from the version, because
 * they are separate facts.
 */
export function validateAgentRecord(agent) {
  const errors = [];
  if (!isPlainObject(agent)) return { valid: false, errors: ['agent is not an object'] };
  if (typeof agent.id !== 'string' || agent.id === '') errors.push('missing id');
  if (typeof agent.slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(agent.slug ?? '')) {
    errors.push('slug must be lowercase and hyphenated');
  }
  if (!Object.values(RUNTIME_STATE).includes(agent.lifecycle_state)) {
    errors.push(`unrecognised lifecycle state: ${JSON.stringify(agent.lifecycle_state)}`);
  }
  return { valid: errors.length === 0, errors };
}
