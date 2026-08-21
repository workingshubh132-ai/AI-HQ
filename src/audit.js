/**
 * AUDIT SINK
 *
 * Append-only at the application level, per DECISIONS D-audit / Constitution
 * section 24. There is no update path and no delete path — not because they
 * are guarded, but because they do not exist.
 *
 * Denied calls are the highest-value records here: an allowed call is business
 * as usual, a denied one is the architecture reporting that something tried to
 * step outside its boundary.
 */

/**
 * @returns {{write:(r:object)=>void, all:()=>object[], count:()=>number, last:()=>object|null}}
 */
export function createAuditSink() {
  /** @type {readonly object[]} */
  const records = [];

  return {
    /** Records are frozen on write. Stored history cannot be edited in place. */
    write(record) {
      records.push(Object.freeze({ ...record }));
    },

    /** Returns copies. A caller mutating the result cannot alter history. */
    all() {
      return records.map((r) => ({ ...r }));
    },

    count() {
      return records.length;
    },

    last() {
      return records.length ? { ...records[records.length - 1] } : null;
    },
  };
}
