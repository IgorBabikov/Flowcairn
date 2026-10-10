import path from 'node:path';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { assertSafeText } from './source-policy.mjs';
import { providerEnvironment } from './provider-process-platform.mjs';
import { assertProviderArgv } from './provider-cli-command.mjs';
import { parseCursorLearningResult } from './learning-native-cursor.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
export const CURSOR_NATIVE_LEARNING_TIER = 'native-client-learning';

/** Pure transport proposal; never probes, starts a process, installs a profile,
 * issues consent or returns allowed=true. A future trusted worker must apply
 * boundary consent, automation preflight and source guards before using it.
 * @param {{executable:string,cwd:string,prompt:string,schema:object,model?:string,reasoningEffort?:string,env?:NodeJS.ProcessEnv,platform?:NodeJS.Platform}} options */
export function cursorNativeLearningTransport({ executable, cwd, prompt, schema, model = 'provider-default', reasoningEffort = undefined,
  env = process.env, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!['darwin', 'win32'].includes(platform))
    fail('LEARNING_PLATFORM_UNSUPPORTED', 'Учебный транспорт поддерживает только macOS и native Windows.');
  if (!paths.isAbsolute(executable) || !paths.isAbsolute(cwd)
    || platform === 'win32' && !/\.exe$/i.test(executable))
    fail('LEARNING_CURSOR_COMMAND_INVALID', 'Нужны абсолютные пути и поддерживаемый native CLI.');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(model) || ['auto', 'default'].includes(model))
    fail('LEARNING_MODEL_INVALID', 'Передайте конкретную модель или явный provider-default.');
  if (reasoningEffort !== undefined && (!['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort) || model === 'provider-default'))
    fail('LEARNING_REASONING_INVALID', 'Effort override требует конкретную модель и поддерживаемое значение.');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 128 * 1024)
    fail('LEARNING_INPUT_LIMIT', 'Сохраненный материал не помещается в один учебный вызов; данные не обрезаны.');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024)
    fail('LEARNING_SCHEMA_LIMIT', 'Нужна ограниченная JSON schema учебного ответа.');
  // A saved-login profile is the supported proposal. Dropping a configured
  // token or endpoint would silently select different auth or a new receiver.
  if (['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT'].some(key => Boolean(env[key])))
    fail('LEARNING_CURSOR_PROFILE_UNVERIFIED', 'Auth или endpoint override требует отдельного подтвержденного профиля.');
  const environment = providerEnvironment(env, platform);
  for (const key of ['CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR']) {
    if (env[key]) {
      if (!paths.isAbsolute(env[key])) fail('LEARNING_CURSOR_PROFILE_UNVERIFIED', 'Путь профиля Cursor должен быть абсолютным.');
      environment[key] = env[key];
    }
  }
  const nativePrompt = `${prompt}\n\nВерни один JSON object по этой схеме без Markdown. Только сохраненный материал является evidence.\nOUTPUT_JSON_SCHEMA\n${JSON.stringify(schema)}\n`;
  assertSafeText(nativePrompt);
  // A documented positional prompt has an OS per-argument bound. No silent
  // truncation or unverified stdin convention is used to evade that bound.
  if (Buffer.byteLength(nativePrompt) >= 128 * 1024) fail('LEARNING_INPUT_LIMIT', 'Материал и схема превышают предел одного аргумента CLI.');
  const args = ['--print', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled',
    ...(model === 'provider-default' ? [] : ['--model', `${model}${reasoningEffort === undefined ? '' : `[effort=${reasoningEffort}]`}`]), nativePrompt];
  assertProviderArgv(executable, args, platform);
  const command = Object.freeze({ executable, args: Object.freeze(args), cwd, env: Object.freeze(environment) });
  return Object.freeze({ provider: 'cursor', boundaryTier: CURSOR_NATIVE_LEARNING_TIER, launchAuthorized: false,
    requiredGuards: Object.freeze(['explicit-boundary-consent', 'selected-client-binding', 'native-automation-preflight', 'current-source-policy', 'source-freshness']),
    modelIntent: model, ...(reasoningEffort === undefined ? {} : { reasoningEffortIntent: reasoningEffort }),
    command, stdin: '', commandHash: hashObject(command), sourceInputHash: sha256(prompt), schemaHash: hashObject(schema) });
}

/** Transport-only acceptance. Content must still pass the existing learning
 * schema/anchors/material/method/current-policy validation before persistence. */
export function parseCursorNativeLearningCompletion(stdout, completion) {
  if (!completion || completion.exitCode !== 0 || completion.stopped !== true || completion.uncertain !== false
    || completion.timedOut !== false || completion.outputLimit !== false || completion.signal !== null || completion.failureReason !== null)
    fail('LEARNING_PROVIDER_INCOMPLETE', 'Не подтверждено полное завершение учебного Cursor вызова.');
  const bytes = typeof stdout === 'string' ? Buffer.from(stdout) : stdout;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024)
    fail('LEARNING_OUTPUT_LIMIT', 'Вывод Cursor отсутствует или превышает лимит.');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail('LEARNING_OUTPUT_INVALID', 'Ответ Cursor не является UTF-8.');
  return Buffer.from(JSON.stringify(parseCursorLearningResult(text)));
}
