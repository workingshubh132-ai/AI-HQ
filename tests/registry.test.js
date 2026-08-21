/**
 * STRUCTURAL INVARIANTS
 *
 * The Broker is only as good as the registries it reads. If an email tool is
 * ever registered as GREEN, every other control is bypassed legitimately —
 * the Broker would work correctly and an unapproved message would still go
 * out. These tests make that misconfiguration impossible to commit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupAction, allActionTypes, TIER, SIDE_EFFECT } from '../src/actions.js';
import { createTools } from '../src/tools.js';

const SOURCE_FILES = ['../src/actions.js', '../src/tools.js', '../src/broker.js', '../src/store.js', '../src/audit.js', '../src/payload.js'];

/** Removes block and line comments so prose cannot trip a code check. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('41. every registered tool maps to a known action type', () => {
  const { tools } = createTools();
  for (const tool of Object.values(tools)) {
    const action = lookupAction(tool.action_type);
    assert.equal(action.known, true, `${tool.tool_id} points at unregistered action ${tool.action_type}`);
  }
});

test('42. no externally side-effecting action may be GREEN', () => {
  for (const type of allActionTypes()) {
    const action = lookupAction(type);
    if (action.side_effect === SIDE_EFFECT.EXTERNAL) {
      assert.notEqual(action.tier, TIER.GREEN,
        `${type} touches the outside world and must never be GREEN`);
    }
  }
});

test('43. every externally side-effecting action requires idempotency', () => {
  for (const type of allActionTypes()) {
    const action = lookupAction(type);
    if (action.side_effect === SIDE_EFFECT.EXTERNAL) {
      assert.equal(action.idempotency_required, true,
        `${type} is external and must require an idempotency key`);
    }
  }
});

test('44. no source file imports a network, process or filesystem module', () => {
  // Checks the actual module graph, not prose. An earlier version of this
  // test matched raw substrings and flagged the comment in tools.js that
  // PROMISES not to import these — a false positive that proved nothing.
  const FORBIDDEN_MODULES = new Set([
    'http', 'https', 'net', 'dgram', 'tls', 'child_process', 'worker_threads',
    'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls',
    'node:child_process', 'node:worker_threads',
  ]);
  // Matches: from 'x'   require('x')   import('x')
  const SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

  for (const rel of SOURCE_FILES) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      assert.equal(FORBIDDEN_MODULES.has(spec), false, `${rel} imports ${spec}`);
    }
  }
});

test('44b. no source file calls a network global or reads an environment variable', () => {
  // Comments are stripped first so documentation cannot trip the check, and
  // the remaining text is executable code.
  const FORBIDDEN_CODE = ['fetch(', 'XMLHttpRequest', 'process.env', 'WebSocket', 'eval('];
  for (const rel of SOURCE_FILES) {
    const code = stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
    for (const needle of FORBIDDEN_CODE) {
      assert.equal(code.includes(needle), false, `${rel} contains ${needle} in executable code`);
    }
  }
});

test('45. an unknown action type resolves to RED, external, idempotent', () => {
  const unknown = lookupAction('definitely.not.registered');
  assert.equal(unknown.known, false);
  assert.equal(unknown.tier, TIER.RED);
  assert.equal(unknown.side_effect, SIDE_EFFECT.EXTERNAL);
  assert.equal(unknown.idempotency_required, true);
});

test('46. a non-string action type also resolves to RED', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(lookupAction(bad).tier, TIER.RED);
  }
});
