import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GraphError, sha256 } from './io.mjs';

function readRegular(root, relative) {
  const file = path.join(root, relative);
  for (let cursor = path.dirname(file); cursor !== root; cursor = path.dirname(cursor)) {
    if (!cursor.startsWith(root + path.sep) || lstatSync(cursor).isSymbolicLink())
      throw new GraphError('BOOTSTRAP_UNSAFE', 'Bootstrap ownership path содержит ссылку');
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new GraphError('BOOTSTRAP_UNSAFE', 'Bootstrap ownership требует обычный ограниченный файл');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** One ownership rule shared by snapshot preview and actual registration. */
export function ownedBootstrapFiles(root) {
  let installation;
  try { installation = JSON.parse(readRegular(root, '.ai-orchestrator/flowcairn-install.json').toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (installation.tool !== 'flowcairn') throw new GraphError('INSTALL_CONFLICT', 'Bootstrap receipt принадлежит другому инструменту');
  const result = [];
  for (const [file, expected] of [['.flowcairn.json', installation.profileHash]]) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) continue;
    let bytes;
    try { bytes = readRegular(root, file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const hash = sha256(bytes);
    if (hash === expected) result.push({ path: file, hash });
  }
  return result;
}
