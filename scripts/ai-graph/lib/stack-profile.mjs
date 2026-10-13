import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { discoverWorkspaceManifests } from '../../../bin/workspaces.mjs';
import { lstatHostSync, realpathHostSync, sameHostPath } from './host-filesystem.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { safeContextPath, readContextFile } from './project-context.mjs';
import { assertJsonBounds } from './schemas.mjs';
import { discoverScopedStackManifests } from './stack-manifest-discovery.mjs';

const LEGACY_NAMES = ['requirements.txt', 'go.mod', 'pom.xml', 'composer.json', 'index.html'];
const NAMES = ['package.json', 'pyproject.toml', 'pubspec.yaml', 'build.gradle', 'build.gradle.kts', 'Package.swift', ...LEGACY_NAMES];
const LIMITS = Object.freeze({ scopes: 64, manifests: 256, probes: 16384, bytes: 262144, totalBytes: 8388608 });
const LIMITATIONS = ['declarations-not-installed-versions', 'guidance-not-toolchain-or-acceptance-proof',
  'dynamic-configuration-not-evaluated', 'native-variable-manifests-require-explicit-paths', 'major-only-compatibility-does-not-resolve-minors'];
const JS = {
  react: ['react', 'frontend'], 'react-dom': ['react-dom', 'frontend'], next: ['next', 'frontend'],
  vue: ['vue', 'frontend'], nuxt: ['nuxt', 'frontend'], '@angular/core': ['angular', 'frontend'],
  svelte: ['svelte', 'frontend'], '@sveltejs/kit': ['sveltekit', 'frontend'],
  'solid-js': ['solid', 'frontend'], preact: ['preact', 'frontend'], astro: ['astro', 'frontend'],
  express: ['express', 'backend'], fastify: ['fastify', 'backend'], '@nestjs/core': ['nestjs', 'backend'],
  koa: ['koa', 'backend'], hono: ['hono', 'backend'], '@hapi/hapi': ['hapi', 'backend'],
  restify: ['restify', 'backend'], 'react-native': ['react-native', 'mobile'], expo: ['expo', 'mobile'],
};
const PYTHON = new Set(['fastapi', 'django', 'flask', 'starlette', 'sanic', 'tornado', 'litestar']);
const sorted = (values) => [...new Set(values)].sort();
const within = (file, directory) => directory === '.' || file === directory || file.startsWith(`${directory}/`);
const overlaps = (a, b) => within(a, b) || within(b, a);
const fail = (code, message) => { throw new GraphError(code, message); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => fail('STACK_MANIFEST_INVALID', 'Некорректный manifest стека');

function format(file) {
  const name = path.posix.basename(file);
  if (NAMES.includes(name)) return name;
  if (/\.csproj$/i.test(name)) return 'csproj';
  if (/\.xcodeproj\/project\.pbxproj$/.test(file)) return 'xcode-project';
  return null;
}

/** Only numeric declarations leave the parser. URLs, paths, tags and interpolations stay unknown.
 * A major is usable for conservative method routing, never as an installed version assertion.
 */
function version(raw) {
  const specifier = typeof raw === 'string' && raw.length <= 128 && /^[0-9vx*~^<>=!|,. +()-]+$/.test(raw.trim())
    ? raw.trim() : null;
  const fixedMajor = specifier && !/^~=\d+$/.test(specifier) &&
    /^(?:\^|~|~=|==|=)?v?(\d+)(?:\.(?:\d+(?:\.(?:\d+|x|\*))?|x|\*))?$/.exec(specifier);
  const major = fixedMajor && Number.isSafeInteger(Number(fixedMajor[1])) ? Number(fixedMajor[1]) : null;
  const exact = specifier && /^(?:==|=)v?\d+(?:\.\d+){0,2}$|^v?\d+(?:\.\d+){2}$/.test(specifier);
  return { specifier, major, status: major === null ? 'unknown' : exact ? 'exact' : 'range' };
}

function framework(id, domain, raw, role = 'dependency') {
  return { id, domain, role, version: version(raw) };
}

function structured(text, kind) {
  try {
    let data;
    if (kind === 'json') data = JSON.parse(text);
    else if (kind === 'toml') data = parseToml(text, { maxDepth: 24, unsafeKeyBehaviour: 'throw' });
    else {
      const doc = parseDocument(text, { strict: true, uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) invalid();
      data = doc.toJS({ maxAliasCount: 0 });
    }
    assertJsonBounds(data, 10000);
    if (!object(data)) invalid();
    return data;
  } catch { invalid(); }
}

function packageFacts(data) {
  const facts = [];
  const mobile = ['dependencies', 'devDependencies', 'peerDependencies'].some((field) =>
    object(data[field]) && ['react-native', 'expo'].some((name) => Object.hasOwn(data[field], name)));
  for (const [field, role] of [['dependencies', 'dependency'], ['devDependencies', 'development'], ['peerDependencies', 'peer']]) {
    if (data[field] !== undefined && !object(data[field])) invalid();
    for (const [name, raw] of Object.entries(data[field] ?? {})) {
      if (typeof raw !== 'string') invalid();
      if (!Object.hasOwn(JS, name)) continue;
      const [id, domain] = JS[name];
      facts.push(framework(id, name === 'react' && mobile ? 'mobile' : domain, raw, role));
    }
  }
  return facts;
}

function pythonFacts(data) {
  const facts = [];
  const dependencies = data.project?.dependencies;
  if (dependencies !== undefined && !Array.isArray(dependencies)) invalid();
  const requirement = (raw, role) => {
    if (typeof raw !== 'string') invalid();
    // PEP 508 markers/URLs are not evaluated or disclosed; optional groups are not assumed active.
    const match = /^\s*([a-z0-9][a-z0-9._-]*)(?:\[[a-z0-9_, -]+\])?\s*([^;@]*)?(?:[;@][\s\S]*)?$/i.exec(raw);
    const id = match?.[1].toLowerCase().replace(/[_.]+/g, '-');
    const actualRole = raw.includes(';') ? 'conditional' : role;
    if (PYTHON.has(id)) facts.push(framework(id, ['optional', 'conditional'].includes(actualRole) ? 'engineering' : 'backend', match[2]?.trim(), actualRole));
  };
  for (const raw of dependencies ?? []) requirement(raw, 'dependency');
  const optional = data.project?.['optional-dependencies'];
  if (optional !== undefined && !object(optional)) invalid();
  for (const group of Object.values(optional ?? {})) {
    if (!Array.isArray(group)) invalid();
    for (const raw of group) requirement(raw, 'optional');
  }
  const poetry = data.tool?.poetry?.dependencies;
  if (poetry !== undefined && !object(poetry)) invalid();
  for (const [name, raw] of Object.entries(poetry ?? {})) {
    const id = name.toLowerCase().replace(/[_.]+/g, '-');
    if (!PYTHON.has(id)) continue;
    const indirect = object(raw) && ['path', 'git', 'url'].some((key) => Object.hasOwn(raw, key));
    const optional = object(raw) && raw.optional === true;
    facts.push(framework(id, optional ? 'engineering' : 'backend', indirect ? null : typeof raw === 'string' ? raw : raw?.version,
      optional ? 'optional' : 'dependency'));
  }
  return facts;
}

function flutterFacts(data) {
  if (data.dependencies !== undefined && !object(data.dependencies)) invalid();
  const flutter = data.dependencies?.flutter;
  if (!object(flutter) || flutter.sdk !== 'flutter') return [];
  return [framework('flutter', 'mobile', data.environment?.flutter, 'sdk')];
}

/** Comment stripping keeps string contents intact; masking prevents strings from becoming code. */
function staticCode(text) {
  const comments = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g;
  const clean = text.replace(comments, (match, literal) => literal ?? match.replace(/[^\r\n]/g, ' '));
  const masked = clean.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (match) => match.replace(/[^\r\n]/g, ' '));
  if (/["']|\/\*|\*\//.test(masked)) return { clean: '', masked: '' };
  return { clean, masked };
}

function codeBlocks(code, pattern, topLevel = true) {
  const blocks = [];
  let matches = 0;
  for (const match of code.masked.matchAll(pattern)) {
    if (++matches > 1024) fail('STACK_PROFILE_LIMIT', 'Слишком много деклараций в manifest стека');
    const before = code.masked.slice(0, match.index);
    if (topLevel && (before.match(/\{/g)?.length ?? 0) !== (before.match(/\}/g)?.length ?? 0)) continue;
    let depth = 1, end = match.index + match[0].length;
    const start = end;
    for (; end < code.masked.length && depth; end++) {
      if (code.masked[end] === '{') depth++;
      if (code.masked[end] === '}') depth--;
    }
    if (!depth) blocks.push({ clean: code.clean.slice(start, end - 1), masked: code.masked.slice(start, end - 1) });
  }
  return blocks;
}

function gradleFacts(text) {
  const code = staticCode(text), facts = [];
  for (const block of codeBlocks(code, /\bplugins\s*\{/g)) {
    for (const lineMatch of block.clean.matchAll(/[^\r\n;]+/g)) {
      const line = lineMatch[0];
      if (!/^\s*(?:id|kotlin)\b/.test(block.masked.slice(lineMatch.index, lineMatch.index + line.length))) continue;
      const match = /^\s*(?:id\s*(?:\(\s*["']([^"']+)["']\s*\)|["']([^"']+)["'])|kotlin\(\s*["'](android|jvm)["']\s*\))\s*(?:version\s*(?:\(\s*["']([^"']*)["']\s*\)|["']([^"']*)["']|([\w.$]+)))?\s*(?:apply\s+(false|true))?\s*$/.exec(line);
      if (!match) continue;
      const id = match[1] ?? match[2] ?? `org.jetbrains.kotlin.${match[3]}`;
      const raw = match[4] ?? match[5] ?? null;
      const applied = match[7] !== 'false';
      if (['com.android.application', 'com.android.library'].includes(id)) {
        facts.push(framework('android-gradle-plugin', applied ? 'mobile' : 'engineering', raw, applied ? 'plugin' : 'plugin-not-applied'));
        if (applied) facts.push(framework('android', 'mobile', null, 'platform'));
      }
      else if (id === 'org.springframework.boot')
        facts.push(framework('spring-boot', applied ? 'backend' : 'engineering', raw, applied ? 'plugin' : 'plugin-not-applied'));
      else if (['org.jetbrains.kotlin.android', 'org.jetbrains.kotlin.jvm'].includes(id))
        facts.push(framework(id.endsWith('.android') ? 'kotlin-android' : 'kotlin-jvm', 'engineering', raw, applied ? 'plugin' : 'plugin-not-applied'));
    }
  }
  return facts;
}

function swiftFacts(text) {
  const code = staticCode(text), facts = [];
  const tools = /^\s*\/\/\s*swift-tools-version:\s*([0-9]+(?:\.[0-9]+){1,2})\s*(?:\r?\n|$)/.exec(text);
  if (tools) facts.push(framework('swift-package', 'engineering', tools[1], 'tools-requirement'));
  // A Swift package alone is not evidence of an iOS app. Only a literal platforms list supplies that guidance.
  const declaration = /^\s*let\s+package\s*=\s*Package\s*\(/m.exec(code.masked);
  if (!declaration) return facts;
  const before = code.masked.slice(0, declaration.index);
  if ((before.match(/\{/g)?.length ?? 0) !== (before.match(/\}/g)?.length ?? 0)) return facts;
  let end = declaration.index + declaration[0].length, depth = 1;
  const start = end;
  for (; end < code.masked.length && depth; end++) {
    if (code.masked[end] === '(') depth++;
    if (code.masked[end] === ')') depth--;
  }
  if (depth) return facts;
  const list = /\bplatforms\s*:\s*\[([^\]]*)\]/.exec(code.masked.slice(start, end - 1));
  if (list) {
    const literal = code.clean.slice(start + list.index, start + list.index + list[0].length);
    if (/\[|\]|\{|\}/.test(list[1])) return facts;
    if (!/^platforms\s*:\s*\[\s*(?:\.(?:iOS|macOS|tvOS|watchOS|visionOS|macCatalyst|driverKit)\(\s*(?:\.v\d+(?:_\d+)*|"\d+(?:\.\d+)*")\s*\)\s*,?\s*)+\]$/.test(literal)) return facts;
    const target = /\.iOS\(\s*(?:\.v(\d+(?:_\d+)*)|"(\d+(?:\.\d+)*)")\s*\)/.exec(literal);
    if (target) facts.push(framework('ios', 'mobile', (target[1] ?? target[2]).replaceAll('_', '.'), 'deployment-target'));
  }
  return facts;
}

function xcodeFacts(text) {
  const code = staticCode(text);
  const facts = [];
  // Explicit SDK assignment is a platform declaration, not a device/build observation.
  for (const { clean, masked } of codeBlocks(code, /\bbuildSettings\s*=\s*\{/g, false)) {
    if (/(?:^|;)\s*SDKROOT\s*=\s*iphoneos\s*;/.test(masked) ||
      /(?:^|;)\s*SUPPORTED_PLATFORMS\s*=\s*"(?:iphoneos|iphonesimulator)(?:\s+(?:iphoneos|iphonesimulator))*"\s*;/.test(clean)) {
      const deployment = /(?:^|;)\s*IPHONEOS_DEPLOYMENT_TARGET\s*=\s*(\d+(?:\.\d+)*)\s*;/.exec(masked);
      facts.push(framework('ios', 'mobile', deployment?.[1], 'deployment-target'));
    }
  }
  return facts;
}

function dotnetFacts(text) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(clean)) return [];
  const project = /^\s*(?:<\?xml[^?]*\?>\s*)?<Project\b([^>]*)>([\s\S]*)<\/Project\s*>\s*$/.exec(clean) ??
    /^\s*(?:<\?xml[^?]*\?>\s*)?<Project\b([^>]*)\/>\s*$/.exec(clean);
  if (!project) invalid();
  if (/\bCondition\s*=/.test(project[1])) return [];
  const sdk = /(?:^|\s)Sdk\s*=\s*["'](Microsoft\.NET\.Sdk(?:\.Web)?)["']/.exec(project[1])?.[1];
  const body = (project[2] ?? '').replace(/<(?:Target|Choose|ItemGroup|ImportGroup)\b[^>]*>[\s\S]*?<\/(?:Target|Choose|ItemGroup|ImportGroup)\s*>/g, '');
  const facts = [];
  if (sdk === 'Microsoft.NET.Sdk.Web') facts.push(framework('aspnet-core', 'backend', null, 'sdk'));
  const residue = body.replace(/<PropertyGroup\b[^>]*>[\s\S]*?<\/PropertyGroup\s*>|<(?:Import|Sdk)\b[^>]*\/>/g, '');
  if (residue.trim()) return facts;
  for (const group of body.matchAll(/<PropertyGroup\s*>([\s\S]*?)<\/PropertyGroup\s*>/g)) {
    if (/<[^>]+>\s*</.test(group[1])) continue;
    for (const target of group[1].matchAll(/<TargetFrameworks?\s*>\s*([^<]+)\s*<\/TargetFrameworks?\s*>/g)) {
      for (const raw of target[1].trim().split(';')) {
        const tfm = /^net(\d+)\.(\d+)(?:-(ios|android)(?:[\d.]+)?)?$/.exec(raw.trim());
        if (!tfm) continue;
        facts.push(framework('dotnet', tfm[3] ? 'mobile' : 'engineering', `${tfm[1]}.${tfm[2]}`, 'target-framework'));
        if (tfm[3]) facts.push(framework(tfm[3], 'mobile', null, 'target-framework'));
      }
    }
  }
  return facts;
}

/** Preserve the legacy domain contract without inventing unsupported framework/version evidence. */
function legacyDomains(kind, text) {
  if (kind === 'index.html') return ['frontend'];
  if (kind === 'composer.json') {
    const data = structured(text, 'json'), dependencies = data.require ?? {};
    if (!object(dependencies)) invalid();
    return ['laravel/framework', 'symfony/framework-bundle', 'slim/slim'].some((name) => Object.hasOwn(dependencies, name)) ? ['backend'] : [];
  }
  if (kind === 'requirements.txt') return text.split(/\r?\n/).some((line) =>
    /^\s*(?:fastapi|django|flask|starlette|sanic|tornado|litestar)(?:\[[a-z0-9_, -]+\])?\s*(?:[<>=!~].*)?\s*$/i.test(line.split('#')[0])) ? ['backend'] : [];
  if (kind === 'go.mod') {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
    let requiring = false;
    for (const line of clean.split(/\r?\n/)) {
      if (/^\s*require\s*\(\s*$/.test(line)) { requiring = true; continue; }
      if (/^\s*\)\s*$/.test(line)) { requiring = false; continue; }
      const dependency = (requiring ? /^\s*(\S+)\s+v\S+\s*$/ : /^\s*require\s+(\S+)\s+v\S+\s*$/).exec(line)?.[1];
      if (dependency && /^(?:github\.com\/(?:gin-gonic\/gin|gofiber\/fiber(?:\/v\d+)?|labstack\/echo(?:\/v\d+)?|go-chi\/chi(?:\/v\d+)?))$/.test(dependency)) return ['backend'];
    }
  }
  if (kind === 'pom.xml') {
    let clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    if (/<!DOCTYPE|<!ENTITY/i.test(clean)) return [];
    for (const section of ['profiles', 'dependencyManagement', 'build', 'reporting']) {
      clean = clean.replace(new RegExp(`<${section}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${section}\\s*>`, 'g'), '');
      if (new RegExp(`<${section}(?:\\s|>)`).test(clean)) return [];
    }
    for (const match of clean.matchAll(/<dependency\s*>([\s\S]*?)<\/dependency\s*>/g)) {
      if (/<scope>\s*(?:test|import)\s*<\/scope>/.test(match[1])) continue;
      const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(match[1])?.[1];
      const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(match[1])?.[1];
      if ((group === 'org.springframework.boot' && ['spring-boot-starter-web', 'spring-boot-starter-webflux'].includes(artifact)) ||
        (group === 'io.quarkus' && ['quarkus-rest', 'quarkus-resteasy'].includes(artifact))) return ['backend'];
    }
  }
  return [];
}

/** Pure static extraction for a recognized, caller-supplied manifest; no source text is returned. */
export function parseStackManifest(file, text) {
  safeContextPath(file);
  const kind = format(file);
  if (!kind) return null;
  if (typeof text !== 'string') invalid();
  if (Buffer.byteLength(text, 'utf8') > LIMITS.bytes) fail('STACK_PROFILE_LIMIT', 'Превышен предел manifest стека');
  let ecosystem, frameworks, domainFacts, limitations = [];
  if (kind === 'package.json') { ecosystem = 'javascript'; frameworks = packageFacts(structured(text, 'json')); }
  else if (kind === 'pyproject.toml') { ecosystem = 'python'; frameworks = pythonFacts(structured(text, 'toml')); limitations = ['python-markers-and-optional-groups-not-evaluated']; }
  else if (kind === 'pubspec.yaml') { ecosystem = 'dart'; frameworks = flutterFacts(structured(text, 'yaml')); limitations = ['flutter-target-platforms-unknown']; }
  else if (kind.startsWith('build.gradle')) { ecosystem = 'jvm'; frameworks = gradleFacts(text); limitations = ['gradle-catalogs-and-conventions-not-resolved']; }
  else if (kind === 'Package.swift') { ecosystem = 'swift'; frameworks = swiftFacts(text); limitations = ['swift-package-is-not-an-ios-app']; }
  else if (kind === 'xcode-project') { ecosystem = 'swift-or-objective-c'; frameworks = xcodeFacts(text); limitations = ['xcode-conditional-targets-not-resolved']; }
  else if (LEGACY_NAMES.includes(kind)) {
    ecosystem = { 'requirements.txt': 'python', 'go.mod': 'go', 'pom.xml': 'jvm', 'composer.json': 'php', 'index.html': 'html' }[kind];
    frameworks = []; domainFacts = legacyDomains(kind, text); limitations = ['legacy-domain-only-no-framework-version-facts'];
  }
  else { ecosystem = 'dotnet'; frameworks = dotnetFacts(text); limitations = ['msbuild-imports-properties-and-conditions-not-resolved']; }
  const unique = new Map(frameworks.map((fact) => [hashObject(fact), fact]));
  frameworks = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id) || a.role.localeCompare(b.role) || hashObject(a).localeCompare(hashObject(b)));
  const domains = sorted((domainFacts ?? frameworks.map((fact) => fact.domain)).filter((domain) => domain !== 'engineering'));
  return { path: file, hash: sha256(text), scope: kind === 'xcode-project' ? path.posix.dirname(path.posix.dirname(file)) : path.posix.dirname(file),
    format: kind, ecosystem, domains: domains.length ? domains : ['engineering'], frameworks, limitations };
}

function canonicalRoot(root) {
  try {
    const stat = lstatHostSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CONTEXT_ROOT_UNSAFE', 'Ожидался обычный корень проекта');
    return realpathHostSync(root);
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail('CONTEXT_ROOT_UNSAFE', 'Корень проекта недоступен');
  }
}

function inspectScope(root, scope) {
  if (scope === '.') return '.';
  let current = root;
  const parts = scope.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = lstatHostSync(current); } catch (error) {
      if (error.code === 'ENOENT') return path.posix.dirname(scope);
      fail('CONTEXT_SCOPE_UNKNOWN', 'Scope недоступен');
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      fail('CONTEXT_LINK_UNSAFE', 'Scope содержит ссылку или неоднозначный путь');
    let physical;
    try { physical = realpathHostSync(current); } catch { fail('CONTEXT_SCOPE_UNKNOWN', 'Scope изменился во время discovery'); }
    if (!sameHostPath(physical, current)) fail('CONTEXT_LINK_UNSAFE', 'Scope содержит ссылку или неоднозначный путь');
    if (index === parts.length - 1) return stat.isDirectory() ? scope : path.posix.dirname(scope);
  }
}

/** Known ancestors, declared JavaScript workspaces and bounded relevant native/polyglot inventory. */
export function discoverStackProfile(root, { scope = ['.'], manifestPaths = [], manifestDiscovery = 1 } = {}) {
  if (![0, 1].includes(manifestDiscovery)) fail('STACK_PROFILE_INVALID', 'Неизвестная версия inventory stack profile');
  if (!Array.isArray(scope) || !scope.length || scope.length > LIMITS.scopes ||
    !Array.isArray(manifestPaths) || manifestPaths.length > LIMITS.manifests) fail('STACK_PROFILE_LIMIT', 'Некорректный объем scope или manifests');
  const scopes = sorted(scope.map((entry) => safeContextPath(typeof entry === 'string' ? entry.replace(/\/$/, '') : entry, true)));
  const declared = sorted(manifestPaths.map((file) => safeContextPath(file)));
  if ([...scopes, ...declared].some((file) => file.length > 4096 || file.split('/').length > 64))
    fail('STACK_PROFILE_LIMIT', 'Слишком длинный путь stack profile');
  const canonical = canonicalRoot(root), candidates = new Set(), evidence = [], packages = [];
  const add = (file) => {
    safeContextPath(file);
    if (!format(file) && file !== 'pnpm-workspace.yaml') return;
    candidates.add(file);
    if (candidates.size > LIMITS.probes) fail('STACK_PROFILE_LIMIT', 'Слишком много probes stack profile');
  };
  for (const file of declared) {
    const directory = /\.xcodeproj\/project\.pbxproj$/.test(file) ? path.posix.dirname(path.posix.dirname(file)) : path.posix.dirname(file);
    if (scopes.some((entry) => overlaps(entry, directory))) add(file);
  }
  for (const entry of scopes) {
    let directory = inspectScope(canonical, entry);
    for (;;) {
      for (const name of NAMES) add(directory === '.' ? name : `${directory}/${name}`);
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  const inventory = manifestDiscovery === 1 ? discoverScopedStackManifests(canonical, { scope: scopes }) : null;
  for (const file of inventory?.manifestPaths ?? []) add(file);
  add('pnpm-workspace.yaml');
  let bytes = 0;
  const read = (file) => {
    let loaded;
    try { loaded = readContextFile(canonical, file, { maxBytes: LIMITS.bytes, optional: !declared.includes(file) }); }
    catch (error) {
      if (error instanceof GraphError) throw error;
      fail('STACK_PROFILE_FILE', 'Не удалось прочитать manifest стека');
    }
    evidence.push({ path: file, format: format(file) ?? 'workspace', hash: loaded?.hash ?? null });
    if (!loaded) return null;
    bytes += Buffer.byteLength(loaded.text, 'utf8');
    if (bytes > LIMITS.totalBytes) fail('STACK_PROFILE_LIMIT', 'Превышен общий объем manifests стека');
    const pkg = parseStackManifest(file, loaded.text);
    if (pkg) packages.push(pkg);
    return loaded;
  };
  const rootPackage = candidates.has('package.json') ? read('package.json') : null;
  const workspace = read('pnpm-workspace.yaml');
  const rootData = rootPackage ? structured(rootPackage.text, 'json') : {};
  let workspaces;
  try { workspaces = discoverWorkspaceManifests(canonical, rootData, workspace ? 'pnpm' : 'npm'); }
  catch (error) {
    if (error instanceof GraphError) throw error;
    fail('STACK_PROFILE_FILE', 'Не удалось прочитать workspace inventory');
  }
  for (const file of workspaces) {
    safeContextPath(file);
    if (scopes.some((entry) => overlaps(entry, path.posix.dirname(file)))) add(file);
  }
  for (const original of [rootPackage, workspace]) {
    if (!original) continue;
    const current = readContextFile(canonical, original.path, { maxBytes: LIMITS.bytes });
    if (current.hash !== original.hash) fail('STACK_PROFILE_DRIFT', 'Workspace manifest изменился во время discovery');
  }
  for (const file of [...candidates].sort()) if (!['package.json', 'pnpm-workspace.yaml'].includes(file)) read(file);
  if (inventory && hashObject(discoverScopedStackManifests(canonical, { scope: scopes })) !== hashObject(inventory))
    fail('STACK_PROFILE_DRIFT', 'Inventory manifests изменился во время discovery');
  const relevant = packages.filter((pkg) => scopes.some((entry) => within(pkg.scope, entry) || (within(entry, pkg.scope) &&
    !packages.some((other) => other.scope !== pkg.scope && within(other.scope, pkg.scope) && overlaps(entry, other.scope)))));
  const domains = sorted(relevant.flatMap((pkg) => pkg.domains).filter((domain) => domain !== 'engineering'));
  const body = { version: 1, guidanceOnly: true, scope: scopes, manifestPaths: declared,
    ...(inventory ? { manifestDiscovery: 1 } : {}),
    evidence: evidence.sort((a, b) => a.path.localeCompare(b.path)), packages: relevant.sort((a, b) => a.path.localeCompare(b.path)),
    domains: domains.length ? domains : ['engineering'], limitations: inventory
      ? [...LIMITATIONS.filter((entry) => entry !== 'native-variable-manifests-require-explicit-paths'), ...inventory.limitations]
      : [...LIMITATIONS] };
  try { assertJsonBounds(body, 100000); } catch { fail('STACK_PROFILE_LIMIT', 'Stack profile превышает предел размера или вложенности'); }
  return { ...body, hash: hashObject(body) };
}

/** Changed, removed, newly appearing declarations or tampered metadata require a fresh policy plan. */
export function verifyStackProfile(root, profile) {
  try { assertJsonBounds(profile, 100000); } catch { fail('STACK_PROFILE_INVALID', 'Некорректный stack profile'); }
  if (!profile || profile.version !== 1 || profile.guidanceOnly !== true || typeof profile.hash !== 'string')
    fail('STACK_PROFILE_INVALID', 'Неизвестная версия stack profile');
  if (profile.manifestDiscovery !== undefined && profile.manifestDiscovery !== 1)
    fail('STACK_PROFILE_INVALID', 'Неизвестная версия inventory stack profile');
  const { hash, ...body } = profile;
  if (hashObject(body) !== hash) fail('STACK_PROFILE_DRIFT', 'Stack profile изменился');
  // Historical v1 profiles retain their original discovery policy and hashes.
  const current = discoverStackProfile(root, { scope: profile.scope, manifestPaths: profile.manifestPaths,
    manifestDiscovery: profile.manifestDiscovery ?? 0 });
  if (current.hash !== hash) fail('STACK_PROFILE_DRIFT', 'Manifest стека изменился; нужен новый plan');
  return current;
}
