import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { GraphError } from './lib/io.mjs';
import { safeReason } from './lib/failure-reason.mjs';

test('safeReason reports structural output errors without rejected values', () => {
  const result = z.object({ edits: z.array(z.object({ path: z.string() })) })
    .safeParse({ edits: [{ path: 42, secret: 'private-content' }] });
  assert.equal(result.success, false);
  const reason = safeReason(result.error);
  assert.match(reason, /^AI_RESULT_SCHEMA: edits\.0\.path:invalid_type/);
  assert.doesNotMatch(reason, /private-content|42/);
});

test('safeReason preserves trusted errors and classifies unexpected failures', () => {
  assert.equal(safeReason(new GraphError('SCOPE_DENIED', 'Путь недоступен')), 'SCOPE_DENIED: Путь недоступен');
  assert.match(safeReason(new TypeError('private-content')), /^INTERNAL_ERROR_TYPE/);
  assert.doesNotMatch(safeReason(new TypeError('private-content')), /private-content/);
});
