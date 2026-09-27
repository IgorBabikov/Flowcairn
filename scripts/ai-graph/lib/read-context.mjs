import { GraphError } from './io.mjs';

/** Reuse discovery only during one synchronous read/validation phase.
 * End the scope before awaits, mutations or workspace fingerprint checks. */
export function createReadContext() {
  /** @type {Map<string, unknown> | null} */
  let values = null;
  return {
    /** @template T @param {() => T} read @returns {T} */
    run(read) {
      if (read.constructor.name === 'AsyncFunction')
        throw new GraphError('READ_CONTEXT_ASYNC', 'Read context должен быть синхронным');
      const previous = values;
      values ??= new Map();
      try {
        const result = read();
        if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
            typeof Reflect.get(result, 'then') === 'function')
          throw new GraphError('READ_CONTEXT_ASYNC', 'Read context не может возвращать Promise');
        return result;
      } finally {
        values = previous;
      }
    },
    /** @template T @param {string} key @param {() => T} read @returns {T} */
    memo(key, read) {
      if (!values) return read();
      if (!values.has(key)) values.set(key, structuredClone(read()));
      // Consumers must not mutate the discovery reused by another node.
      return /** @type {T} */ (structuredClone(values.get(key)));
    },
  };
}
