import path from 'node:path';
import { opendirSync, realpathSync } from 'node:fs';
import { GraphError, hashObject } from './io.mjs';
import { RelativePath } from './schemas.mjs';
import { lstatHostSync, crossStatIdentity, sameHostPath } from './host-filesystem.mjs';
import { scanSourceFile } from './source-file-scan.mjs';

export const XCTEST_TREE_ALGORITHM = 'sha256-tree-v1';
const MAX_FILES = 20000;
const MAX_ENTRIES = 30000;
const MAX_DEPTH = 64;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const fail = (code) => { throw new GraphError(code, 'Registered native iOS artifact is missing, unsafe or changed.'); };
const inside = (file, scope) => file === scope || file.startsWith(`${scope}/`);

/** The owner registration fixes both names under one run directory. The report can only identify that run. */
export function boundXCTestMaterialPaths(definition, resultPath, applicationPath) {
  const spec = definition?.report?.xctest;
  if (!spec || spec.algorithm !== XCTEST_TREE_ALGORITHM) fail('XCTEST_ARTIFACT_REGISTRATION');
  RelativePath.parse(resultPath); RelativePath.parse(applicationPath);
  const root = spec.artifactRoot;
  if (!definition.outputPaths?.some(output => inside(root, output))) fail('XCTEST_ARTIFACT_SCOPE');
  const prefix = `${root}/`, suffix = `/${spec.resultName}`;
  if (!resultPath.startsWith(prefix) || !resultPath.endsWith(suffix)) fail('XCTEST_ARTIFACT_SCOPE');
  const run = resultPath.slice(prefix.length, -suffix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run) ||
      applicationPath !== `${root}/${run}/${spec.applicationRelativePath}`)
    fail('XCTEST_ARTIFACT_SCOPE');
  return { resultPath, applicationPath };
}

/** Exact producer tree format: SHA-256 of canonical JSON relative-file -> SHA-256 bytes. */
export function hashRegisteredXCTestTree(root, definition, artifactPath) {
  const spec = definition?.report?.xctest;
  if (spec?.algorithm !== XCTEST_TREE_ALGORITHM || !definition.outputPaths?.some(output => inside(artifactPath, output)))
    fail('XCTEST_ARTIFACT_SCOPE');
  RelativePath.parse(artifactPath);
  const base = realpathSync(root);
  let current = base;
  const ancestors = [];
  for (const part of artifactPath.split('/')) {
    const stat = lstatHostSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameHostPath(realpathSync(current), current)) fail('XCTEST_ARTIFACT_UNSAFE');
    ancestors.push({ path: current, identity: crossStatIdentity(stat) });
    current = path.join(current, part);
  }
  const files = Object.create(null);
  const directories = [], scannedFiles = [];
  let count = 0, entries = 0, totalBytes = 0;
  function namesIn(directory, countEntries) {
    const names = [], dir = opendirSync(directory);
    try {
      let item;
      while ((item = dir.readSync())) {
        if (names.push(item.name) > MAX_ENTRIES || countEntries && ++entries > MAX_ENTRIES)
          fail('XCTEST_ARTIFACT_LIMIT');
      }
    } finally { dir.closeSync(); }
    return names.sort();
  }
  function walk(directory, relative, depth) {
    if (depth > MAX_DEPTH) fail('XCTEST_ARTIFACT_LIMIT');
    const before = lstatHostSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !sameHostPath(realpathSync(directory), directory))
      fail('XCTEST_ARTIFACT_UNSAFE');
    const names = namesIn(directory, true);
    directories.push({ path: directory, identity: crossStatIdentity(before), names });
    for (const name of names) {
      const item = path.join(directory, name), rel = relative ? `${relative}/${name}` : name;
      const stat = lstatHostSync(item, { bigint: true });
      if (stat.isSymbolicLink()) fail('XCTEST_ARTIFACT_UNSAFE');
      if (stat.isDirectory()) walk(item, rel, depth + 1);
      else if (stat.isFile()) {
        if (++count > MAX_FILES || stat.size > BigInt(MAX_FILE_BYTES) ||
            (totalBytes += Number(stat.size)) > MAX_TOTAL_BYTES) fail('XCTEST_ARTIFACT_LIMIT');
        files[rel] = scanSourceFile(item, { expected: stat, classify: false }).hash;
        scannedFiles.push({ path: item, identity: crossStatIdentity(stat) });
      } else fail('XCTEST_ARTIFACT_UNSAFE');
    }
    const after = lstatHostSync(directory, { bigint: true });
    if (crossStatIdentity(before) !== crossStatIdentity(after) ||
        !sameHostPath(realpathSync(directory), directory) ||
        JSON.stringify(names) !== JSON.stringify(namesIn(directory, false))) fail('XCTEST_ARTIFACT_CHANGED');
  }
  walk(current, '', 0);
  if (!count) fail('XCTEST_ARTIFACT_EMPTY');
  for (const file of scannedFiles) {
    const stat = lstatHostSync(file.path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || crossStatIdentity(stat) !== file.identity ||
        !sameHostPath(realpathSync(file.path), file.path)) fail('XCTEST_ARTIFACT_CHANGED');
  }
  for (const directory of directories) {
    const stat = lstatHostSync(directory.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || crossStatIdentity(stat) !== directory.identity ||
        !sameHostPath(realpathSync(directory.path), directory.path) ||
        JSON.stringify(directory.names) !== JSON.stringify(namesIn(directory.path, false)))
      fail('XCTEST_ARTIFACT_CHANGED');
  }
  for (const ancestor of ancestors) {
    const stat = lstatHostSync(ancestor.path, { bigint: true });
    if (crossStatIdentity(stat) !== ancestor.identity || !sameHostPath(realpathSync(ancestor.path), ancestor.path))
      fail('XCTEST_ARTIFACT_CHANGED');
  }
  return hashObject(files);
}
