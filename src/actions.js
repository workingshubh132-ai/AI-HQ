/**
 * ACTION REGISTRY
 *
 * The single source of truth for how risky an action is.
 *
 * Tier is STATIC DATA. No agent, prompt, or runtime code may decide the tier
 * of an action. If an agent could classify its own actions it could classify
 * a YELLOW as GREEN, and every other control in AI-HQ would rest on the
 * honesty of the thing being constrained.
 *
 * Constitution: sections 9, 10.
 */

/** @typedef {'GREEN'|'YELLOW'|'RED'} Tier */
/** @typedef {'none'|'internal'|'external'} SideEffect */

export const TIER = Object.freeze({ GREEN: 'GREEN', YELLOW: 'YELLOW', RED: 'RED' });

export const SIDE_EFFECT = Object.freeze({
  NONE: 'none',
  INTERNAL: 'internal',
  EXTERNAL: 'external',
});

/** Ordering used for clearance comparison. Higher number = more dangerous. */
const TIER_RANK = Object.freeze({ GREEN: 1, YELLOW: 2, RED: 3 });

/**
 * @param {Tier} tier
 * @returns {number} rank, or Infinity for anything unrecognised (fail closed)
 */
export function tierRank(tier) {
  return TIER_RANK[tier] ?? Number.POSITIVE_INFINITY;
}

/**
 * Returned for any action_type not in the registry.
 *
 * This is a VALUE, not `undefined`. An absent lookup invites a
 * `if (!action)` branch that someone later "fixes" into an allow. An unknown
 * action is a known thing: it is RED, externally side-effecting, and requires
 * idempotency — the most restrictive interpretation available.
 *
 * Constitution section 9: "Unknown action types default to RED."
 */
export const UNKNOWN_ACTION = Object.freeze({
  known: false,
  action_type: null,
  tier: TIER.RED,
  side_effect: SIDE_EFFECT.EXTERNAL,
  idempotency_required: true,
});

/**
 * The registry itself. Frozen at module load — nothing can add an action
 * at runtime.
 */
const ACTIONS = Object.freeze({
  'text.analyze': Object.freeze({
    known: true,
    action_type: 'text.analyze',
    tier: TIER.GREEN,
    side_effect: SIDE_EFFECT.NONE,
    idempotency_required: false,
  }),
  'data.score': Object.freeze({
    known: true,
    action_type: 'data.score',
    tier: TIER.GREEN,
    side_effect: SIDE_EFFECT.NONE,
    idempotency_required: false,
  }),
  'record.write_own': Object.freeze({
    known: true,
    action_type: 'record.write_own',
    tier: TIER.GREEN,
    side_effect: SIDE_EFFECT.INTERNAL,
    idempotency_required: false,
  }),
  'message.send': Object.freeze({
    known: true,
    action_type: 'message.send',
    tier: TIER.YELLOW,
    side_effect: SIDE_EFFECT.EXTERNAL,
    idempotency_required: true,
  }),
  'content.publish': Object.freeze({
    known: true,
    action_type: 'content.publish',
    tier: TIER.YELLOW,
    side_effect: SIDE_EFFECT.EXTERNAL,
    idempotency_required: true,
  }),
  'funds.transfer': Object.freeze({
    known: true,
    action_type: 'funds.transfer',
    tier: TIER.RED,
    side_effect: SIDE_EFFECT.EXTERNAL,
    idempotency_required: true,
  }),
  'credentials.change': Object.freeze({
    known: true,
    action_type: 'credentials.change',
    tier: TIER.RED,
    side_effect: SIDE_EFFECT.EXTERNAL,
    idempotency_required: true,
  }),
});

/**
 * @param {unknown} actionType
 * @returns {typeof UNKNOWN_ACTION | Readonly<{known:true, action_type:string, tier:Tier, side_effect:SideEffect, idempotency_required:boolean}>}
 */
export function lookupAction(actionType) {
  if (typeof actionType !== 'string') return UNKNOWN_ACTION;
  return Object.hasOwn(ACTIONS, actionType) ? ACTIONS[actionType] : UNKNOWN_ACTION;
}

/** @returns {string[]} every registered action type */
export function allActionTypes() {
  return Object.keys(ACTIONS);
}
