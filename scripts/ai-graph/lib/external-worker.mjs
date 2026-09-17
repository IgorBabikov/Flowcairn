#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GraphError } from './io.mjs';
import { providerUsage } from './usage.mjs';
import { externalProviderPrompt } from './codex.mjs';

const Input = z.strictObject({ version: z.literal(1), provider: z.enum(['claude', 'cursor']), executable: z.string().min(1).max(1024), versionPin: z.string().min(1).max(160), prompt: z.string().min(1).max(128 * 1024), schema: z.record(z.string(), z.json()) });
const fail = (code, message) => { throw new GraphError(code, message); };
function readInput(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('PROVIDER_INPUT_INVALID', 'Provider input недоступен.');
  return Input.parse(JSON.parse(readFileSync(file, 'utf8')));
}
function writeResult(file, value) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size !== 0) fail('PROVIDER_RESULT_UNSAFE', 'Provider result file небезопасен.');
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd);
  } finally { closeSync(fd); }
}
function parseResult(provider, stdout) {
  let envelope; try { envelope = JSON.parse(stdout); } catch { fail('PROVIDER_OUTPUT_INVALID', 'CLI не вернул JSON output.'); }
  if (envelope?.is_error === true) fail('PROVIDER_AUTH_REQUIRED', `${provider === 'claude' ? 'Claude Code' : 'Cursor'} не подтвердил доступ к AI. Войдите в CLI и повторите запуск.`);
  if (provider === 'claude' && envelope?.structured_output && typeof envelope.structured_output === 'object' && !Array.isArray(envelope.structured_output))
    return envelope.structured_output;
  const raw = envelope?.result;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2 * 1024 * 1024) fail('PROVIDER_OUTPUT_INVALID', 'Provider result отсутствует или превышает лимит.');
  let result; try { result = JSON.parse(raw); } catch { fail('PROVIDER_SCHEMA_DRIFT', `${provider} вернул неструктурированный результат.`); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('PROVIDER_SCHEMA_DRIFT', 'Provider result должен быть JSON object.');
  return result;
}
function main() {
  const [inputFile, resultFile] = process.argv.slice(2);
  if (!inputFile || !resultFile) fail('PROVIDER_ARGS', 'Provider worker arguments missing.');
  const input = readInput(inputFile), scratch = path.dirname(resultFile);
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? scratch, NO_COLOR: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const version = spawnSync(input.executable, ['--version'], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, shell: false });
  if (version.error || version.status !== 0 || `${version.stdout ?? ''}`.trim() !== input.versionPin) fail('PROVIDER_VERSION_DRIFT', 'Версия provider изменилась до запуска.');
  const schemaText = JSON.stringify(input.schema);
  if (Buffer.byteLength(schemaText) > 64 * 1024) fail('PROVIDER_SCHEMA_LIMIT', 'Схема provider превышает лимит.');
  const cursorPrompt = externalProviderPrompt('cursor', input.prompt, input.schema);
  if (Buffer.byteLength(cursorPrompt) > 192 * 1024) fail('AI_CONTEXT_LIMIT', 'Контекст Cursor превышает лимит. Сузьте approved scope.');
  const args = input.provider === 'claude'
    ? ['--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', '', '-p', '--output-format', 'json', '--json-schema', JSON.stringify(input.schema), input.prompt]
    : ['--print', '--output-format', 'json', '--sandbox', 'enabled', '--mode', 'ask', cursorPrompt];
  const run = spawnSync(input.executable, args, { cwd: scratch, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, shell: false });
  let envelope;
  try { envelope = JSON.parse(run.stdout); } catch { /* Output validation below reports the error. */ }
  const usage = providerUsage(input.provider, envelope);
  if (usage) process.stdout.write(`${JSON.stringify({ type: 'flowcairn.provider-usage', usage })}\n`);
  if (run.error && Reflect.get(run.error, 'code') === 'ETIMEDOUT') fail('PROVIDER_TIMEOUT', 'Внешний provider превысил timeout.');
  if (run.error || run.status !== 0) fail('PROVIDER_FAILED', 'Внешний provider завершился без подтвержденного результата.');
  writeResult(resultFile, parseResult(input.provider, run.stdout));
}
try { main(); } catch (error) { process.stderr.write(`${error instanceof GraphError ? error.code : 'PROVIDER_FAILED'}\n`); process.exitCode = 1; }
