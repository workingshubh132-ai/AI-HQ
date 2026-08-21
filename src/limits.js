/**
 * TASK TREE LIMITS
 *
 * RECORDED, NOT ENFORCED. Milestone 5 runs one task; there are no trees, so
 * there is nothing to enforce against. These constants exist so the values
 * are decided once, in code, rather than rediscovered later.
 *
 * When trees arrive, MAX_TOTAL_NODES is the one that matters most. Depth and
 * fan-out alone permit 8^4 ≈ 4,600 tasks while both limits read as
 * "satisfied" — a bounded tree on paper and a catastrophe in practice.
 *
 * Constitution: section 18.
 */

import { hashPayload } from './payload.js';

export const MAX_DEPTH = 4;
export const MAX_FANOUT = 8;
export const MAX_TOTAL_NODES = 32;

/**
 * Deterministic identity for a unit of work.
 *
 * Two tasks with the same signature inside one tree are the same work being
 * done twice — the cheapest available loop signal. Recorded on every task
 * now so the detector has data to run against when it is built.
 *
 * @param {{agent_slug:string, action_type:string, input:unknown}} task
 * @returns {string} 64 hex characters
 */
export function taskSignature({ agent_slug, action_type, input }) {
  return hashPayload({ agent_slug, action_type, input });
}
