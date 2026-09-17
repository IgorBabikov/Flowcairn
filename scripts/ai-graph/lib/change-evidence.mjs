import { z } from 'zod';
import { GraphError, canonicalJson, hashObject, sha256 } from './io.mjs';
import { Hash, RelativePath } from './schemas.mjs';
import { parseJsonObjectEntries } from './json-transfers.mjs';
import { MAX_DIFF_BYTES, diffHeader } from './unified-diff.mjs';

export const CHANGE_EVIDENCE_FORMAT = 'flowcairn-change-evidence/v1';
export const STRUCTURAL_FILE_BYTES = 64 * 1024;
const FileVersion = z.strictObject({ hash: Hash, size: z.number().int().min(0).max(32 * 1024 * 1024), mode: z.enum(['100644', '100755']) });
const Entry = z.strictObject({ key: z.string().max(65536), value: z.string().min(1).max(MAX_DIFF_BYTES) });
const Replacement = z.strictObject({ key: z.string().max(65536), before: z.string().min(1).max(MAX_DIFF_BYTES), after: z.string().min(1).max(MAX_DIFF_BYTES) });
const Operation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), path: RelativePath, before: FileVersion.nullable(), after: FileVersion.nullable(), patch: z.string().min(1).max(MAX_DIFF_BYTES) }),
  z.strictObject({ kind: z.literal('move'), from: RelativePath, to: RelativePath, before: FileVersion, after: FileVersion, byteIdentical: z.literal(true) }),
  z.strictObject({ kind: z.literal('delete'), path: RelativePath, before: FileVersion, after: z.null(), contentIncluded: z.literal(false), jsonEntryCount: z.number().int().min(0).nullable() }),
  z.strictObject({ kind: z.literal('json-entries'), path: RelativePath, before: FileVersion, after: FileVersion,
    layout: z.literal('outer-whitespace-and-member-order-not-reproduced'), values: z.literal('exact-raw-json'),
    beforeEntryCount: z.number().int().min(0), afterEntryCount: z.number().int().min(0),
    unchangedEntryCount: z.number().int().min(0), unchangedEntriesHash: Hash,
    removed: z.array(Entry).max(500000), added: z.array(Entry).max(500000), replaced: z.array(Replacement).max(500000) }),
]);
const Report = z.strictObject({ format: z.literal(CHANGE_EVIDENCE_FORMAT), version: z.literal(1),
  beforeFingerprint: Hash, afterFingerprint: Hash, changedPaths: z.array(RelativePath).min(1).max(200), operations: z.array(Operation).min(1).max(200) });
const fail = () => { throw new GraphError('REVIEW_EVIDENCE_INVALID', 'Структурное evidence не подтверждает полный набор операций и состояний'); };
const same = (left, right) => hashObject(left) === hashObject(right);

export function fileVersion(entry) { return entry ? { hash: entry.hash, size: entry.size, mode: entry.mode } : null; }

/** Exact changed value lexemes; unchanged values are verified individually, not summarized by AI. */
export function jsonEntryEvidence(file, previous, current, oldBytes, newBytes) {
  if (!file.endsWith('.json') || !previous || !current || Math.max(oldBytes.length, newBytes.length) < STRUCTURAL_FILE_BYTES) return null;
  let old, next;
  try { old = parseJsonObjectEntries(oldBytes); next = parseJsonObjectEntries(newBytes); } catch { return null; }
  const removed = [], added = [], replaced = [], unchanged = [];
  for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    if (!next.has(key)) removed.push({ key, value: old.get(key) });
    else if (!old.has(key)) added.push({ key, value: next.get(key) });
    else if (old.get(key) !== next.get(key)) replaced.push({ key, before: old.get(key), after: next.get(key) });
    else unchanged.push([key, sha256(old.get(key))]);
  }
  return { kind: 'json-entries', path: file, before: fileVersion(previous), after: fileVersion(current),
    layout: 'outer-whitespace-and-member-order-not-reproduced', values: 'exact-raw-json',
    beforeEntryCount: old.size, afterEntryCount: next.size, unchangedEntryCount: unchanged.length,
    unchangedEntriesHash: hashObject(unchanged), removed, added, replaced };
}

export function deletionEvidence(file, previous, oldBytes) {
  let jsonEntryCount = null;
  if (file.endsWith('.json')) try { jsonEntryCount = parseJsonObjectEntries(oldBytes).size; } catch { /* Not a plain JSON object. */ }
  return { kind: 'delete', path: file, before: fileVersion(previous), after: null, contentIncluded: false, jsonEntryCount };
}

function validateValue(raw) {
  try {
    const entries = parseJsonObjectEntries(Buffer.from(`{"value":${raw}}`));
    if (entries.size !== 1 || entries.get('value') !== raw) fail();
  } catch { fail(); }
}

/** Revalidated at review intake: operation coverage, hashes/modes and JSON delta algebra are mandatory. */
export function validateChangeEvidence(content, { changedFiles, beforeFingerprint, afterFingerprint }) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_DIFF_BYTES) fail();
  let report;
  try { report = Report.parse(JSON.parse(content)); } catch { fail(); }
  if (report.beforeFingerprint !== beforeFingerprint || report.afterFingerprint !== afterFingerprint ||
      !same([...report.changedPaths].sort(), [...changedFiles].sort()) || new Set(report.changedPaths).size !== report.changedPaths.length) fail();
  const covered = [];
  for (const operation of report.operations) {
    if (operation.kind === 'move') {
      if (operation.from === operation.to || !same(operation.before, operation.after)) fail();
      covered.push(operation.from, operation.to);
    } else {
      covered.push(operation.path);
      if (operation.before && operation.after && (same(operation.before, operation.after) ||
          operation.before.hash === operation.after.hash && operation.before.size !== operation.after.size)) fail();
      if (operation.kind === 'text' && (!operation.before && !operation.after ||
          !operation.patch.startsWith(diffHeader(operation.path, operation.before, operation.after)) ||
          /^Binary evidence:|^Content withheld:|^Diff exceeds |^Git metadata changed:/m.test(operation.patch))) fail();
      if (operation.kind === 'json-entries') {
        const changed = [...operation.removed, ...operation.added, ...operation.replaced];
        if (new Set(changed.map((entry) => entry.key)).size !== changed.length ||
            operation.before.hash === operation.after.hash && changed.length > 0 ||
            operation.beforeEntryCount !== operation.unchangedEntryCount + operation.removed.length + operation.replaced.length ||
            operation.afterEntryCount !== operation.unchangedEntryCount + operation.added.length + operation.replaced.length) fail();
        for (const entry of [...operation.removed, ...operation.added]) validateValue(entry.value);
        for (const entry of operation.replaced) { validateValue(entry.before); validateValue(entry.after); if (entry.before === entry.after) fail(); }
      }
    }
  }
  if (covered.length !== new Set(covered).size || !same(covered.sort(), [...report.changedPaths].sort())) fail();
  return report;
}

export function encodeChangeEvidence(before, after, changedPaths, operations) {
  const content = canonicalJson({ format: CHANGE_EVIDENCE_FORMAT, version: 1, beforeFingerprint: before.hash,
    afterFingerprint: after.hash, changedPaths, operations });
  validateChangeEvidence(content, { changedFiles: changedPaths, beforeFingerprint: before.hash, afterFingerprint: after.hash });
  return content;
}
