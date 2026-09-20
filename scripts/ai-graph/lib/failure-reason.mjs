import { GraphError } from './io.mjs';
import { sanitizeText } from './service-adapters.mjs';

const issueLocation = (issue) =>
  Array.isArray(issue?.path) && issue.path.length
    ? issue.path.filter((part) => typeof part === 'string' || Number.isInteger(part)).join('.')
    : 'result';

// Report schema paths and internal failure kinds, never rejected model values.
export function safeReason(error) {
  if (error instanceof GraphError) return `${error.code}: ${sanitizeText(error.message)}`;
  if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
    const issues = error.issues.slice(0, 5).map((issue) =>
      `${issueLocation(issue)}:${typeof issue.code === 'string' ? issue.code : 'invalid'}`,
    );
    return `AI_RESULT_SCHEMA: ${issues.join(', ') || 'result:invalid'}`;
  }
  const kind = error instanceof TypeError ? 'TYPE' : error instanceof SyntaxError ? 'SYNTAX' : 'UNKNOWN';
  const frame = String(error?.stack ?? '').split('\n').find((line) => line.includes('/scripts/ai-graph/lib/'));
  const location = frame?.match(/\/([a-z0-9-]+\.mjs):(\d+):\d+\)?\s*$/);
  return `INTERNAL_ERROR_${kind}${location ? ` (${location[1]}:${location[2]})` : ''}: операция не завершена; требуется проверка результата`;
}
