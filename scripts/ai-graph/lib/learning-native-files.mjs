import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { lstatHostSync, fstatHostSync, crossStatIdentity, isTrustedMode, noFollowReadFlags } from './host-filesystem.mjs';
import { GraphError } from './io.mjs';

export function learningNativeFile(file, { maximum = 512 * 1024 * 1024, content = false } = {}) {
  const before = lstatHostSync(file, { bigint: true });
  // npm's native Claude package can have legitimate hardlinks. Pin bytes and
  // inode throughout the read instead of pretending nlink=1 proves provenance.
  if (!before.isFile() || before.isSymbolicLink() || !isTrustedMode(before) || before.size > BigInt(maximum))
    throw new GraphError('LEARNING_NATIVE_FILE_UNSAFE', 'Файл native adapter недоступен или небезопасен.');
  const fd = openSync(file, noFollowReadFlags()), hash = createHash('sha256'), chunks = [], buffer = Buffer.alloc(256 * 1024);
  try {
    if (crossStatIdentity(fstatHostSync(fd, { bigint: true })) !== crossStatIdentity(before))
      throw new GraphError('LEARNING_NATIVE_FILE_DRIFT', 'Файл native adapter заменен.');
    let size = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      size += count;
      if (size > maximum || size > Number(before.size)) throw new GraphError('LEARNING_NATIVE_FILE_DRIFT', 'Файл native adapter изменился.');
      hash.update(buffer.subarray(0, count));
      if (content) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (size !== Number(before.size) || crossStatIdentity(fstatHostSync(fd, { bigint: true })) !== crossStatIdentity(before)
      || crossStatIdentity(lstatHostSync(file, { bigint: true })) !== crossStatIdentity(before))
      throw new GraphError('LEARNING_NATIVE_FILE_DRIFT', 'Файл native adapter изменился.');
    return { hash: hash.digest('hex'), bytes: content ? Buffer.concat(chunks) : null };
  } finally { closeSync(fd); }
}
