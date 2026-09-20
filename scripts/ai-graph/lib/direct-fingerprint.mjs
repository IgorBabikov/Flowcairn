import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { inspectWorkspaceChanges } from './workspace.mjs';

/** Compare historical direct snapshots without mistaking a fixed ordering for a source edit. */
export function normalizeDirectFingerprint(value) {
  const original = { files: value?.files, git: value?.git };
  if (!Array.isArray(original.files) || !original.git || sha256(canonicalJson(original)) !== value.hash)
    throw new GraphError('DIRECT_FINGERPRINT', 'Старый снимок исходников не прошел проверку целостности');
  const files = [...original.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const body = { files, git: original.git };
  return { ...body, hash: sha256(canonicalJson(body)) };
}

export function inspectDirectChanges(before, after, node, task) {
  return inspectWorkspaceChanges(normalizeDirectFingerprint(before), normalizeDirectFingerprint(after), node, task);
}
