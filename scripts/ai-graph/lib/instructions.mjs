import { lstatHostSync as lstatSync } from './host-filesystem.mjs';
import { opendirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, hashObject } from './io.mjs';
import { streamInstructionFile, collectInstructionFile } from './instruction-reader.mjs';
import { CORE_SKILL_ROUTES, DOMAIN_SKILLS } from './config.mjs';

// Локальный учет файлов не расширяет отдельный лимит AI-контекста действия.
export const INSTRUCTION_LIMITS = Object.freeze({ maxDepth: null, maxEntries: null, maxFiles: null, maxFileBytes: null, maxTotalBytes: null });
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
  if (typeof relative !== 'string' || (relative.includes('\\') || [...relative].some((character) => character.charCodeAt(0) < 32)) || path.isAbsolute(relative)) instructionError('INSTRUCTION_UNSAFE_PATH', 'Invalid project-relative instruction path.');
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
function checkedInstructionTarget(root, relative) {
  if (relative.split('/').some((part) => sensitive(part) || ['.git', '.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519'].includes(part))) instructionError('INSTRUCTION_SENSITIVE_PATH', 'Sensitive files are not instruction input.');
  return instructionPath(root, relative);
}
export function inspectInstructionFile(root, relative, options = {}) {
  return streamInstructionFile(checkedInstructionTarget(root, relative), {
    ...options, currentPath: () => checkedInstructionTarget(root, relative),
  });
}
export function readInstructionFile(root, relative, maxBytes = undefined) {
  return collectInstructionFile(checkedInstructionTarget(root, relative), {
    maxBytes, currentPath: () => checkedInstructionTarget(root, relative),
  });
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
export function inspectInstructions({ projectRoot, limits = {}, signal = undefined }) {
  const root = canonicalInstructionRoot(projectRoot);
  const cap = { ...INSTRUCTION_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in cap) || !Number.isSafeInteger(value) || value < 1) instructionError('INSTRUCTION_LIMIT', 'Explicit scan budgets must be positive safe integers.');
    cap[key] = value;
  }
  const files = [], issues = [], pending = [{ relative: '', depth: 0 }];
  let entries = 0, bytes = 0, stopped = false;
  const issue = (code, file, severity = 'warning') => issues.push({ code, path: file, severity });
  const over = (key, value) => cap[key] !== null && value > cap[key];
  while (pending.length && !stopped) {
    const { relative, depth } = pending.pop();
    if (signal?.aborted) { issue('INSTRUCTION_CANCELLED', relative, 'error'); break; }
    if (over('maxDepth', depth)) { issue('DEPTH_LIMIT', relative, 'error'); continue; }
    let dir;
    try {
      const actual = relative ? path.dirname(instructionPath(root, `${relative}/placeholder`)) : root;
      const before = lstatSync(actual);
      if (!before.isDirectory() || before.isSymbolicLink()) instructionError('DIRECTORY_UNSAFE', 'Instruction directory must be regular.');
      dir = opendirSync(actual);
      let entry;
      while (!stopped && (entry = dir.readSync())) {
        if (signal?.aborted) { issue('INSTRUCTION_CANCELLED', relative, 'error'); stopped = true; break; }
        if (over('maxEntries', ++entries)) { issue('ENTRY_LIMIT', relative, 'error'); stopped = true; break; }
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        const kind = kindOf(file);
        if (sensitive(entry.name) || SKIP.has(entry.name)) continue;
        if (entry.isSymbolicLink()) { if (kind || HIDDEN.has(entry.name)) issue('LINK_SKIPPED', file, 'error'); continue; }
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') && !HIDDEN.has(entry.name) && entry.name !== '.skills') continue;
          pending.push({ relative: file, depth: depth + 1 });
          continue;
        }
        if (!kind) continue;
        if (over('maxFiles', files.length + 1)) { issue('FILE_LIMIT', file, 'error'); stopped = true; break; }
        try {
          const remaining = cap.maxTotalBytes === null ? undefined : cap.maxTotalBytes - bytes;
          const maxBytes = cap.maxFileBytes === null ? remaining : remaining === undefined ? cap.maxFileBytes : Math.min(cap.maxFileBytes, remaining);
          const data = inspectInstructionFile(root, file, { maxBytes, signal });
          bytes += data.size;
          files.push({ path: file, kind, sha256: data.sha256, bytes: data.size, scope: scopeOf(file, kind), scopeResolution: ['agents', 'agent-custom', 'claude', 'cursor-legacy'].includes(kind) ? 'directory' : 'client-defined', applicability: kind === 'agent-custom' ? 'explicit-context-only; native activation not verified' : 'client-defined; not evaluated' });
          if (data.managedMarker) issue('MANAGED_MARKER_PRESENT', file, 'info');
        } catch (error) { issue(error.code || 'INSTRUCTION_UNREADABLE', file, 'error'); if (signal?.aborted) stopped = true; }
      }
      const after = lstatSync(actual);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        issue('DIRECTORY_CHANGED', relative, 'error');
    } catch (error) { issue(error.code?.startsWith('INSTRUCTION_') ? error.code : 'DIRECTORY_UNREADABLE', relative, 'error'); }
    finally { if (dir) dir.closeSync(); }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const paths = new Set(files.map((file) => file.path));
  for (const file of files.filter((item) => item.path.endsWith('AGENTS.override.md'))) {
    if (paths.has(file.path.replace('AGENTS.override.md', 'AGENTS.md'))) issue('AGENTS_SHADOWED_BY_OVERRIDE', file.path, 'warning');
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
function requireCompleteInstructionManifest(manifest) {
  if (manifest?.complete === true && Array.isArray(manifest.files)) return;
  const issues = (manifest?.audit?.issues ?? []).filter((item) => item.severity === 'error');
  const detail = issues.slice(0, 8).map((item) => `${item.code}: ${JSON.stringify(item.path)}`).join('; ');
  instructionError('INSTRUCTION_INCOMPLETE', `Не удалось полностью проверить инструкции.${detail ? ` ${detail}` : ' Полный список инструкций отсутствует.'}`);
}

export function readInstructionBundle({ projectRoot, expectedFingerprint, paths }) {
  const root = canonicalInstructionRoot(projectRoot);
  const before = inspectInstructions({ projectRoot: root });
  requireCompleteInstructionManifest(before);
  if (before.fingerprint !== expectedFingerprint) instructionError('INSTRUCTION_CHANGED', 'Approved instruction fingerprint changed.');
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length) instructionError('INSTRUCTION_PATHS', 'Explicit unique instruction paths are required.');
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
  requireCompleteInstructionManifest(instructionManifest);
  const root = canonicalInstructionRoot(projectRoot);
  const current = inspectInstructions({ projectRoot: root });
  requireCompleteInstructionManifest(current);
  if (current.fingerprint !== instructionManifest.fingerprint) instructionError('INSTRUCTION_CHANGED', 'Instruction inventory changed before assessment.');
  const findings = [];
  const add = (code, file, message) => findings.push({ code, path: file.path, severity: 'suggestion', message });
  for (const file of current.files) {
    const data = inspectInstructionFile(root, file.path, { collectFrontmatter: file.kind === 'project-skill' });
    if (data.sha256 !== file.sha256) instructionError('INSTRUCTION_CHANGED', 'Instruction changed during assessment.');
    if (!data.nonempty) add('EMPTY_INSTRUCTION', file, 'Файл пуст. Предлагаем добавить правила проекта или подключить базовые skills flowcairn.');
    if (file.kind === 'project-skill') {
      const header = data.frontmatter;
      if (!header) add('SKILL_METADATA_MISSING', file, 'Не найден заголовок Skill. Проверьте name и description перед подключением.');
      else if (!data.bodyNonempty) add('SKILL_BODY_MISSING', file, 'В Skill есть описание, но нет рабочих инструкций. Предлагаем дополнить его перед подключением.');
    }
    if (file.bytes > 12 * 1024) add('INSTRUCTION_CONTEXT_COST', file, 'Большой файл увеличивает контекст. Предлагаем оставить основные правила и вынести детали в отдельные материалы.');
    if (file.kind === 'agent-custom') add('CUSTOM_AGENT_FILENAME', file, 'AGENT.md сохранен как контекст проекта. Его автоматическое чтение AI-клиентом не подтверждено.');
  }
  for (const issue of instructionManifest.audit?.issues ?? []) {
    if (issue.code === 'AGENTS_SHADOWED_BY_OVERRIDE')
      add(issue.code, { path: issue.path }, 'AGENTS.override.md перекрывает соседний AGENTS.md в Codex. Проверьте, что нужные правила доступны в действующем файле.');
  }
  const after = inspectInstructions({ projectRoot: root });
  requireCompleteInstructionManifest(after);
  if (after.fingerprint !== current.fingerprint) instructionError('INSTRUCTION_CHANGED', 'Instruction inventory changed during assessment.');
  return {
    version: 1, instructionFingerprint: current.fingerprint, quality: 'not-certified', semanticConflicts: 'not-assessed',
    recommendation: current.files.length ? 'preserve-and-supplement' : 'activate-bundled', findings,
    explanation: 'Сохраняем выбранные правила владельца. Проверка структуры не доказывает качество; смысловые противоречия требуют разбора и решения до автономной работы.',
    bundledSkills: { source: 'flowcairn-package', requiresActivation: true, copiesProjectFiles: false,
      actions: CORE_SKILL_ROUTES, domains: DOMAIN_SKILLS,
      explanation: 'Базовые skills установлены вместе с пакетом. Подключение использует оригиналы с хешами: правила проекта имеют приоритет, предметные рекомендации выбираются по области задачи.' },
  };
}
