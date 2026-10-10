import { spawn } from 'node:child_process';
import { GraphError } from './io.mjs';
import { validateClaudeConfiguration } from './learning-native-claude-policy.mjs';

export const CLAUDE_LEARNING_FLAGS = Object.freeze(['--safe-mode', '--tools', '', '--strict-mcp-config', '--disallowedTools', 'mcp__*',
  '--disable-slash-commands', '--no-session-persistence', '--permission-mode', 'dontAsk', '--no-chrome',
  '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--system-prompt', 'Explain only the saved material supplied in the user message. Return the requested JSON object.']);

export function claudeLearningArgs({ model, reasoningEffort }) {
  if (model !== 'provider-default' && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/[\]-]{0,159}$/.test(model)))
    throw new GraphError('LEARNING_MODEL_INVALID', 'Нужна настроенная модель или явный provider-default.');
  if (reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort))
    throw new GraphError('LEARNING_REASONING_INVALID', 'Claude CLI не поддерживает выбранное усиление.');
  return [...CLAUDE_LEARNING_FLAGS, ...(model === 'provider-default' ? [] : ['--model', model]),
    ...(reasoningEffort === undefined ? [] : ['--effort', reasoningEffort])];
}

export function parseClaudeLearningResult(message) {
  if (message?.type !== 'result' || message.subtype !== 'success' || message.is_error !== false)
    throw new GraphError('LEARNING_PROVIDER_INCOMPLETE', 'Claude не подтвердил успешный учебный результат.');
  let output = message.structured_output;
  if (output === undefined) {
    try { output = JSON.parse(message.result); }
    catch { throw new GraphError('LEARNING_OUTPUT_INVALID', 'Claude не вернул JSON object.'); }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new GraphError('LEARNING_OUTPUT_INVALID', 'Claude не вернул JSON object.');
  const bytes = Buffer.from(JSON.stringify(output));
  if (bytes.length > 64 * 1024) throw new GraphError('LEARNING_OUTPUT_LIMIT', 'Ответ превышает 64 KiB.');
  return bytes;
}

/** Exactly one process: initialize -> settings -> MCP -> validate -> optional
 * single user message. Preflight omits input, so cannot request inference.
 * Callers never receive raw account, settings values or diagnostics. */
export function runClaudeLearningProtocol({ command, selection, input = undefined, schema = undefined,
  expectedConfigurationHash = undefined, beforeInput = () => {}, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    let buffer = '', bytes = 0, error, initialization, settings, facts, result, phase = 'init', sentInput = false;
    const fail = (code, message) => { error ??= new GraphError(code, message); child.stdin.end(); child.kill('SIGTERM'); };
    const deadline = setTimeout(() => fail('LEARNING_PROVIDER_TIMEOUT', 'Учебный CLI превысил время ожидания.'), timeoutMs);
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 2000);
    const send = message => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`); };
    const control = subtype => send({ type: 'control_request', request_id: subtype, request: { subtype,
      ...(subtype === 'initialize' && schema ? { jsonSchema: schema } : {}) } });
    child.stdin.on('error', () => fail('LEARNING_CLAUDE_PROTOCOL_INVALID', 'Учебный канал закрыт.'));
    child.on('error', () => fail('LEARNING_CLAUDE_UNAVAILABLE', 'Учебный CLI не запущен.'));
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail('LEARNING_OUTPUT_LIMIT', 'Диагностика CLI превысила лимит.'); });
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) { fail('LEARNING_OUTPUT_LIMIT', 'Вывод CLI превысил лимит.'); return; }
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n') && !error) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'control_request') throw new GraphError('LEARNING_CLAUDE_CONTROLS_UNVERIFIED', 'CLI запросил инструмент или действие.');
          if (message.type === 'control_response') {
            const response = message.response;
            if (response?.subtype !== 'success') throw new GraphError('LEARNING_CLAUDE_PROTOCOL_INVALID', 'CLI отклонил проверку настроек.');
            if (phase === 'init' && response.request_id === 'initialize') {
              initialization = response.response; phase = 'settings'; control('get_settings');
            } else if (phase === 'settings' && response.request_id === 'get_settings') {
              settings = response.response; phase = 'mcp'; control('mcp_status');
            } else if (phase === 'mcp' && response.request_id === 'mcp_status') {
              facts = validateClaudeConfiguration({ settings, initialization, mcp: response.response }, selection);
              if (expectedConfigurationHash && facts.configurationHash !== expectedConfigurationHash)
                throw new GraphError('LEARNING_PROVIDER_DRIFT', 'Effective настройки изменились после preflight.');
              phase = 'result';
              if (input === undefined) child.stdin.end();
              else {
                if (typeof input !== 'string' || !input.length || Buffer.byteLength(input) > 128 * 1024)
                  throw new GraphError('LEARNING_INPUT_LIMIT', 'Учебный вход превышает транспортный лимит.');
                beforeInput(); sentInput = true;
                send({ type: 'user', message: { role: 'user', content: input }, parent_tool_use_id: null, session_id: '' });
              }
            } else throw new GraphError('LEARNING_CLAUDE_PROTOCOL_INVALID', 'Повторный или неожиданный ответ preflight.');
          } else if (message.type === 'result') {
            if (!sentInput || result) throw new GraphError('LEARNING_CLAUDE_PROTOCOL_INVALID', 'Незапрошенный или повторный результат.');
            result = parseClaudeLearningResult(message); child.stdin.end();
          } else if (message.type === 'assistant') {
            if (!sentInput || message.message?.content?.some(part => part.type === 'tool_use' && part.name !== 'StructuredOutput'))
              throw new GraphError('LEARNING_CLAUDE_CONTROLS_UNVERIFIED', 'CLI использовал непредусмотренный инструмент.');
          } else if (message.type === 'system') {
            if (!sentInput || !['init', 'status'].includes(message.subtype))
              throw new GraphError('LEARNING_CLAUDE_CONTROLS_UNVERIFIED', 'CLI запустил непредусмотренную автоматизацию.');
            if (message.subtype === 'init' && (!Array.isArray(message.tools) || message.tools.some(name => name !== 'StructuredOutput')
              || !Array.isArray(message.mcp_servers) || message.mcp_servers.length))
              throw new GraphError('LEARNING_CLAUDE_CONTROLS_UNVERIFIED', 'CLI объявил посторонние инструменты.');
          } else if (message.type !== 'stream_event') throw new GraphError('LEARNING_CLAUDE_PROTOCOL_INVALID', 'Неизвестное событие CLI.');
        } catch (cause) { fail(cause instanceof GraphError ? cause.code : 'LEARNING_CLAUDE_PROTOCOL_INVALID', 'Учебный протокол не прошел проверку.'); }
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline); clearTimeout(kill);
      if (error) reject(error);
      else if (code !== 0 || signal || buffer.trim() || !facts || input !== undefined && !result)
        reject(new GraphError('LEARNING_PROVIDER_INCOMPLETE', 'CLI не подтвердил полное завершение.'));
      else resolve({ facts, output: result ?? null });
    });
    control('initialize');
  });
}
