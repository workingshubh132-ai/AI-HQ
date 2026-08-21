/**
 * SHARED CONTRACT CHECKING
 *
 * Extracted from runtime.js verbatim — same logic, same behavior, now used
 * by both the agent runtime (input/output contracts) and the model runtime
 * (validating what a provider returns before anything downstream trusts
 * it). A pure mechanical extraction: no behavior changed, proven by the
 * full existing suite passing unchanged after the extraction.
 *
 * Deliberately small: required keys and declared types, nothing more. A
 * schema language is not needed to prove a contract, and every feature
 * added here is a feature that can be wrong.
 */

export const TYPE_OF = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * @param {{required?: string[], types?: Record<string,string>}|null|undefined} contract
 * @param {unknown} value
 * @returns {string|null} an error message, or null if the value satisfies the contract
 */
export function checkContract(contract, value) {
  if (!contract || typeof contract !== 'object') return null;
  if (!value || typeof value !== 'object') return 'value is not an object';

  for (const key of contract.required ?? []) {
    if (value[key] === undefined || value[key] === null) return `missing required field: ${key}`;
  }
  for (const [key, expected] of Object.entries(contract.types ?? {})) {
    if (value[key] === undefined) continue;
    const actual = TYPE_OF(value[key]);
    if (actual !== expected) return `field ${key} must be ${expected}, got ${actual}`;
  }
  return null;
}
