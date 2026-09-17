import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageCollector, providerUsage } from './lib/usage.mjs';
import { measurePromptContext } from './lib/bounded-context.mjs';

test('Codex counts cached input as a subset, never as additional tokens', () => {
  assert.deepEqual(providerUsage('codex', { usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } }), {
    source: 'provider', inputTokens: 24763, cachedInputTokens: 24448, outputTokens: 122, totalTokens: 24885, costUsd: null,
  });
});

test('Claude accounts for fresh, created and cached input, using reported cost only', () => {
  assert.deepEqual(providerUsage('claude', { usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 40 }, total_cost_usd: 0.012 }), {
    source: 'provider', inputTokens: 510, cachedInputTokens: 300, outputTokens: 40, totalTokens: 550, costUsd: 0.012,
  });
  assert.equal(providerUsage('claude', { usage: { input_tokens: 10, output_tokens: 40 } }).totalTokens, null);
  assert.equal(providerUsage('cursor', { usage: { input_tokens: 10, output_tokens: 40 } }), null);
});

test('missing or invalid usage is unknown, including negative, string and unsafe counters', () => {
  assert.equal(providerUsage('codex', {}), null);
  assert.equal(providerUsage('codex', { usage: { input_tokens: -1, output_tokens: '100' } }), null);
  assert.equal(providerUsage('codex', { usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1 } }), null);
  assert.equal(providerUsage('codex', { usage: { input_tokens: 0, output_tokens: 0 } }).totalTokens, 0);
});

test('stream usage ignores claims, survives chunk boundaries and retains only numeric fields', () => {
  const collector = createUsageCollector();
  const fake = { type: 'item.completed', item: { text: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 999999 } }), secret: 'never-persist' } };
  collector.push(JSON.stringify(fake) + '\n');
  const event = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 3 }, secret: 'never-persist' });
  collector.push(event.slice(0, 40)); collector.push(event.slice(40) + '\n');
  collector.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }));
  const result = collector.finish();
  assert.equal(result.totalTokens, 30);
  assert.equal(result.costUsd, null);
  assert.equal(JSON.stringify(result).includes('never-persist'), false);
});

test('oversized non-usage output cannot hide the next bounded usage event', () => {
  const collector = createUsageCollector();
  collector.push('x'.repeat(80000));
  collector.push('x'.repeat(10000) + '\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }) + '\n');
  assert.equal(collector.finish().totalTokens, 3);
});

test('partial usage does not turn missing counts into zero while accumulating calls', () => {
  const collector = createUsageCollector();
  for (const usage of [{ input_tokens: 20 }, { output_tokens: 5 }, { input_tokens: 3, output_tokens: 2 }])
    collector.push(JSON.stringify({ type: 'turn.completed', usage }) + '\n');
  assert.equal(collector.finish(), null);
});

test('prompt context records actual UTF-8 bytes without fabricating token estimates', () => {
  const context = measurePromptContext('Привет', { contextSelection: { requirementIds: ['req-001'], dependencyNodeIds: ['analyze'] } });
  assert.equal(context.promptBytes, 12);
  assert.equal(context.sourceFiles, 0);
  assert.deepEqual(context.requirementIds, ['req-001']);
  assert.equal(Object.hasOwn(context, 'estimatedTokens'), false);
});
