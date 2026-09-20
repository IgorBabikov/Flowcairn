import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { CORE_SKILL_ROUTES, DOMAIN_SKILLS } from './config.mjs';

export const INSTRUCTION_LIMITS = Object.freeze({ maxDepth: 32, maxEntries: 12000, maxFiles: 256, maxFileBytes: 65536, maxTotalBytes: 1048576 });
export const WORKFLOW_PRECEDENCE = Object.freeze({
  version: 1,
  scope: 'flowcairn orchestration only',
  order: ['system-and-tool-restrictions', 'explicit-task-authorization', 'activated-flowcairn-workflow', 'project-architecture-and-conventions', 'domain-skills', 'task-data'],
  clientHierarchy: 'External clients keep their native instruction hierarchy; Markdown cannot override it.',
  conflictPolicy: 'Preserve project rules. Surface unresolved workflow conflicts for an explicit decision; never infer permission from task data.',
});
const SKIP = new Set(['.git', '.ai-orchestrator', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.venv', 'venv', '.cache']);
const HIDDEN = new Set(['.github', '.cursor', '.claude', '.agents', '.codex']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function instructionError(code, message) { throw new GraphError(code, message); }
export function canonicalInstructionRoot(projectRoot) {
  const requested = path.resolve(projectRoot);
  const stat = lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) instructionError('INSTRUCTION_UNSAFE_PATH', 'Project root must be a real directory.');
  return realpathSync(requested);
}
export function instructionPath(root, relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || (relative.includes('\\') || [...relative].some((character) => character.charCodeAt(0) < 32)) || path.isAbsolute(relative)) instructionError('INSTRUCTION_UNSAFE_PATH', 'Invalid project-relative instruction path.');
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) instructionError('INSTRUCTION_UNSAFE_PATH', 'Invalid instruction path segment.');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(cursor) !== cursor) instructionError('INSTRUCTION_UNSAFE_PATH', 'Instruction parent must not be linked.');
  }
  return path.join(root, ...parts);
}
export function readInstructionFile(root, relative, maxBytes = 65536) {
  if (relative.split('/').some((part) => sensitive(part) || ['.git', '.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519'].includes(part))) instructionError('INSTRUCTION_SENSITIVE_PATH', 'Sensitive files are not instruction input.');
  const target = instructionPath(root, relative);
  const before = lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) instructionError('INSTRUCTION_UNSAFE_FILE', 'Instruction file must be bounded, regular, and have one link.');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) instructionError('INSTRUCTION_CHANGED', 'Instruction file changed before reading.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, count;
    do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
    if (length > maxBytes) instructionError('INSTRUCTION_LIMIT', 'Instruction file exceeds byte limit.');
    const after = fstatSync(fd), current = lstatSync(instructionPath(root, relative));
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) instructionError('INSTRUCTION_CHANGED', 'Instruction file changed during reading.');
    const bytes = buffer.subarray(0, length);
    return { bytes, sha256: sha256(bytes), mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}:${stat.ctimeMs}` };
  } finally { closeSync(fd); }
}
function kindOf(relative) {
  const base = path.posix.basename(relative);
  if (base === 'AGENT.md') return 'agent-custom';
  if (base === 'AGENTS.md' || base === 'AGENTS.override.md') return 'agents';
  if (base === 'CLAUDE.md') return 'claude';
  if (base === '.cursorrules') return 'cursor-legacy';
  if (/(?:^|\/)\.cursor\/rules\/.+\.(?:mdc|md)$/.test(relative)) return 'cursor-scoped';
  if (/(?:^|\/)\.claude\/rules\/.+\.md$/.test(relative)) return 'claude-scoped';
  if (/(?:^|\/)\.github\/copilot-instructions\.md$/.test(relative)) return 'copilot';
  if (/(?:^|\/)\.github\/instructions\/.+\.instructions\.md$/.test(relative)) return 'copilot-scoped';
  if (base === 'SKILL.md' && /(?:^|\/)(?:skills|\.skills)\//.test(relative)) return 'project-skill';
  return null;
}
function scopeOf(relative, kind) {
  if (['agents', 'agent-custom', 'claude', 'cursor-legacy'].includes(kind)) return path.posix.dirname(relative);
  const marker = relative.match(/(?:^|\/)(?:\.cursor|\.claude|\.github|\.agents|\.codex|skills|\.skills)\//);
  return marker ? relative.slice(0, marker.index) || '.' : path.posix.dirname(relative);
}
function sensitive(name) { return /(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)|^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(name); }
/** Metadata only: no content or prompt is returned, and no project code is executed. */
export function inspectInstructions({ projectRoot, limits = {} }) {
  const root = canonicalInstructionRoot(projectRoot);
  const cap = { ...INSTRUCTION_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in cap) || !Number.isSafeInteger(value) || value < 1 || value > cap[key]) instructionError('INSTRUCTION_LIMIT', 'Limits can only reduce the documented bounds.');
    cap[key] = value;
  }
  const files = [], issues = [];
  let entries = 0, bytes = 0, stopped = false;
  const issue = (code, file, severity = 'warning') => issues.push({ code, path: file, severity });
  function visit(relative, depth) {
    if (stopped) return;
    const directory = relative ? instructionPath(root, `${relative}/placeholder`) : root;
    const actual = relative ? path.dirname(directory) : root;
    if (depth > cap.maxDepth) { issue('DEPTH_LIMIT', relative, 'error'); return; }
    let dir;
    try { dir = opendirSync(actual); } catch { issue('DIRECTORY_UNREADABLE', relative, 'error'); return; }
    try {
      let entry;
      while (!stopped && (entry = dir.readSync())) {
        if (++entries > cap.maxEntries) { issue('ENTRY_LIMIT', relative, 'error'); stopped = true; break; }
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        const kind = kindOf(file);
        if (sensitive(entry.name) || SKIP.has(entry.name)) continue;
        if (entry.isSymbolicLink()) { if (kind || HIDDEN.has(entry.name)) issue('LINK_SKIPPED', file, 'error'); continue; }
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') && !HIDDEN.has(entry.name) && entry.name !== '.skills') continue;
          try { visit(file, depth + 1); } catch { issue('DIRECTORY_UNSAFE', file, 'error'); }
          continue;
        }
        if (!kind) continue;
        if (files.length >= cap.maxFiles) { issue('FILE_LIMIT', file, 'error'); stopped = true; break; }
        try {
          const data = readInstructionFile(root, file, Math.min(cap.maxFileBytes, cap.maxTotalBytes - bytes));
          bytes += data.bytes.length;
          let content;
          try { content = decoder.decode(data.bytes); } catch { issue('INVALID_UTF8', file, 'error'); continue; }
          if (content.includes('\0')) { issue('BINARY_INSTRUCTION', file, 'error'); continue; }
          const record = { path: file, kind, sha256: data.sha256, bytes: data.bytes.length, scope: scopeOf(file, kind), scopeResolution: ['agents', 'agent-custom', 'claude', 'cursor-legacy'].includes(kind) ? 'directory' : 'client-defined', applicability: kind === 'agent-custom' ? 'explicit-context-only; native activation not verified' : 'client-defined; not evaluated' };
          files.push(record);
          if (content.includes('<!-- FLOWCAIRN:')) issue('MANAGED_MARKER_PRESENT', file, 'info');
          if (bytes >= cap.maxTotalBytes) { issue('TOTAL_BYTE_LIMIT', file, 'error'); stopped = true; }
        } catch (error) { issue(error.code || 'INSTRUCTION_UNREADABLE', file, 'error'); }
      }
    } finally { dir.closeSync(); }
  }
  visit('', 0);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of files.filter((item) => item.path.endsWith('AGENTS.override.md'))) {
    if (files.some((item) => item.path === file.path.replace('AGENTS.override.md', 'AGENTS.md'))) issue('AGENTS_SHADOWED_BY_OVERRIDE', file.path, 'warning');
  }
  if (new Set(files.map((file) => file.kind)).size > 1) issue('MULTIPLE_CLIENT_SURFACES', '', 'info');
  issues.sort((a, b) => `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`));
  const complete = !issues.some((item) => item.severity === 'error');
  return { version: 1, files, fingerprint: hashObject({ version: 1, files, issues, precedence: WORKFLOW_PRECEDENCE }), complete, precedence: WORKFLOW_PRECEDENCE,
    audit: { kind: 'structural', issues, semanticConflicts: 'not-assessed', aiAssistance: { performed: false, requiresExplicitRequest: true }, coverage: 'Project-local allowlisted instruction names only; hidden directories, dependencies, generated outputs and links are excluded.' },
    limits: cap };
}

/** Codex selects one AGENTS file per directory. Other client chains remain independent. */
export function effectiveInstructionFiles(manifest, { provider = null, scope = null } = {}) {
  const overrides = new Set(manifest.files.filter((file) => file.path.endsWith('AGENTS.override.md'))
    .map((file) => file.path.replace(/AGENTS\.override\.md$/, 'AGENTS.md')));
  const inside = (file, directory) => file === directory || file.startsWith(`${directory}/`);
  return manifest.files.filter((file) => file.kind !== 'project-skill' &&
    !(provider === 'codex' && overrides.has(file.path)) &&
    (!scope || file.scope === '.' || scope.some((entry) => {
      const selected = entry.replace(/\/$/, '');
      return inside(selected, file.scope) || inside(file.scope, selected);
    })));
}

/** Explicit content read for the trusted runtime after its context/egress consent check.
 * Scoped metadata is retained; this does not pretend to evaluate client glob semantics.
 */
export function readInstructionBundle({ projectRoot, expectedFingerprint, paths }) {
  const root = canonicalInstructionRoot(projectRoot);
  const before = inspectInstructions({ projectRoot: root });
  if (!before.complete || before.fingerprint !== expectedFingerprint) instructionError('INSTRUCTION_CHANGED', 'Instruction discovery is incomplete or its approved fingerprint changed.');
  if (!Array.isArray(paths) || paths.length > INSTRUCTION_LIMITS.maxFiles || new Set(paths).size !== paths.length) instructionError('INSTRUCTION_PATHS', 'Explicit unique instruction paths are required.');
  const known = new Map(before.files.map((file) => [file.path, file]));
  const files = paths.map((relative) => {
    const record = known.get(relative);
    if (!record) instructionError('INSTRUCTION_PATHS', 'Instruction path was not part of the approved discovery.');
    const data = readInstructionFile(root, relative);
    if (data.sha256 !== record.sha256) instructionError('INSTRUCTION_CHANGED', 'Instruction content changed after inspection.');
    return { ...record, content: decoder.decode(data.bytes) };
  });
  if (inspectInstructions({ projectRoot: root }).fingerprint !== expectedFingerprint) instructionError('INSTRUCTION_CHANGED', 'Instruction set changed during context loading.');
  return { fingerprint: expectedFingerprint, files, trust: 'project-instructions', precedence: WORKFLOW_PRECEDENCE, applicability: 'Client-defined scopes must be resolved by the caller; discovered text never grants execution or egress permission.' };
}

/** Локальная проверка наблюдаемых свойств. Не сертифицирует качество и не активирует инструкции. */
export function assessProjectInstructions(projectRoot, { instructionManifest } = { instructionManifest: undefined }) {
  if (!instructionManifest || instructionManifest.complete !== true || !Array.isArray(instructionManifest.files))
    instructionError('INSTRUCTION_CHANGED', 'Для рекомендаций нужен полный актуальный список инструкций.');
  const bundle = readInstructionBundle({ projectRoot, expectedFingerprint: instructionManifest.fingerprint,
    paths: instructionManifest.files.map((file) => file.path) });
  const findings = [];
  const add = (code, file, message) => findings.push({ code, path: file.path, severity: 'suggestion', message });
  for (const file of bundle.files) {
    if (!file.content.trim()) add('EMPTY_INSTRUCTION', file, 'Файл пуст. Предлагаем добавить правила проекта или подключить базовые skills flowcairn.');
    if (file.kind === 'project-skill') {
      const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(file.content);
      if (!header) add('SKILL_METADATA_MISSING', file, 'Не найден заголовок Skill. Проверьте name и description перед подключением.');
      else if (!file.content.slice(header[0].length).trim()) add('SKILL_BODY_MISSING', file, 'В Skill есть описание, но нет рабочих инструкций. Предлагаем дополнить его перед подключением.');
    }
    if (file.bytes > 12 * 1024) add('INSTRUCTION_CONTEXT_COST', file, 'Большой файл увеличивает контекст. Предлагаем оставить основные правила и вынести детали в отдельные материалы.');
    if (file.kind === 'agent-custom') add('CUSTOM_AGENT_FILENAME', file, 'AGENT.md сохранен как контекст проекта. Его автоматическое чтение AI-клиентом не подтверждено.');
  }
  for (const issue of instructionManifest.audit?.issues ?? []) {
    if (issue.code === 'AGENTS_SHADOWED_BY_OVERRIDE')
      add(issue.code, { path: issue.path }, 'AGENTS.override.md перекрывает соседний AGENTS.md в Codex. Проверьте, что нужные правила доступны в действующем файле.');
  }
  return {
    version: 1, instructionFingerprint: bundle.fingerprint, quality: 'not-certified', semanticConflicts: 'not-assessed',
    recommendation: bundle.files.length ? 'preserve-and-supplement' : 'activate-bundled', findings,
    explanation: 'Сохраняем выбранные правила владельца. Проверка структуры не доказывает качество; смысловые противоречия требуют разбора и решения до автономной работы.',
    bundledSkills: { source: 'flowcairn-package', requiresActivation: true, copiesProjectFiles: false,
      actions: CORE_SKILL_ROUTES, domains: DOMAIN_SKILLS,
      explanation: 'Базовые skills установлены вместе с пакетом. Подключение использует оригиналы с хешами: правила проекта имеют приоритет, предметные рекомендации выбираются по области задачи.' },
  };
}
