import { lstatSync, readFileSync, realpathSync, existsSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { parseDocument } from 'yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { RelativePath } from './schemas.mjs';
import { assertRuntimePlatform, assertProjectPlatform } from './platform.mjs';

export const RUNTIME_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
);
export const PROJECT_PROFILE_FILE = '.flowcairn.json';

const safeProfilePath = RelativePath.refine(
  (value) =>
    !value
      .split('/')
      .some(
        (part) =>
          /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|\.netrc$|credentials(?:\.json)?$|id_rsa$|id_ed25519$)/i.test(
            part,
          ) ||
          /\.(?:pem|key|p12|pfx)$/i.test(part) ||
          /(?:^|[._-])secrets?(?:[._-](?:json|ya?ml|toml|txt))?$/i.test(part),
      ),
  'Sensitive paths are not project context',
);
const paths = z
  .array(safeProfilePath)
  .max(32)
  .refine((values) => new Set(values).size === values.length, 'Duplicate paths');
const branch = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes('..') &&
      !value.includes('//') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')),
  );
const model = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const checkId = z.enum(['typecheck', 'lint', 'tests', 'build']);
const checkScript = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);

export const PROJECT_CHECK_IDS = Object.freeze(['typecheck', 'lint', 'tests', 'build']);
export const DEFAULT_CHECK_SCRIPTS = Object.freeze({
  typecheck: 'typecheck',
  lint: 'lint',
  tests: 'test',
  build: 'build',
});
const CHECK_SCRIPT_CANDIDATES = Object.freeze({
  typecheck: Object.freeze(['typecheck', 'compile']),
  lint: Object.freeze(['lint']),
  tests: Object.freeze(['test']),
  build: Object.freeze(['build']),
});

/** Trusted local configuration: fixed action names, never executable code or credentials. */
export const ProjectProfileSchema = z.strictObject({
  version: z.literal(1),
  integrationBranch: branch,
  packageManager: z.enum(['npm', 'pnpm', 'yarn']),
  contextPaths: paths,
  checks: z
    .array(checkId)
    .max(4)
    .refine((values) => new Set(values).size === values.length),
  checkScripts: z
    .object({
      typecheck: checkScript.optional(),
      lint: checkScript.optional(),
      tests: checkScript.optional(),
      build: checkScript.optional(),
    })
    .strict()
    .optional(),
  outputPaths: paths.refine((values) =>
    values.every(
      (value) =>
        !['AGENTS.md', 'README.md', 'package.json', '.flowcairn.json'].some(
          (name) => name === value || name.startsWith(`${value}/`),
        ),
    ),
  ),
  manifests: paths,
  skillManifest: z.array(z.strictObject({
    id: z.string().regex(/^project-[a-z][a-z0-9-]{1,63}$/).refine((value) => value !== 'project-context'),
    path: safeProfilePath.refine((value) => value.endsWith('/SKILL.md')),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.array(z.union([z.literal('.'), safeProfilePath])).min(1).max(8),
    actions: z.array(z.enum(['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'])).min(1).max(4)
      .refine((values) => new Set(values).size === values.length),
  })).max(4).refine((values) => new Set(values.map((item) => item.id)).size === values.length).optional(),
  onboarding: z.strictObject({
    version: z.literal(1),
    readConsent: z.boolean(),
    readScope: z.literal('tracked-project'),
    testPolicy: z.enum(['keep', 'add']),
    coverage: z.boolean(),
    instructions: z.literal('preserve'),
  }).optional(),
  ai: z.strictObject({
    provider: z.enum(['codex', 'openai']),
    model,
    reviewModel: model.optional(),
    modelMode: z.enum(['manual', 'auto']).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    reviewReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    codexPath: z
      .string()
      .max(1024)
      .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
      .optional(),
    baseUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      })
      .optional(),
  }),
});

export const PACKAGE_MANAGER_LOCKS = Object.freeze({ npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' });

export function packageManagerLock(manager) {
  if (!Object.hasOwn(PACKAGE_MANAGER_LOCKS, manager))
    throw new GraphError('PACKAGE_MANAGER', 'Доступны npm, pnpm и Yarn 4 с node_modules. Bun пока не поддерживается.');
  return PACKAGE_MANAGER_LOCKS[manager];
}

/**
 * Maps stable Flowcairn checks to existing project scripts. The mapping is derived
 * only from package.json and is later revalidated before a Docker check starts.
 */
export function discoverProjectChecks(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
    throw new GraphError('PACKAGE_JSON', 'В package.json нужен объект проекта.');
  const scripts = pkg.scripts;
  if (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)))
    throw new GraphError('PACKAGE_SCRIPTS', 'package.json scripts должен быть объектом.');
  const checks = [];
  const checkScripts = {};
  for (const id of PROJECT_CHECK_IDS) {
    const script = CHECK_SCRIPT_CANDIDATES[id].find((candidate) =>
      typeof scripts?.[candidate] === 'string' && scripts[candidate].trim().length > 0,
    );
    if (!script) continue;
    checks.push(id);
    checkScripts[id] = script;
  }
  return { checks, checkScripts };
}

function checkIdFromAction(actionId) {
  const match = /^check-(typecheck|lint|tests|build)$/.exec(actionId ?? '');
  if (!match) throw new GraphError('CHECK_ACTION_UNSUPPORTED', 'Action не является зарегистрированной проверкой.');
  return checkId.parse(match[1]);
}

/**
 * A task never supplies a command. The project profile selects a script name
 * during init, and the current package manifest must still contain that script.
 */
export function resolveProjectCheckScript(root, actionId, profile = loadProjectProfile(root)) {
  const id = checkIdFromAction(actionId);
  if (!profile.checks.includes(id))
    throw new GraphError('CHECK_UNSUPPORTED', `Проверка ${id} не включена в профиль проекта.`);
  const script = profile.checkScripts?.[id] ?? DEFAULT_CHECK_SCRIPTS[id];
  const parsed = checkScript.safeParse(script);
  if (!parsed.success) throw new GraphError('CHECK_SCRIPT_INVALID', 'Имя script проверки недопустимо.');
  let pkg;
  try {
    pkg = JSON.parse(managerFile(realpathSync(root), 'package.json'));
  } catch {
    throw new GraphError('PACKAGE_JSON', 'Невозможно прочитать package.json для проверки script.');
  }
  if (typeof pkg?.scripts?.[parsed.data] !== 'string' || !pkg.scripts[parsed.data].trim())
    throw new GraphError('CHECK_SCRIPT_MISSING', `В package.json отсутствует script ${parsed.data}.`);
  return parsed.data;
}

/** Only exact registry versions, never URL/range/tag package manager payloads. */
export function packageManagerVersion(manager, pkg) {
  packageManagerLock(manager);
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
    throw new GraphError('PACKAGE_MANAGER_VERSION', 'В package.json нужен объект проекта.');
  if (pkg.packageManager === undefined) {
    if (manager === 'npm') return 'bundled';
    if (manager === 'pnpm') return '11.8.0';
    throw new GraphError('PACKAGE_MANAGER_VERSION', 'Для Yarn нужен packageManager: yarn@4.x.y с точной версией в package.json.');
  }
  const match = typeof pkg.packageManager === 'string' && pkg.packageManager.length <= 200 && /^(npm|pnpm|yarn)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(pkg.packageManager);
  if (!match || match[1] !== manager)
    throw new GraphError('PACKAGE_MANAGER_VERSION', 'packageManager должен совпадать с выбранным менеджером и содержать точную registry-версию; URL, ranges и tags запрещены.');
  const major = Number(match[2].split('.')[0]);
  if ((manager === 'yarn' && major !== 4) || (manager === 'pnpm' && ![9, 10, 11].includes(major)))
    throw new GraphError('PACKAGE_MANAGER_VERSION', 'Поддерживаемая граница: pnpm 9–11 или Yarn 4 с node_modules.');
  return match[2];
}

function managerFile(root, relative) {
  const fd = openSync(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new GraphError('PACKAGE_MANAGER_CONFIG', 'Конфигурация менеджера должна быть ограниченным обычным файлом без ссылок.');
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new GraphError('PACKAGE_MANAGER_CONFIG', 'Конфигурация менеджера превышает лимит.');
    return text;
  } finally { closeSync(fd); }
}

/** Inspect only project files, never global config. Yarn config is not sent to Docker. */
export function validatePackageManagerProject(root, manager, pkg = JSON.parse(managerFile(root, 'package.json'))) {
  const version = packageManagerVersion(manager, pkg);
  if (manager === 'yarn') {
    let config;
    try {
      const document = parseDocument(managerFile(root, '.yarnrc.yml'), { strict: true, uniqueKeys: true });
      if (document.errors.length || document.warnings.length) throw Error();
      config = document.toJS({ maxAliasCount: 0 });
    } catch {
      throw new GraphError('YARN_CONFIG', 'Нужна .yarnrc.yml с единственной настройкой nodeLinker: node-modules. Yarn PnP, plugins и приватные registry требуют отдельной интеграции.');
    }
    if (!config || Object.keys(config).join(',') !== 'nodeLinker' || config.nodeLinker !== 'node-modules')
      throw new GraphError('YARN_CONFIG', 'Поддерживается только .yarnrc.yml с nodeLinker: node-modules; другие настройки не копируются и требуют отдельной интеграции.');
    for (const name of ['.pnp.cjs', '.pnp.loader.mjs', '.yarnrc']) {
      try { lstatSync(path.join(root, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new GraphError('YARN_CONFIG', 'Yarn PnP и classic configuration пока не поддерживаются.');
    }
  }
  return version;
}

export function loadProjectProfile(root) {
  assertRuntimePlatform();
  const canonical = realpathSync(root);
  assertProjectPlatform(canonical);
  const file = path.join(canonical, PROJECT_PROFILE_FILE);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new GraphError('PROJECT_PROFILE_MISSING', 'Run flowcairn init to create .flowcairn.json');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768) {
    throw new GraphError(
      'PROJECT_PROFILE_UNSAFE',
      '.flowcairn.json must be a bounded regular file without links',
    );
  }
  try {
    return ProjectProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new GraphError(
      'PROJECT_PROFILE_INVALID',
      '.flowcairn.json does not match the strict project profile',
    );
  }
}

export function projectProfileHash(root) {
  return hashObject(loadProjectProfile(root));
}

export function projectContextPaths(root, profile = loadProjectProfile(root)) {
  return [
    ...new Set([
      ...['AGENTS.md', 'AGENT.md', 'README.md'].filter((name) => existsSync(path.join(root, name))),
      ...profile.contextPaths,
      ...profile.manifests.filter((file) => /(?:^|\/)package\.json$/.test(file)),
    ]),
  ];
}

/** Разрешение хранится локально и связано с точным профилем и корнем проекта. */
export function onboardingConsentHash(root, profile) {
  return hashObject({ root: realpathSync(root), profile });
}

export function hasOnboardingConsent(root, profile = loadProjectProfile(root)) {
  if (profile.onboarding?.readConsent !== true) return false;
  try {
    const directory = path.join(realpathSync(root), '.ai-orchestrator');
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) return false;
    const file = path.join(directory, 'flowcairn-install.json');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = fstatSync(fd);
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > 1024 * 1024 || (entry.mode & 0o077)) return false;
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      return value.tool === 'flowcairn' && /^flowcairn-[a-f0-9-]+$/.test(value.owner ?? '') &&
        value.readConsentHash === onboardingConsentHash(root, profile);
    } finally { closeSync(fd); }
  } catch { return false; }
}
