import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isPrivateMode, noFollowReadFlags } from './host-filesystem.mjs';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { fingerprintDirectWorkspace } from './direct-workspace.mjs';

const fail = (code, reason) => { throw new GraphError(code, reason); };

function privateDirectory(root, relative) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isPrivateMode(stat))
      fail('DIRECT_STORAGE', 'Локальное хранилище должно быть закрытым каталогом');
  }
  return current;
}

export function verifyDirectSource(file) {
  let fd;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('DIRECT_SOURCE', 'Снимок исходников поврежден');
    fd = openSync(file, noFollowReadFlags());
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1 || !isPrivateMode(stat) || stat.size > 4 * 1024 * 1024)
      fail('DIRECT_SOURCE', 'Снимок исходников поврежден');
    const bytes = readFileSync(fd), record = JSON.parse(bytes.toString('utf8'));
    if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.sourceHash ?? '') ||
      !Array.isArray(record.files) || record.files.length > 20_000 ||
      sha256(canonicalJson({ files: record.files, git: record.git })) !== record.sourceHash ||
      path.basename(file) !== `${record.sourceHash}.json`)
      fail('DIRECT_SOURCE', 'Снимок исходников не соответствует контрольной сумме');
    return record.sourceHash;
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail('DIRECT_SOURCE', 'Снимок исходников недоступен');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Immutable descriptors only; project source bytes never enter control storage. */
export function captureDirectSource(root, profile, worktree = root) {
  const fingerprint = fingerprintDirectWorkspace(worktree, { outputPaths: profile.outputPaths });
  const directory = privateDirectory(root, '.ai-orchestrator/graph/direct-sources');
  const bundlePath = path.join(directory, `${fingerprint.hash}.json`);
  const record = { version: 1, sourceHash: fingerprint.hash, files: fingerprint.files, git: fingerprint.git };
  try { writeFileSync(bundlePath, `${canonicalJson(record)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (verifyDirectSource(bundlePath) !== fingerprint.hash) fail('DIRECT_SOURCE', 'Снимок не совпадает с текущим проектом');
  return { bundlePath, manifest: { sourceHash: fingerprint.hash } };
}
