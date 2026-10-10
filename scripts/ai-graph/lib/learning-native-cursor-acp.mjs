import { spawn } from 'node:child_process';
import { GraphError, hashObject } from './io.mjs';

export const CURSOR_LEARNING_ACP_INITIALIZE = Object.freeze({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'flowcairn-learning-preflight', version: '1.0.0' },
} });

export function cursorAcpLearningMetadata(message) {
  const result = message?.result;
  if (message?.jsonrpc !== '2.0' || message.id !== 1 || message.error || result?.protocolVersion !== 1
    || !result.agentCapabilities || !Array.isArray(result.authMethods) || !result.authMethods.some(method => method.id === 'cursor_login'))
    throw new GraphError('LEARNING_CURSOR_ACP_UNVERIFIED', 'CLI не подтвердил поддерживаемый ACP handshake.');
  const capabilities = result.agentCapabilities;
  return Object.freeze({ allowed: false, provider: 'cursor', transport: 'acp-v1', code: 'LEARNING_CURSOR_BOUNDARY_UNVERIFIED',
    reason: 'ACP работает, но не подтверждает отключение собственного runtime, rules/hooks/MCP до передачи материала.',
    noInference: true, authentication: 'not-requested', capabilityHash: hashObject(capabilities),
    capabilities: { loadSession: capabilities.loadSession === true, httpMcp: capabilities.mcpCapabilities?.http === true,
      sseMcp: capabilities.mcpCapabilities?.sse === true, embeddedContext: capabilities.promptCapabilities?.embeddedContext === true } });
}

/** Trusted caller diagnostic only. Sends initialize, never authenticate,
 * session/new or session/prompt, and rejects every unsolicited request. */
export function inspectCursorLearningAcp(command, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); let buffer = '', bytes = 0, metadata, error;
    const stop = () => { child.stdin.end(); child.kill('SIGTERM'); };
    const refuse = () => { error = new GraphError('LEARNING_CURSOR_ACP_UNVERIFIED', 'Нативный ACP preflight не завершился безопасно.'); stop(); };
    const deadline = setTimeout(refuse, timeoutMs), kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 2000);
    child.on('error', refuse); child.stdin.on('error', refuse);
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) refuse(); });
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk); if (bytes > 256 * 1024) { refuse(); return; } buffer += chunk;
      while (buffer.includes('\n') && !error) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (metadata) { refuse(); return; }
        try { metadata = cursorAcpLearningMetadata(JSON.parse(line)); stop(); } catch { refuse(); }
      }
    });
    child.on('close', () => {
      clearTimeout(deadline); clearTimeout(kill);
      if (error || !metadata || buffer.trim()) reject(error ?? new GraphError('LEARNING_CURSOR_ACP_UNVERIFIED', 'ACP handshake отсутствует.'));
      else resolve(metadata);
    });
    child.stdin.write(`${JSON.stringify(CURSOR_LEARNING_ACP_INITIALIZE)}\n`);
  });
}
