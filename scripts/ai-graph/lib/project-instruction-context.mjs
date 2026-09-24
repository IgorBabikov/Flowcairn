import { assertSafeText } from './source-policy.mjs';
import { TextDecoder } from 'node:util';
import { GraphError, hashObject } from './io.mjs';
import { effectiveInstructionFiles, inspectInstructions, readInstructionFile } from './instructions.mjs';
import { contextPathAllowed } from './registry.mjs';

const MAX_INSTRUCTION_BUNDLE_BYTES = 64 * 1024;
const fail = (code, message) => { throw new GraphError(code, message); };
const metadata = ({ path, kind, scope, sha256, bytes }) => ({ path, kind, scope, sha256, bytes });

/** Explicit Markdown context supplements discovered instructions; references are never followed. */
export function projectInstructionMetadata(root, node, task, profile, inspection = inspectInstructions({ projectRoot: root })) {
  if (!inspection.complete) fail('INSTRUCTION_INCOMPLETE', 'Discovery инструкций неполное');
  const scope = node.resources.writes.length ? node.resources.writes : task.scope;
  const known = new Set(inspection.files.map((file) => file.path));
  const selected = effectiveInstructionFiles(inspection, { provider: profile.ai.provider, scope })
    .filter((file) => node.resources.reads.includes(file.path)).map(metadata);
  for (const file of new Set([...(profile.contextPaths ?? []), ...(task.contextPaths ?? [])])) {
    if (known.has(file) || !/\.md$/i.test(file) || !node.resources.reads.includes(file)) continue;
    if (!contextPathAllowed(file, task)) fail('INSTRUCTION_CONTEXT_SCOPE', 'Контекст инструкций выходит за область задачи');
    const data = readInstructionFile(root, file);
    selected.push({ path: file, kind: 'explicit-context', scope: '.', sha256: data.sha256, bytes: data.bytes.length });
  }
  return selected.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read original bytes after permission checks; never copy ignored instructions into source worktrees. */
export function buildProjectInstructionContext({ projectRoot, node, task, profile, expectedMetadata = [] }) {
  const inspection = inspectInstructions({ projectRoot });
  const selected = projectInstructionMetadata(projectRoot, node, task, profile, inspection);
  if (hashObject(selected) !== hashObject(expectedMetadata.map(metadata).sort((a, b) => a.path.localeCompare(b.path))))
    fail('INSTRUCTION_CHANGED', 'Инструкции не совпадают с контекстом одобренного действия');
  let bytes = 0;
  const files = selected.map((file) => {
    if (!contextPathAllowed(file.path, task)) fail('INSTRUCTION_CONTEXT_SCOPE', 'Путь инструкции не входит в разрешенный контекст');
    const data = readInstructionFile(projectRoot, file.path);
    if (data.sha256 !== file.sha256 || data.bytes.length !== file.bytes)
      fail('INSTRUCTION_CHANGED', 'Байты инструкции изменились перед передачей');
    if ((bytes += data.bytes.length) > MAX_INSTRUCTION_BUNDLE_BYTES)
      fail('INSTRUCTION_CONTEXT_LIMIT', 'Инструкции текущего действия превышают 64 KiB; требуется сузить контекст');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes); }
    catch { fail('INSTRUCTION_ENCODING', 'Инструкция не является UTF-8 текстом'); }
    if (content.includes('\0')) fail('INSTRUCTION_ENCODING', 'Инструкция содержит бинарные данные');
    assertSafeText(content);
    return { ...file, content };
  });
  const effective = new Set(effectiveInstructionFiles(inspection, { provider: profile.ai.provider }).map((file) => file.path));
  const explicitTargets = new Set([...task.scope, ...node.resources.writes]);
  const dataPaths = inspection.files.filter((file) => !effective.has(file.path) && explicitTargets.has(file.path) && node.resources.reads.includes(file.path)).map((file) => file.path);
  return { version: 1, files, bytes, dataPaths, hash: hashObject({ version: 1, files: selected, dataPaths }) };
}
