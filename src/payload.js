/**
 * PAYLOAD INTEGRITY
 *
 * Binds human consent to the exact bytes that will execute.
 *
 * An agent writes the payload AND, if allowed, the text describing it. If
 * the human reads agent-authored text and the Broker executes an
 * agent-authored payload, nothing connects the two — the human can consent
 * to one thing while the system performs another.
 *
 * Two functions close that gap:
 *
 *   hashPayload    what the human authorized, as 64 hex characters
 *   renderPayload  what the human reads, generated here, never by an agent
 *
 * Constitution: section 11 (approval security).
 */

import { createHash } from 'node:crypto';

/** Longest a single field may be before the rendering truncates it. */
const MAX_FIELD_CHARS = 400;

/**
 * Deterministic serialization. Key order in the source object cannot change
 * the output, so two payloads that differ only in key order hash the same
 * and two that differ in any value do not.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * SHA-256 of the stable serialization, lowercase hex.
 *
 * @param {unknown} payload
 * @returns {string} 64 hex characters
 */
export function hashPayload(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * One field, truncated for display but never silently.
 *
 * The marker matters: a human must be able to tell that there is more text
 * than they are being shown. The hash always covers the full value.
 */
function renderValue(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  if (text.length <= MAX_FIELD_CHARS) return text;
  const hidden = text.length - MAX_FIELD_CHARS;
  return `${text.slice(0, MAX_FIELD_CHARS)} … [+${hidden} more characters not shown]`;
}

/**
 * The authoritative human-facing description of an action.
 *
 * EXHAUSTIVE over the payload's keys, deliberately. A per-tool renderer that
 * printed only the fields it considered interesting would let every other
 * field hide from the person approving. Prettier output is not worth that.
 *
 * @param {string} toolId
 * @param {string} actionType
 * @param {unknown} payload
 * @returns {string}
 */
export function renderPayload(toolId, actionType, payload) {
  const lines = [`Tool: ${toolId}`, `Action: ${actionType}`];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    lines.push(`Payload: ${renderValue(payload)}`);
    return lines.join('\n');
  }

  const keys = Object.keys(payload).sort();
  if (keys.length === 0) {
    lines.push('Payload: (empty)');
    return lines.join('\n');
  }
  for (const key of keys) lines.push(`${key}: ${renderValue(payload[key])}`);
  return lines.join('\n');
}
