import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { GraphError, hashObject } from './io.mjs';
import { CheckProfileSchema, PlanChecksSchema } from './check-schemas.mjs';
import { hasSecretContent, isSensitivePath } from './source-policy.mjs';
import { checkFileIdentity, checkInputManifest, containedCheckPath, resolveCheckExecutable } from './check-toolchain.mjs';
export { CheckProfileSchema, RegisteredCheckSchema, BoundCheckSchema } from './check-schemas.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const inside = (a, b) => a === b || a.startsWith(`${b}/`);
export const isGenericProfile = (profile) => profile?.version === 2;
export const MISSING_CHECK_GUIDANCE = 'Проверки еще не зарегистрированы. Создайте checks.json по примеру node_modules/flowcairn/docs/CHECK-PROFILES.md. Остановите Flowcairn, выполните npx flowcairn setup --check-profile checks.json, затем npx flowcairn doctor и снова npx flowcairn.';

/** Legacy package scripts stay a distinct adapter, not a language detection rule. */
export function projectCheckProfile(root, profile) {
  if (isGenericProfile(profile)) return validateCheckProfile(profile.checkProfile);
  const node = realpathSync(process.execPath), bin = path.dirname(node);
  const manager = profile.packageManager;
  const entry = process.platform === 'win32' ? path.join(bin, 'node_modules', manager, 'bin', `${manager === 'npm' ? 'npm-cli.js' : `${manager}.cjs`}`) : path.join(bin, manager);
  const pkg = JSON.parse(readFileSync(containedCheckPath(root, 'package.json'), 'utf8'));
  const lock = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' }[manager];
  const defaults = { typecheck: 'typecheck', lint: 'lint', tests: 'test', build: 'build' };
  return validateCheckProfile({ version: 1, requiredCheckIds: profile.checks, environment: [], definitions: profile.checks.map((id) => {
    const script = profile.checkScripts?.[id] ?? defaults[id];
    if (!script || typeof pkg.scripts?.[script] !== 'string' || !pkg.scripts[script].trim()) fail('CHECK_SCRIPT_MISSING', 'Зарегистрированный npm script отсутствует.');
    return { id, title: `Проверка ${id}`, purpose: `Зарегистрированный script ${script}`, command: { executable: node, argv: [realpathSync(entry), 'run', script], cwd: '.' },
      inputPaths: ['package.json', ...(lock && existsSync(path.join(root, lock)) ? [lock] : [])], outputPaths: profile.outputPaths,
      timeoutMs: 1800000, maxOutputBytes: 2 * 1024 * 1024 };
  }) });
}

export function inspectProjectChecks(root, profile) {
  const checks = inspectCheckProfile(root, projectCheckProfile(root, profile));
  if (!isGenericProfile(profile)) for (const binding of checks.bindings) {
    const definition = checks.definitions.find((check) => check.id === binding.id);
    const launcher = checkFileIdentity(definition.command.argv[0], { executable: true });
    binding.toolchainHash = hashObject({ toolchainHash: binding.toolchainHash, launcher });
  }
  return checks;
}

export function validateCheckProfile(input) {
  const profile = CheckProfileSchema.parse(input);
  if (hasSecretContent(JSON.stringify(profile))) fail('CHECK_PROFILE_UNSAFE', 'Профиль проверок не может содержать секреты.');
  const ids = profile.definitions.map((check) => check.id);
  if (new Set(ids).size !== ids.length || new Set(profile.requiredCheckIds).size !== profile.requiredCheckIds.length ||
      profile.requiredCheckIds.some((id) => !ids.includes(id))) fail('CHECK_PROFILE_INVALID', 'Идентификаторы проверок должны быть уникальны и зарегистрированы.');
  const envNames = profile.environment.map(({ name }) => name.toUpperCase());
  if (envNames.some((name) => /(?:^|_)(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API_KEY|APIKEY|CREDENTIALS?|AUTHORIZATION|COOKIE)(?:_|$)/.test(name)))
    fail('CHECK_ENV_UNSAFE', 'Секреты и учетные данные не передаются через профиль проверок.');
  if (new Set(envNames).size !== envNames.length || envNames.some((name) =>
    !/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(?:PATH|HOME|USERPROFILE|CODEX_HOME|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|COMSPEC|BASH_ENV|ENV|SHELLOPTS|LD_.*|DYLD_.*)$/.test(name)))
    fail('CHECK_ENV_UNSAFE', 'Environment проверки содержит управляющую или неоднозначную переменную.');
  for (const check of profile.definitions) {
    if (check.id.startsWith('check-')) fail('CHECK_PROFILE_INVALID', 'ID проверки не включает префикс check-.');
    for (const output of check.outputPaths) {
      if (isSensitivePath(output) || ['src','app','lib','scripts','test','tests','AGENTS.md','README.md','package.json'].some((p) => inside(p, output)) ||
          profile.definitions.some((other) => other.inputPaths.some((input) => inside(input, output) || inside(output, input))))
        fail('CHECK_OUTPUT_UNSAFE', 'Выход проверки перекрывает исходники, входы или управляющие файлы.');
    }
  }
  return profile;
}

/** No child process is started here. Missing tools stay unavailable. */
export function inspectCheckProfile(root, input) {
  const profile = validateCheckProfile(input), canonical = realpathSync(root);
  const definitions = profile.definitions.filter((check) => profile.requiredCheckIds.includes(check.id));
  const bindings = definitions.map((check) => {
    const cwd = containedCheckPath(canonical, check.command.cwd);
    if (!lstatSync(cwd).isDirectory()) fail('CHECK_CWD_INVALID', 'Рабочий каталог проверки отсутствует.');
    for (const output of check.outputPaths) containedCheckPath(canonical, output, { missing: true });
    const executable = resolveCheckExecutable(canonical, check.command.executable);
    const definitionHash = hashObject(check);
    const invocationHash = hashObject({ executable: executable.executable, argv: check.command.argv, cwd,
      environment: profile.environment });
    const inputManifestHash = checkInputManifest(canonical, check.inputPaths);
    const toolchainHash = hashObject({ executable, invocationHash, inputManifestHash });
    return { id: check.id, definitionHash, executableHash: executable.hash, invocationHash, inputManifestHash, toolchainHash };
  });
  return PlanChecksSchema.parse({ version: 1, profileHash: hashObject(profile), definitions, bindings });
}

export function assertCheckRegistry(root, profile, planChecks) {
  const current = inspectProjectChecks(root, profile);
  if (hashObject(current) !== hashObject(planChecks)) fail('CHECK_REGISTRY_DRIFT', 'Команда, входы или инструмент проверки изменились после согласования.');
  return current;
}

export function checkProfileSummary(root, profile) {
  const generic = isGenericProfile(profile);
  const ids = generic ? profile.checkProfile.definitions.map((check) => check.id) : profile.checks;
  const profileHash = hashObject(generic ? profile.checkProfile : profile);
  const issues = [];
  const checks = ids.map((id) => {
    let reason = null, title = `Проверка ${id}`, purpose = 'Зарегистрированная проверка проекта';
    try {
      const selected = generic ? { ...profile.checkProfile, requiredCheckIds: [id], definitions: profile.checkProfile.definitions.filter((check) => check.id === id) }
        : projectCheckProfile(root, { ...profile, checks: [id] });
      const check = selected.definitions[0]; title = check.title; purpose = check.purpose;
      inspectCheckProfile(root, selected);
    }
    catch (error) { reason = error instanceof GraphError ? error.message : 'Инструмент или вход проверки недоступен.';
      issues.push({ checkId: id, code: error.code ?? 'CHECK_UNAVAILABLE', message: reason }); }
    return { id, title, purpose, available: reason === null, reason, profileHash };
  });
  if (!profile.checks.length) issues.push({ checkId: null, code: 'CHECKS_NOT_ENABLED', message: MISSING_CHECK_GUIDANCE });
  return { checks, toolchain: { status: issues.length ? 'missing' : 'ready', issues } };
}
