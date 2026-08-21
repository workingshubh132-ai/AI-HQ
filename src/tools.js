/**
 * TOOL REGISTRY
 *
 * Every tool AI-HQ can invoke, with the action_type that classifies it.
 *
 * MILESTONE 4 CONTAINS NO REAL TOOLS.
 *
 * Every handler below is fake. Nothing in this file imports node:http,
 * node:net, fetch, or any credential. The milestone ships with no code
 * capable of reaching the network, which is a stronger guarantee than a
 * promise not to use it.
 *
 * Constitution: sections 13, 38.
 */

/**
 * @typedef {object} Tool
 * @property {string} tool_id
 * @property {string} action_type      must exist in the action registry
 * @property {number} cost             charged against budgets on execution
 * @property {ScopeSchema|null} scope_schema
 * @property {(payload:object)=>unknown} handler
 */

/**
 * @typedef {object} ScopeSchema
 * @property {string[]} required   payload keys that must be present
 * @property {Record<string,string[]>} allow  permitted values per key
 */

/**
 * Builds a fresh tool set with its own outbox and invocation counter.
 *
 * A factory, not module-level state, so every test starts clean and the
 * invocation counter means exactly what it says.
 *
 * @returns {{tools: Record<string,Tool>, outbox: object[], invocations: () => number}}
 */
export function createTools() {
  /** Simulated external deliveries. Nothing leaves the process. */
  const outbox = [];

  /** Counts EVERY handler entry, including the RED tripwire. */
  let invocations = 0;

  /** @type {Record<string, Tool>} */
  const tools = {
    'text.wordcount': {
      tool_id: 'text.wordcount',
      action_type: 'text.analyze',
      cost: 1,
      scope_schema: { required: ['text'], allow: {} },
      handler(payload) {
        invocations++;
        const words = String(payload.text).trim().split(/\s+/).filter(Boolean);
        return { words: words.length };
      },
    },

    'lead.score': {
      tool_id: 'lead.score',
      action_type: 'data.score',
      cost: 1,
      scope_schema: { required: ['lead'], allow: {} },
      handler(payload) {
        invocations++;
        const lead = payload.lead ?? {};
        // Deterministic arithmetic on fake data. No research, no network.
        const score =
          (lead.has_website === false ? 40 : 0) +
          (Number(lead.reviews) > 50 ? 30 : 0) +
          (lead.category === 'restaurant' ? 30 : 0);
        return { score };
      },
    },

    'fake.send_message': {
      tool_id: 'fake.send_message',
      action_type: 'message.send',
      cost: 5,
      scope_schema: {
        required: ['recipient_domain', 'body'],
        allow: { recipient_domain: ['approved-client.example', 'test.local'] },
      },
      handler(payload) {
        invocations++;
        // Appends to an in-memory array. Sends nothing, anywhere, ever.
        outbox.push({ to: payload.recipient_domain, body: payload.body });
        return { delivered: true, outbox_index: outbox.length - 1 };
      },
    },

    'fake.transfer_funds': {
      tool_id: 'fake.transfer_funds',
      action_type: 'funds.transfer',
      cost: 100,
      scope_schema: { required: ['amount'], allow: {} },
      handler() {
        invocations++;
        // TRIPWIRE.
        //
        // RED actions must never be executable by an agent. This handler is
        // registered only so the denial path can be tested. If any code path
        // ever reaches it, that is a security failure and the test suite must
        // fail loudly rather than pass quietly.
        throw new Error('SECURITY FAILURE: RED handler was invoked');
      },
    },
  };

  return { tools, outbox, invocations: () => invocations };
}
