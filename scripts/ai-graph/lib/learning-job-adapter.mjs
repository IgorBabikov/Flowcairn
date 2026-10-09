import { GraphError, hashObject, sha256 } from './io.mjs';
import { Hash } from './schema-primitives.mjs';
import { MAX_CONTROL_BYTES, MAX_CONTROL_INPUT_BYTES, validCommand } from './supervisor-control.mjs';
import { learningProviderToolchain, runPreparedProcess } from './runner.mjs';
import { codexModelSettings } from './codex-settings.mjs';
import {
  LEARNING_PROVIDER_LIMITS, learningProviderCapability, prepareLearningProvider, preflightLearningProvider,
  learningProviderCommand, readPreparedLearningInput, readPreparedLearningResult, parseLearningProviderOutput, disposeLearningProvider,
} from './learning-provider.mjs';

const PROVIDER_API = Object.freeze({ capability: learningProviderCapability, prepare: prepareLearningProvider,
  preflight: preflightLearningProvider, command: learningProviderCommand, readInput: readPreparedLearningInput,
  readResult: readPreparedLearningResult, parse: parseLearningProviderOutput, dispose: disposeLearningProvider });
/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };
const concreteModel = value => typeof value === 'string' && !['provider-default', 'default', 'auto'].includes(value) &&
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(value);
const sync = (value, name) => {
  if (value && typeof value.then === 'function') fail('LEARNING_CALLBACK_ASYNC', `${name} должен завершаться синхронно.`);
};
const freezeCommand = command => Object.freeze({ ...structuredClone(command), args: Object.freeze([...command.args]), env: Object.freeze({ ...command.env }) });

function boundedInput(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_CONTROL_INPUT_BYTES)
    fail('LEARNING_INPUT_LIMIT', 'Полный учебный контекст превышает 128 KiB транспортного лимита; текст не был обрезан.');
}

/** Trusted-code injection only: providerApi is never accepted from HTTP/job data.
 * Preparation handles contain prompt/command in memory; persist only their bindings. */
export function createLearningJobAdapter({ root, settings, toolchain = () => learningProviderToolchain(settings()),
  transport = runPreparedProcess, providerApi = PROVIDER_API, modelSettings = codexModelSettings }) {
  const handles = new WeakMap();
  const stateOf = handle => {
    const state = handles.get(handle);
    if (!state || state.disposed) fail('LEARNING_PREPARATION_INVALID', 'Подготовленный учебный запуск недоступен.');
    return state;
  };
  const configured = () => {
    const ai = settings();
    if (ai?.provider !== 'codex') {
      const capability = providerApi.capability({ provider: ai?.provider, cliVersion: ai?.providerVersion ?? null });
      fail(capability.code ?? 'LEARNING_PROVIDER_UNSUPPORTED', capability.reason ?? 'Учебный запуск для этого provider недоступен.');
    }
    const model = ai.modelMode === 'provider' || ai.model === 'provider-default' ? modelSettings().model : ai.model;
    if (!concreteModel(model)) fail('LEARNING_MODEL_INVALID', 'Для учебного запуска нужна конкретная настроенная модель.');
    return { provider: ai.provider, model, cliVersion: ai.providerVersion ?? null };
  };
  const beforeGo = handle => {
    const state = stateOf(handle), current = configured();
    if (current.provider !== handle.providerBinding.provider || current.model !== handle.providerBinding.model)
      fail('LEARNING_PROVIDER_DRIFT', 'Provider или модель изменились после подготовки учебного запуска.');
    const input = providerApi.readInput(state.prepared);
    boundedInput(input);
    if (input !== handle.input || sha256(input) !== handle.inputHash ||
        hashObject(providerApi.command(state.prepared)) !== state.commandHash)
      fail('LEARNING_PREPARATION_CHANGED', 'Учебная команда или вход изменились после подготовки.');
  };
  return {
    capability() {
      try { configured(); return { allowed: true, reason: null }; }
      catch (error) { return { allowed: false, reason: error instanceof GraphError ? error.message : 'Настройки учебного запуска недоступны.' }; }
    },
    async prepare(input) {
      const ai = configured();
      let prepared;
      try {
        prepared = await providerApi.prepare({ ...input, ...ai });
        boundedInput(providerApi.readInput(prepared));
        const selectedToolchain = await toolchain();
        if (!Hash.safeParse(selectedToolchain?.digest).success)
          fail('LEARNING_TOOLCHAIN_INVALID', 'Не подтверждена версия инструмента учебного запуска.');
        const receipt = await providerApi.preflight(prepared, { toolchain: selectedToolchain });
        if (receipt?.allowed !== true || prepared.capability?.allowed !== true)
          fail(receipt?.code ?? prepared.capability?.code ?? 'LEARNING_PREFLIGHT_DENIED', receipt?.reason ?? prepared.capability?.reason ?? 'Учебные ограничения не подтверждены.');
        if (!Hash.safeParse(receipt.policyHash).success)
          fail('LEARNING_PREFLIGHT_INVALID', 'Не подтверждена привязка учебных ограничений к проверенной политике.');
        const prompt = providerApi.readInput(prepared), command = providerApi.command(prepared);
        boundedInput(prompt);
        if (!validCommand(command) || Buffer.byteLength(JSON.stringify({ type: 'go', nonce: '0'.repeat(64), command, input: prompt })) + 1 > MAX_CONTROL_BYTES)
          fail('LEARNING_TRANSPORT_LIMIT', 'Учебная команда и полный контекст превышают границы транспорта.');
        if (!['inputHash', 'schemaHash', 'methodHash', 'materialHash', 'preparationHash'].every(key => Hash.safeParse(prepared[key]).success) ||
            prepared.inputHash !== sha256(prompt) || prepared.materialHash !== input.materialHash || prepared.methodHash !== input.methodHash ||
            prepared.kind !== (input.question ? 'question' : 'lesson'))
          fail('LEARNING_PREPARATION_INVALID', 'Учебный вход не совпадает с подготовленными привязками.');
        if (!Number.isSafeInteger(prepared.timeoutMs) || prepared.timeoutMs < 1 || prepared.timeoutMs > LEARNING_PROVIDER_LIMITS.timeoutMs ||
            !Number.isSafeInteger(prepared.maxOutputBytes) || prepared.maxOutputBytes < 1 || prepared.maxOutputBytes > LEARNING_PROVIDER_LIMITS.processOutputBytes)
          fail('LEARNING_TRANSPORT_LIMIT', 'Лимиты учебного запуска не подтверждены.');
        const handle = Object.freeze({ input: prompt, command: freezeCommand(command),
          providerBinding: Object.freeze({ provider: ai.provider, model: ai.model, toolchainHash: selectedToolchain.digest, preflightHash: hashObject(receipt), policyHash: receipt.policyHash }),
          inputHash: prepared.inputHash, schemaHash: prepared.schemaHash, methodHash: prepared.methodHash, materialHash: prepared.materialHash,
          preparationHash: prepared.preparationHash, kind: prepared.kind, timeoutMs: prepared.timeoutMs, maxOutputBytes: prepared.maxOutputBytes });
        handles.set(handle, { prepared, commandHash: hashObject(handle.command), disposed: false, executed: false });
        beforeGo(handle);
        return handle;
      } catch (error) {
        if (prepared) await providerApi.dispose(prepared, { stopped: true });
        throw error;
      }
    },
    beforeGo,
    async execute(handle, { onStart, beforeGo: hostBeforeGo, signal }) {
      const state = stateOf(handle);
      if (state.executed) fail('LEARNING_ATTEMPT_USED', 'Подготовленный учебный запуск уже использован.');
      if (typeof onStart !== 'function' || typeof hostBeforeGo !== 'function')
        fail('LEARNING_CALLBACK_REQUIRED', 'Для запуска нужны сохранение операции и проверка прав перед выполнением.');
      state.executed = true;
      let durableStart = false;
      return transport({ root, actionId: `learning-${handle.kind}`, command: handle.command, input: handle.input,
        timeoutMs: handle.timeoutMs, maxOutputBytes: handle.maxOutputBytes, signal,
        onStart(metadata) { sync(onStart(metadata), 'onStart'); durableStart = true; },
        beforeGo(binding) {
          if (!durableStart) fail('LEARNING_START_UNCOMMITTED', 'Учебный процесс не закреплен за операцией.');
          sync(hostBeforeGo(binding), 'beforeGo');
          beforeGo(handle);
          if (binding?.commandHash !== state.commandHash || binding?.inputHash !== handle.inputHash)
            fail('LEARNING_PREPARATION_CHANGED', 'Supervisor получил другой учебный вход или команду.');
        },
      });
    },
    parse(handle, completion, policy) {
      const state = stateOf(handle);
      if (!completion || completion.exitCode !== 0 || completion.stopped !== true || completion.uncertain !== false ||
          completion.timedOut !== false || completion.outputLimit !== false || completion.signal !== null || completion.failureReason !== null)
        fail('LEARNING_PROVIDER_INCOMPLETE', 'Не подтверждено успешное завершение учебного запуска.');
      const output = providerApi.readResult(state.prepared);
      if (!(typeof output === 'string' || Buffer.isBuffer(output)) || !Buffer.byteLength(output) || Buffer.byteLength(output) > LEARNING_PROVIDER_LIMITS.resultBytes)
        fail('LEARNING_OUTPUT_LIMIT', 'Ответ учебного запуска должен быть непустым и не больше 64 KiB.');
      return providerApi.parse(state.prepared, { output, policy, completion });
    },
    dispose(handle, { stopped } = { stopped: false }) {
      const known = handles.get(handle);
      if (known?.disposed) return;
      const state = stateOf(handle);
      if (stopped !== true) fail('LEARNING_PROCESS_UNCERTAIN', 'Очистка отложена до подтвержденной остановки процесса.');
      providerApi.dispose(state.prepared, { stopped: true });
      state.disposed = true;
    },
  };
}
