const counter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (values) => values.every((value) => value !== null) ? counter(values.reduce((total, value) => total + value, 0)) : null;
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd'];

function normalized(values) {
  const result = { source: 'provider', ...Object.fromEntries(fields.map((field) => [field,
    field === 'costUsd' ? money(values[field]) : counter(values[field])])) };
  return fields.some((field) => result[field] !== null) ? result : null;
}

/** Allowlisted numeric metadata only; content, IDs, models and raw provider output never leave here. */
export function providerUsage(provider, envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const usage = envelope.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage))
    return provider === 'claude' ? normalized({ costUsd: envelope.total_cost_usd }) : null;
  if (provider === 'codex') {
    const inputTokens = counter(usage.input_tokens), outputTokens = counter(usage.output_tokens);
    return normalized({ inputTokens, cachedInputTokens: usage.cached_input_tokens, outputTokens,
      totalTokens: sum([inputTokens, outputTokens]) });
  }
  if (provider === 'claude') {
    // Claude reports fresh, cache-write and cache-read inputs as disjoint counts.
    // A missing component remains unknown; it must not silently become zero.
    const inputTokens = sum([counter(usage.input_tokens), counter(usage.cache_creation_input_tokens), counter(usage.cache_read_input_tokens)]);
    const outputTokens = counter(usage.output_tokens);
    return normalized({ inputTokens, cachedInputTokens: usage.cache_read_input_tokens, outputTokens,
      totalTokens: sum([inputTokens, outputTokens]), costUsd: envelope.total_cost_usd });
  }
  return null;
}

function eventUsage(event) {
  if (event?.type === 'turn.completed') return providerUsage('codex', event);
  if (event?.type === 'flowcairn.provider-usage' && event.usage?.source === 'provider') return normalized(event.usage);
  return null;
}

/** Bounded streaming parser ignores model/tool messages, including JSON embedded in their text. */
export function createUsageCollector() {
  let buffer = Buffer.alloc(0), dropping = false, aggregate = null;
  const consume = (line) => {
    let event;
    try { event = JSON.parse(line.toString('utf8')); } catch { return; }
    const usage = eventUsage(event);
    if (!usage) return;
    aggregate = aggregate ? { source: 'provider', ...Object.fromEntries(fields.map((field) => [field,
      aggregate[field] === null || usage[field] === null ? null : field === 'costUsd'
        ? money(aggregate[field] + usage[field]) : counter(aggregate[field] + usage[field])])) } : usage;
  };
  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 10) continue;
        if (!dropping && buffer.length + index - start <= 64 * 1024)
          consume(Buffer.concat([buffer, data.subarray(start, index)]));
        buffer = Buffer.alloc(0); dropping = false; start = index + 1;
      }
      if (!dropping && buffer.length + data.length - start <= 64 * 1024)
        buffer = Buffer.concat([buffer, data.subarray(start)]);
      else { buffer = Buffer.alloc(0); dropping = true; }
    },
    finish() {
      if (!dropping && buffer.length) consume(buffer);
      buffer = Buffer.alloc(0); dropping = false;
      return aggregate ? normalized(aggregate) : null;
    },
  };
}
