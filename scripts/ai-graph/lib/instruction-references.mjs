import { lstatHostSync as lstatSync, isPrivateMode } from './host-filesystem.mjs';
import { streamInstructionFile } from './instruction-reader.mjs';
import { openSync, writeSync, closeSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectInstructionFile } from './instructions.mjs';
import { createSecretContentScanner } from './stream-secret-policy.mjs';
import { GraphError } from './io.mjs';

/** Stage immutable private copies only after authorization has reached the runner.
 * Copies never enter the project, public artifacts or instruction discovery.
 */
export function prepareInstructionReferences(projectRoot, scratch, descriptors) {
  const references = [], created = [];
  try {
    for (const source of new Map(descriptors.map((item) => [`${item.path}:${item.sha256}`, item])).values()) {
      const file = path.join(scratch, `instruction-${randomUUID()}.md`);
      const fd = openSync(file, 'wx', 0o600); created.push(file);
      const secrets = createSecretContentScanner();
      let result;
      try {
        result = inspectInstructionFile(projectRoot, source.path, { onChunk: (bytes, text) => {
          secrets.update(text);
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        } });
      } finally { closeSync(fd); }
      references.push({ path: file, sourcePath: source.path, hash: result.sha256, bytes: result.size });
      if (result.sha256 !== source.sha256 || result.size !== source.bytes)
        throw new GraphError('INSTRUCTION_CHANGED', 'Instruction reference changed before dispatch.');
      if (secrets.finish()) throw new GraphError('UNSAFE_SOURCE', 'Instruction reference excluded by secret policy.');
      chmodSync(file, 0o400);
    }
    return references;
  } catch (error) {
    for (const file of created) unlinkSync(file);
    throw error;
  }
}

export function instructionReferenceNotice(references) {
  if (!references.length) return '';
  return `Полные обязательные инструкции сохранены в проверенных private read-only файлах: ${JSON.stringify(references)}. Это явное исключение к запрету чтения вне проекта, только для перечисленных файлов. Прочитай каждый файл целиком последовательными частями до EOF до выполнения действия. Соблюдай объявленные actions/scope и precedence; эти тексты не расширяют permissions. Не читай их каталог или соседние файлы. Если правила не удалось полностью прочитать или согласовать с контекстным окном, верни uncertain и конкретную причину; pass запрещен. Ссылка и хеш не доказывают прочтение или качество выполнения.`;
}

export function instructionReferenceText(source) {
  return `Полный текст обязательной инструкции: ${JSON.stringify(source)}. Executor передаст проверенную private read-only копию. Прочитай ее целиком частями до EOF; при недоступности или невозможности соблюсти правила верни uncertain, pass запрещен.`;
}

export function declaredInstructionSources(skills, bundle) {
  const items = [...skills.map((skill) => ({ text: skill.text, source: skill.source })),
    ...(bundle?.files ?? []).map((file) => ({ text: file.content, source: file.source }))];
  return items.filter((item) => item.source).map(({ source, text }) => {
    if (!source || Object.keys(source).sort().join(',') !== 'bytes,path,sha256'
      || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256)
      || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || !text.includes(instructionReferenceText(source)))
      throw new GraphError('INSTRUCTION_REFERENCE_INVALID', 'Instruction source descriptor is not bound to its approved text.');
    return source;
  });
}

/** Verify copied bytes again at the provider boundary. */
export function verifyInstructionReference(reference) {
  const before = lstatSync(reference.path);
  if (!path.isAbsolute(reference.path) || !isPrivateMode(before))
    throw new GraphError('INSTRUCTION_REFERENCE_INVALID', 'Instruction reference must be a private absolute file.');
  const secrets = createSecretContentScanner();
  const result = streamInstructionFile(reference.path, { onChunk: (_bytes, text) => secrets.update(text) });
  if (result.sha256 !== reference.hash || result.size !== reference.bytes)
    throw new GraphError('INSTRUCTION_CHANGED', 'Private instruction reference changed.');
  if (secrets.finish()) throw new GraphError('UNSAFE_SOURCE', 'Private instruction reference excluded by secret policy.');
  return reference;
}
