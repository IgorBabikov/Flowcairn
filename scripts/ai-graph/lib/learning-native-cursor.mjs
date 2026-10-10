import { GraphError, hashObject } from './io.mjs';

/** A candidate profile, NOT a launch capability. Ask/readBoundary restrict
 * tools, but do not prove automatic rules/hooks/MCP and account policy isolation. */
/** @param {{model?:string,reasoningEffort?:string}} [selection] */
export function cursorLearningCandidate({ model = 'provider-default', reasoningEffort } = {}) {
  if (model !== 'provider-default' && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(model)))
    throw new GraphError('LEARNING_MODEL_INVALID', 'Некорректная модель Cursor.');
  if (reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort))
    throw new GraphError('LEARNING_REASONING_INVALID', 'Непроверенное усиление Cursor.');
  if (model === 'provider-default' && reasoningEffort !== undefined)
    throw new GraphError('LEARNING_REASONING_INVALID', 'Нельзя применить override к неизвестной модели Cursor.');
  const config = { version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'] },
    approvalMode: 'allowlist', sandbox: { mode: 'enabled', networkAccess: 'user_config_only', readBoundary: 'workspace' } };
  return Object.freeze({ provider: 'cursor', allowed: false, evidence: 'candidate-only', code: 'LEARNING_CURSOR_BOUNDARY_UNVERIFIED',
    reason: 'CLI не подтверждает отключение автоматических rules/hooks/MCP до передачи материала; безопасный учебный запуск пока недоступен.',
    modelIntent: model, proposedArgs: Object.freeze(['--print', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled',
      ...(model === 'provider-default' ? [] : ['--model', `${model}${reasoningEffort === undefined ? '' : `[effort=${reasoningEffort}]`}`])]),
    config, profileHash: hashObject(config), unresolved: Object.freeze(['effective-config', 'auto-rules', 'hooks-before-prompt', 'managed-mcp', 'auth-config-preservation']) });
}

/** Recorded-format parser fixture shared with the eventual adapter. It does
 * not authorize Cursor or upgrade a successful status command into auth. */
export function cursorLearningAuthentication(status) { return status?.isAuthenticated === true; }
export function parseCursorLearningResult(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new GraphError('LEARNING_OUTPUT_LIMIT', 'Вывод Cursor превышает лимит.');
  let envelope, output;
  try { envelope = JSON.parse(text); } catch { throw new GraphError('LEARNING_OUTPUT_INVALID', 'Cursor не вернул JSON.'); }
  if (envelope?.type !== 'result' || envelope.subtype !== 'success' || envelope.is_error !== false || typeof envelope.result !== 'string')
    throw new GraphError('LEARNING_PROVIDER_INCOMPLETE', 'Cursor не подтвердил успешный учебный ответ.');
  if (Buffer.byteLength(envelope.result) > 64 * 1024) throw new GraphError('LEARNING_OUTPUT_LIMIT', 'Ответ Cursor превышает 64 KiB.');
  try { output = JSON.parse(envelope.result); } catch { throw new GraphError('LEARNING_OUTPUT_INVALID', 'Ответ Cursor не соответствует JSON формату.'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new GraphError('LEARNING_OUTPUT_INVALID', 'Ответ Cursor должен быть объектом.');
  return output;
}
