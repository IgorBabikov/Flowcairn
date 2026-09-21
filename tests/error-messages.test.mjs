import test from 'node:test';
import assert from 'node:assert/strict';
import { explainError, GraphError } from '../scripts/ai-graph/lib/io.mjs';

test('integration conflict explains location and safe next step', () => {
  const result = explainError(new GraphError('INTEGRATION_CONFLICT', 'internal conflict'));
  assert.match(result.message, /правила проекта/);
  assert.equal(result.where, 'AGENTS.md или AGENTS.override.md');
  assert.match(result.action, /Не удаляйте весь файл/);
  assert.equal(result.technical, 'internal conflict');
});

test('unknown errors preserve their original human message', () => {
  assert.deepEqual(explainError(new GraphError('SOMETHING_NEW', 'Понятная причина')), { message: 'Понятная причина' });
});
