import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { containedCheckPath, checkFileIdentity } from '../scripts/ai-graph/lib/check-toolchain.mjs';
import { readContextFile, safeContextPath } from '../scripts/ai-graph/lib/project-context.mjs';
import { classifySource, hasSecretContent, isSensitivePath } from '../scripts/ai-graph/lib/source-policy.mjs';
import { validateCheckProfile } from '../scripts/ai-graph/lib/check-profile.mjs';
import { readRegular } from './project-files.mjs';

export const OWNER_CASES_FILE = 'flowcairn-check-cases.json';
const REPORT = '.flowcairn-test-report.json';
const ARTIFACTS = '.flowcairn-test-artifacts';
const reporter = fileURLToPath(new URL('../scripts/ai-graph/lib/node-test-reporter.mjs', import.meta.url));
const sourceExtensions = /\.(?:[cm]?js|[cm]?ts)$/;
const ignored = new Set(['node_modules', '.git', '.ai-orchestrator', '.agents', '.codex', '.claude', '.cursor', ARTIFACTS]);
const guidance = 'Scenario verifier не зарегистрирован. Для распознанного runner сохраните точные существующие case selectors в flowcairn-check-cases.json; иначе используйте setup --check-profile по docs/CHECK-PROFILES.md. Init не запускает tests или discovery commands.';
const fail = (code, message) => { throw new GraphError(code, message); };
const unavailable = (reason, runner = undefined) => ({ status: /** @type {const} */ ('unavailable'), reason, guidance, ...(runner ? { runner } : {}) });

/** A finite allowlist, not a shell parser. No lifecycle, environment, wrappers or filters. */
export function recognizeTestRecipe(script) {
  if (typeof script !== 'string' || script.length > 4096) return null;
  const words = script.trim().split(/ +/);
  if (words[0] === 'node' && words[1] === '--test' && words.length <= 58 &&
      words.slice(2).every((word) => /^[a-zA-Z0-9_./-]+\.(?:[cm]?js|[cm]?ts)$/.test(word))) {
    for (const file of words.slice(2)) safeContextPath(file);
    return { id: 'node:test', argv: words.slice(1) };
  }
  if (words.join(' ') === 'playwright test') return { id: 'playwright', argv: ['test'] };
  if (['jest', 'jest --runInBand'].includes(words.join(' '))) return { id: 'jest', argv: words.slice(1) };
  return null;
}

function present(root, relative) {
  try { lstatSync(path.join(root, relative)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function nodeFiles(root, explicit) {
  if (explicit.length) return explicit.map((file) => { containedCheckPath(root, file); return file; });
  const files = [];
  let entries = 0;
  const visit = (directory, depth = 0) => {
    if (depth > 12) fail('CHECK_RECIPE_LIMIT', 'Test discovery превышает ограниченную глубину.');
    for (const name of readdirSync(directory).sort()) {
      if (++entries > 4096) fail('CHECK_RECIPE_LIMIT', 'Test discovery превышает ограниченный inventory.');
      const file = path.join(directory, name), relative = path.relative(root, file).split(path.sep).join('/');
      if (ignored.has(name) || isSensitivePath(relative)) continue;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) fail('CHECK_RECIPE_LINK_UNSAFE', 'Test inventory не следует ссылкам.');
      if (stat.isDirectory()) visit(file, depth + 1);
      else if (stat.isFile() && sourceExtensions.test(name) &&
          (relative.split('/').slice(0, -1).includes('test') || /(?:\.test|[-_]test)\.(?:[cm]?js|[cm]?ts)$/.test(name) || /^test(?:-.*)?\.(?:[cm]?js|[cm]?ts)$/.test(name))) {
        safeContextPath(relative); files.push(relative);
        if (files.length > 80) fail('CHECK_RECIPE_LIMIT', 'Слишком много test files для ограниченного профиля.');
      }
    }
  };
  visit(root);
  return files;
}

// This scanner only selects literal top-level node:test names. It never evaluates JS.
// Ambiguous syntax (templates, regexp/division, aliases, nesting) requires owner selectors.
function literalNodeNames(text) {
  const tokens = [], lex = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|[^\s]/y;
  let offset = 0;
  while (offset < text.length) {
    if (/\s/.test(text[offset])) { offset++; continue; }
    lex.lastIndex = offset;
    const match = lex.exec(text);
    if (!match) return null;
    const raw = match[0]; offset = lex.lastIndex;
    if (raw.startsWith('//') || raw.startsWith('/*')) continue;
    if (raw === '`' || raw === '/') return null;
    tokens.push({ value: raw, start: match.index, string: raw[0] === '"' || raw[0] === "'" });
  }
  const imports = new Set();
  let bindings = 0;
  for (let i = 0; i < tokens.length; i++) if (tokens[i].string && ["'node:test'", '"node:test"'].includes(tokens[i].value) && tokens[i - 1]?.value === 'from') {
    const simple = tokens.slice(i - 3, i).map((token) => token.value).join(' ');
    const named = tokens.slice(i - 5, i).map((token) => token.value).join(' ');
    if (simple === 'import test from') imports.add(i - 2);
    else if (named === 'import { test } from') imports.add(i - 3);
    else return null;
    bindings++;
  }
  if (bindings !== 1) return null;
  const names = [], stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.string && token.value === 'test' && !imports.has(i)) {
      const name = tokens[i + 2], prefix = text.slice(text.lastIndexOf('\n', token.start - 1) + 1, token.start);
      const previous = tokens[i - 1], afterImport = previous?.string && ['from', 'import'].includes(tokens[i - 2]?.value);
      if (stack.length || prefix.trim() || !afterImport && ![';', '}'].includes(previous?.value) || tokens[i + 1]?.value !== '(' || !name?.string || tokens[i + 3]?.value !== ',' ||
          /[\\\r\n]/.test(name.value) || name.value.length > 1026) return null;
      const value = name.value.slice(1, -1);
      if (!value.trim() || hasSecretContent(value)) return null;
      names.push(sha256(value));
    }
    if (!token.string && ['(', '[', '{'].includes(token.value)) stack.push(token.value);
    else if (!token.string && [')', ']', '}'].includes(token.value) &&
        stack.pop() !== { ')': '(', ']': '[', '}': '{' }[token.value]) return null;
  }
  return stack.length || !names.length ? null : names;
}

function installedRunner(root, id) {
  const packageName = id === 'playwright' ? '@playwright/test' : 'jest';
  const metadataPath = `node_modules/${packageName}/package.json`;
  const metadata = JSON.parse(readRegular(containedCheckPath(root, metadataPath), 64 * 1024).toString('utf8'));
  const major = id === 'playwright' ? 1 : '(?:29|30)';
  if (metadata.name !== packageName || !new RegExp(`^${major}\\.\\d+\\.\\d+$`).test(metadata.version))
    return null;
  const cli = id === 'playwright' ? `node_modules/${packageName}/cli.js` : 'node_modules/jest/bin/jest.js';
  const declared = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[id];
  if (declared?.replace(/^\.\//, '') !== (id === 'playwright' ? 'cli.js' : 'bin/jest.js')) return null;
  checkFileIdentity(containedCheckPath(root, cli));
  return { id, version: metadata.version, cli, identityFiles: [metadataPath, cli] };
}

function ownerCases(root, id) {
  if (!present(root, OWNER_CASES_FILE)) return null;
  const source = readContextFile(root, OWNER_CASES_FILE, { maxBytes: 64 * 1024 });
  const value = JSON.parse(source.text);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['version', 'runner', 'requiredScenarios', 'sourcePaths'].includes(key)) ||
      value.version !== 1 || value.runner !== id || !Array.isArray(value.requiredScenarios) ||
      !value.requiredScenarios.length || value.requiredScenarios.length > 128 ||
      value.requiredScenarios.some((item) => typeof item !== 'string' || !item.trim() || item.length > 1024 || hasSecretContent(item)) ||
      new Set(value.requiredScenarios).size !== value.requiredScenarios.length)
    fail('CHECK_RECIPE_CASES_INVALID', 'Нужны version:1, текущий runner и уникальные exact requiredScenarios владельца.');
  const inputs = value.sourcePaths ?? [];
  if (!Array.isArray(inputs) || inputs.length > 80 || new Set(inputs).size !== inputs.length ||
      inputs.some((file) => typeof file !== 'string')) fail('CHECK_RECIPE_CASES_INVALID', 'sourcePaths владельца содержит ограниченные уникальные файлы.');
  const inputSources = inputs.map((file) => { safeContextPath(file); const loaded = readContextFile(root, file, { maxBytes: 256 * 1024 });
    if (classifySource(file, Buffer.from(loaded.text)).reason) fail('CHECK_RECIPE_CASES_INVALID', 'Вход verifier не может быть закрытым или generated файлом.');
    return { path: loaded.path, hash: loaded.hash }; });
  return { cases: value.requiredScenarios, source: { path: source.path, hash: source.hash }, inputSources };
}

/** Owner-side registration only. Reading a config/module never executes it. */
export function discoverCheckRecipe(root, pkg) {
  if (!pkg?.scripts?.test) return { status: /** @type {const} */ ('not-needed'), reason: 'NO_TEST_SCRIPT' };
  if (pkg.scripts.pretest || pkg.scripts.posttest) return unavailable('TEST_LIFECYCLE_UNSUPPORTED');
  const recognized = recognizeTestRecipe(pkg.scripts.test);
  if (!recognized) return unavailable('TEST_SCRIPT_UNSUPPORTED');
  if (!process.versions.node.startsWith('22.')) return unavailable('NODE22_REQUIRED');
  const node = realpathSync(process.execPath);
  let runner, requiredScenarios, sources = [], inputPaths = ['package.json'], argv, format;
  const explicit = ownerCases(root, recognized.id);
  if (recognized.id === 'node:test') {
    runner = { id: recognized.id, version: process.versions.node };
    const files = nodeFiles(root, recognized.argv.slice(1));
    let bytes = 0;
    for (const file of files) {
      const source = readContextFile(root, file, { maxBytes: 256 * 1024 });
      if (classifySource(file, Buffer.from(source.text)).reason) return unavailable('TEST_SOURCE_UNSUPPORTED', runner);
      bytes += Buffer.byteLength(source.text);
      if (bytes > 1024 * 1024) return unavailable('TEST_DISCOVERY_LIMIT', runner);
      sources.push({ path: source.path, hash: source.hash });
      if (!explicit) {
        const names = literalNodeNames(source.text);
        if (!names) return unavailable('OWNER_CASES_REQUIRED', runner);
        requiredScenarios = [...(requiredScenarios ?? []), ...names];
      }
    }
    if (!files.length) return unavailable('TEST_FILES_MISSING', runner);
    format = 'flowcairn-node-test/v1';
    argv = ['--test', `--test-reporter=${reporter}`, `--test-reporter-destination=${REPORT}`, ...recognized.argv.slice(1)];
  } else {
    try { runner = installedRunner(root, recognized.id); }
    catch (error) { if (error.code === 'ENOENT') return unavailable('RUNNER_NOT_INSTALLED'); throw error; }
    if (!runner) return unavailable('RUNNER_VERSION_UNSUPPORTED');
    if (!explicit) return unavailable('OWNER_CASES_REQUIRED', { id: runner.id, version: runner.version });
    format = recognized.id === 'playwright' ? 'playwright-json' : 'jest-json';
    argv = [runner.cli, ...recognized.argv, ...(recognized.id === 'playwright'
      ? ['--reporter=json', `--output=${ARTIFACTS}`] : ['--json', `--outputFile=${REPORT}`, '--testLocationInResults'])];
  }
  if (explicit) { requiredScenarios = explicit.cases; inputPaths.push(OWNER_CASES_FILE);
    sources.push(explicit.source, ...explicit.inputSources); }
  // Test/app source is the current workspace fingerprint, not an immutable registry input.
  // Only invocation/configuration material is pinned here; sealed control oracles are separate.
  for (const file of recognized.id === 'node:test' ? [] :
      recognized.id === 'playwright' ? ['playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.ts', 'playwright.config.mts', 'playwright.config.cts']
        : ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.cts', 'jest.config.json']) {
    if (present(root, file)) { readContextFile(root, file, { maxBytes: 256 * 1024 }); inputPaths.push(file); }
  }
  if (!requiredScenarios?.length || requiredScenarios.length > 128 || new Set(requiredScenarios).size !== requiredScenarios.length)
    return unavailable('OWNER_CASES_REQUIRED', { id: runner.id, version: runner.version });
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) if (present(root, lock)) inputPaths.push(lock);
  const outputPaths = [REPORT, ...(recognized.id === 'playwright' ? [ARTIFACTS] : [])];
  if (outputPaths.some((file) => present(root, file))) fail('CHECK_RECIPE_OUTPUT_CONFLICT', 'Выход recipe уже существует; init не перезаписывает чужой отчет или artifacts.');
  const checkProfile = validateCheckProfile({ version: 1, requiredCheckIds: ['tests'], environment: recognized.id === 'playwright'
    ? [{ name: 'PLAYWRIGHT_JSON_OUTPUT_FILE', value: REPORT }] : [], definitions: [{
      id: 'tests', title: 'Проверка существующих tests', purpose: 'Existing runner и exact scenario selectors; критерий оценивается отдельно.',
      command: { executable: node, argv, cwd: '.' }, inputPaths,
      identityFiles: recognized.id === 'node:test' ? [reporter] : runner.identityFiles,
      outputPaths, timeoutMs: 1800000, maxOutputBytes: 2 * 1024 * 1024,
      report: { version: 1, format, path: REPORT, requiredScenarios },
    }] });
  return { status: /** @type {const} */ ('ready'), reason: 'SOURCE_BOUND_RECIPE', runner: { id: runner.id, version: runner.version },
    selectors: { source: explicit ? 'owner-existing-cases' : 'literal-source-candidates', files: sources,
      acceptance: 'unverified', semanticAdequacy: 'unassessed' }, checkProfile };
}
