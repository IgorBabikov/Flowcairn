import { closeSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lstatHostSync as lstatSync, fstatHostSync as fstatSync, crossStatIdentity, isPrivateMode, noFollowReadFlags } from './host-filesystem.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { buildLearningPrompt, validateLearningOutput, LEARNING_PROMPT_LIMITS } from './learning-prompt.mjs';
import { preflightCodexLearning, codexLearningCommand } from './learning-runner.mjs';

/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };
const preparations = new WeakMap();
const inode = (stat) => `${stat.dev}:${stat.ino}`;
export const LEARNING_PROVIDER_LIMITS = Object.freeze({ timeoutMs: 120_000, processOutputBytes: 2 * 1024 * 1024,
  resultBytes: LEARNING_PROMPT_LIMITS.outputBytes });

/** Cheap status before explicit preflight. No probe, inference or config read. */
export function learningProviderCapability({ provider, cliVersion = null }) {
  if (provider === 'codex') return Object.freeze({ allowed: false, provider, cliVersion,
    code: 'LEARNING_CODEX_PREFLIGHT_REQUIRED',
    reason: 'Перед учебным вызовом нужен preflight версии CLI, managed требований и effective ограничений.' });
  if (provider === 'claude') return Object.freeze({ allowed: false, provider, cliVersion,
    code: 'LEARNING_CLAUDE_BOUNDARY_UNVERIFIED',
    reason: 'Tools-disabled bare mode требует отдельной проверки политики и auth: он не использует subscription/OAuth-вход. Автоматическая смена способа доступа запрещена.' });
  if (provider === 'cursor') return Object.freeze({ allowed: false, provider, cliVersion,
    code: 'LEARNING_CURSOR_BOUNDARY_UNVERIFIED',
    reason: 'Для этого CLI не подтвержден режим без инструментов и постороннего контекста. Режим ask сам по себе не ограничивает чтение только материалом.' });
  return Object.freeze({ allowed: false, provider, cliVersion, code: 'LEARNING_PROVIDER_UNSUPPORTED', reason: 'Учебный adapter для выбранного provider не реализован.' });
}

function privateFile(file, bytes) {
  const handle = openSync(file, 'wx', 0o600);
  try { writeFileSync(handle, bytes); } finally { closeSync(handle); }
}

function stateOf(prepared) {
  const state = preparations.get(prepared);
  if (!state || state.disposed) fail('LEARNING_PREPARATION_INVALID', 'Подготовленный учебный вызов недоступен.');
  const stat = lstatSync(state.scratch, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isPrivateMode(stat) || inode(stat) !== state.identity
    || realpathSync(state.scratch) !== state.scratch) fail('LEARNING_SCRATCH_CHANGED', 'Временный каталог учебного вызова изменился.');
  return state;
}

function safeScratchRead(state, name, maxBytes) {
  const file = path.join(state.scratch, name), before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !isPrivateMode(before) || before.size > BigInt(maxBytes))
    fail('LEARNING_SCRATCH_CHANGED', 'Файл учебного вызова недоступен или превышает лимит.');
  const handle = openSync(file, noFollowReadFlags());
  try {
    if (crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(before))
      fail('LEARNING_SCRATCH_CHANGED', 'Файл учебного вызова заменен.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0, read;
    while (count < buffer.length && (read = readSync(handle, buffer, count, buffer.length - count, null)) > 0) count += read;
    const bytes = buffer.subarray(0, count);
    if (bytes.length > maxBytes || bytes.length !== Number(before.size)
      || crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(before)
      || crossStatIdentity(lstatSync(file, { bigint: true })) !== crossStatIdentity(before))
      fail('LEARNING_SCRATCH_CHANGED', 'Файл учебного вызова изменился во время чтения.');
    return bytes;
  } finally { closeSync(handle); }
}

/** Prepare only host-verified saved data in a new private scratch. The returned
 * capability must be checked before a supervisor is allowed to start. Codex
 * becomes ready only after explicit preflight; other providers remain denied.
 * This is preparation and validation infrastructure, not a sandbox or scheduler.
 * @param {import('./learning-prompt.mjs').LearningInput & {provider: string, model: string, cliVersion?: string}} options
 */
export function prepareLearningProvider(options) {
  if (typeof options.model !== 'string' || options.model === 'provider-default' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(options.model))
    fail('LEARNING_MODEL_INVALID', 'Передайте конкретную настроенную модель; provider-default сначала разрешает host.');
  const capability = learningProviderCapability(options);
  if (capability.code === 'LEARNING_PROVIDER_UNSUPPORTED') fail(capability.code, capability.reason);
  const input = { store: options.store, binding: structuredClone(options.binding), materialHash: options.materialHash,
    methodHash: options.methodHash, policy: structuredClone(options.policy ?? {}), ...(options.question ? { question: structuredClone(options.question) } : {}) };
  const prompt = buildLearningPrompt(input);
  const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'flowcairn-learning-'));
  try {
    // mkdtemp creates a private directory; verify its actual host permissions.
    const stat = lstatSync(scratch, { bigint: true });
    if (!isPrivateMode(stat)) fail('LEARNING_SCRATCH_UNSAFE', 'Временный каталог должен быть закрытым.');
    privateFile(path.join(scratch, 'input.txt'), prompt.prompt);
    privateFile(path.join(scratch, 'schema.json'), JSON.stringify(prompt.schema));
    privateFile(path.join(scratch, 'result.json'), '');
    const prepared = Object.freeze({ provider: options.provider, model: options.model,
      get capability() { return preparations.get(this)?.codexReceipt ?? capability; },
      get command() { return preparations.get(this)?.codexReceipt ? learningProviderCommand(this) : null; },
      scratch, schemaFile: path.join(scratch, 'schema.json'), resultFile: path.join(scratch, 'result.json'),
      inputHash: prompt.inputHash, schemaHash: prompt.schemaHash, kind: prompt.kind,
      materialHash: prompt.materialHash, methodHash: prompt.methodHash,
      timeoutMs: LEARNING_PROVIDER_LIMITS.timeoutMs, maxOutputBytes: LEARNING_PROVIDER_LIMITS.processOutputBytes,
      maxResultBytes: LEARNING_PROVIDER_LIMITS.resultBytes,
      preparationHash: hashObject({ provider: options.provider, cliVersion: options.cliVersion ?? null, model: options.model, kind: prompt.kind,
        inputHash: prompt.inputHash, schemaHash: prompt.schemaHash, materialHash: prompt.materialHash, methodHash: prompt.methodHash }) });
    preparations.set(prepared, { scratch, identity: inode(stat), input, inputHash: prompt.inputHash,
      schemaHash: sha256(JSON.stringify(prompt.schema)), disposed: false });
    return prepared;
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
}

/** Runtime must call before dispatch. Never route denial to implementation AI. */
export function learningProviderCommand(prepared) {
  const state = stateOf(prepared);
  if (!state.codexReceipt) fail(prepared.capability.code, prepared.capability.reason);
  readPreparedLearningInput(prepared);
  return codexLearningCommand({ receipt: state.codexReceipt, scratch: prepared.scratch, schemaFile: prepared.schemaFile, resultFile: prepared.resultFile, model: prepared.model });
}

/** Read-only, no-inference preflight after an explicit generation action.
 * @param {object} prepared
 * @param {{toolchain: import('./learning-runner.mjs').LearningToolchain}} options */
export async function preflightLearningProvider(prepared, { toolchain }) {
  const state = stateOf(prepared);
  if (prepared.provider !== 'codex') fail(prepared.capability.code, prepared.capability.reason);
  readPreparedLearningInput(prepared);
  const receipt = await preflightCodexLearning({ toolchain, scratch: prepared.scratch });
  stateOf(prepared);
  state.codexReceipt = receipt;
  return receipt;
}

/** Read only the fixed result file produced by the trusted CLI, never live paths. */
export function readPreparedLearningResult(prepared) {
  return safeScratchRead(stateOf(prepared), 'result.json', LEARNING_PROMPT_LIMITS.outputBytes);
}

/** Input may be inspected locally without starting a provider or copying auth. */
export function readPreparedLearningInput(prepared) {
  const state = stateOf(prepared), bytes = safeScratchRead(state, 'input.txt', LEARNING_PROMPT_LIMITS.promptBytes);
  if (sha256(bytes) !== state.inputHash || sha256(safeScratchRead(state, 'schema.json', LEARNING_PROMPT_LIMITS.schemaBytes)) !== state.schemaHash)
    fail('LEARNING_PREPARATION_CHANGED', 'Учебный вход или схема изменились после подготовки.');
  return bytes.toString('utf8');
}

/** Validate bounded provider content supplied by an existing supervisor/parser.
 * This does not authorize a call or persist output. Current policy is mandatory.
 * @param {object} prepared
 * @param {{output: string|Buffer, policy: import('./learning-sources.mjs').SourcePolicy,
 * completion: {exitCode: number|null, stopped: boolean, uncertain: boolean, timedOut: boolean, outputLimit: boolean,
 * signal: string|null, failureReason: string|null}}} result
 */
export function parseLearningProviderOutput(prepared, { output, policy, completion }) {
  const state = stateOf(prepared);
  if (!policy || !completion || completion.exitCode !== 0 || completion.stopped !== true || completion.uncertain !== false
    || completion.timedOut !== false || completion.outputLimit !== false || completion.signal !== null || completion.failureReason !== null)
    fail('LEARNING_PROVIDER_INCOMPLETE', 'Не подтверждено успешное завершение учебного вызова.');
  readPreparedLearningInput(prepared);
  return validateLearningOutput({ ...state.input, policy, output });
}

/** No cleanup while process ownership/termination is uncertain. Never accepts
 * caller-selected paths; a replaced scratch/unknown entry is retained for review. */
export function disposeLearningProvider(prepared, { stopped } = { stopped: false }) {
  const known = preparations.get(prepared);
  if (known?.disposed) return;
  const state = stateOf(prepared);
  if (stopped !== true) fail('LEARNING_PROCESS_UNCERTAIN', 'Очистка отложена до подтвержденной остановки процесса.');
  const names = readdirSync(state.scratch);
  for (const name of names) {
    if (!['input.txt', 'schema.json', 'result.json'].includes(name)) fail('LEARNING_SCRATCH_CHANGED', 'Во временном каталоге появился неизвестный объект.');
    const stat = lstatSync(path.join(state.scratch, name), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !isPrivateMode(stat))
      fail('LEARNING_SCRATCH_CHANGED', 'Очистка не может затронуть подмененный объект.');
  }
  stateOf(prepared);
  rmSync(state.scratch, { recursive: true }); state.disposed = true;
}
