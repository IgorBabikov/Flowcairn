import { randomUUID } from 'node:crypto';
import {
  fchmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ArtifactSchema, Hash, Id, ReceiptSchema, assertJsonBounds } from './schemas.mjs';
import { GraphError, canonicalJson, hashObject, sha256 } from './io.mjs';
import { isWithin, pathAllowed } from './registry.mjs';

// Separate from the 32 KiB prior-evidence / 128 KiB prompt budgets; never truncate a diff.
export const MAX_REVIEW_EVIDENCE_BYTES = 512 * 1024;
const Artifact = z.strictObject({ hash: Hash, artifact: ArtifactSchema });
const Evidence = z.strictObject({
  version: z.literal(1),
  runId: Id,
  taskHash: Hash,
  planHash: Hash,
  reviewNodeId: Id,
  workspaceFingerprint: Hash,
  implementations: z
    .array(
      z.strictObject({
        receiptHash: Hash,
        receipt: ReceiptSchema,
        diff: Artifact,
        changedFiles: Artifact,
      }),
    )
    .max(100),
});
function fail(message) {
  throw new GraphError('REVIEW_EVIDENCE_INVALID', message);
}
function artifactHash(artifact) {
  const { content, ...metadata } = artifact;
  const parts = [];
  for (let i = 0; i < content.length; i += 8000) parts.push(content.slice(i, i + 8000));
  return hashObject({ ...metadata, parts });
}

/** Revalidated both by service and runner. No paths/permissions are supplied by this payload. */
export function validateReviewEvidence(value, { node, task, plan }) {
  assertJsonBounds(value);
  const parsed = Evidence.safeParse(value);
  if (!parsed.success) fail('Необходим полный validated review bundle');
  const evidence = parsed.data;
  if (
    node.action.id !== 'ai-review' ||
    evidence.reviewNodeId !== node.id ||
    evidence.taskHash !== hashObject(task) ||
    evidence.planHash !== hashObject(plan)
  )
    fail('Review bundle не совпадает с текущим task/plan/node');
  const implementations = plan.nodes.filter((n) => n.action.id === 'ai-implement');
  if (
    hashObject(implementations.map((n) => n.id).sort()) !==
    hashObject(evidence.implementations.map((e) => e.receipt.nodeId).sort())
  )
    fail('Review требует evidence всех implementation текущего плана');
  for (const entry of evidence.implementations) {
    const { receipt, receiptHash, diff, changedFiles } = entry;
    const definition = implementations.find((n) => n.id === receipt.nodeId);
    if (
      hashObject(receipt) !== receiptHash ||
      receipt.runId !== evidence.runId ||
      receipt.taskHash !== evidence.taskHash ||
      receipt.planHash !== evidence.planHash ||
      receipt.sourceHash !== plan.sourceHash ||
      receipt.runtimeHash !== plan.runtimeHash ||
      receipt.planVersion !== plan.version ||
      receipt.actionId !== definition.action.id ||
      receipt.actionVersion !== definition.action.version ||
      receipt.phase !== 'finished' ||
      receipt.verdict !== 'pass' ||
      receipt.exitCode !== 0 ||
      !receipt.termination?.stopped ||
      receipt.termination.uncertain ||
      !receipt.afterFingerprint
    )
      fail('Implementation receipt не подтвержден');
    for (const artifact of [diff, changedFiles])
      if (
        !receipt.artifacts.includes(artifact.hash) ||
        artifactHash(artifact.artifact) !== artifact.hash
      )
        fail('Artifact hash не совпадает с implementation receipt');
    if (
      diff.artifact.kind !== 'diff' ||
      diff.artifact.mediaType !== 'text/x-diff' ||
      changedFiles.artifact.kind !== 'changed-files' ||
      changedFiles.artifact.mediaType !== 'application/json'
    )
      fail('Отсутствует diff/changed-files evidence');
    let changes;
    try {
      changes = JSON.parse(changedFiles.artifact.content);
    } catch {
      fail('Changed-files JSON поврежден');
    }
    if (
      changes.complete !== true ||
      changes.before !== receipt.beforeFingerprint ||
      changes.after !== receipt.afterFingerprint ||
      hashObject(changes.changedFiles) !== hashObject(receipt.changedFiles)
    )
      fail('Diff неполный или не совпадает с before/after/changed-files');
    if (
      receipt.changedFiles.some(
        (file) =>
          !pathAllowed(file, task) ||
          !node.resources.reads.some((prefix) => isWithin(file, prefix)),
      )
    )
      fail('Review evidence выходит за разрешенный read scope');
    if (
      (receipt.changedFiles.length === 0) !== (diff.artifact.content.length === 0) ||
      (receipt.changedFiles.length === 0) !==
        (receipt.beforeFingerprint === receipt.afterFingerprint)
    )
      fail('No-op/diff не совпадает с fingerprint');
    if (
      /^Binary evidence:|^Content withheld:|^Diff exceeds |^Git metadata changed:/m.test(
        diff.artifact.content,
      )
    )
      fail('Diff не содержит полного проверяемого текста');
  }
  const content = canonicalJson(evidence);
  if (Buffer.byteLength(content) > MAX_REVIEW_EVIDENCE_BYTES)
    throw new GraphError(
      'REVIEW_EVIDENCE_LIMIT',
      'Review bundle превышает 512 KiB; разделите задачу',
    );
  return { evidence, content, hash: sha256(content), bytes: Buffer.byteLength(content) };
}

export function buildReviewEvidence({
  state,
  task,
  plan,
  node,
  fingerprint,
  readReceipt,
  readArtifact,
}) {
  const implementations = plan.nodes
    .filter((n) => n.action.id === 'ai-implement')
    .map((definition) => {
      const current = state.nodes[definition.id];
      if (current?.status !== 'passed' || !current.receipts.length)
        fail('Implementation еще не подтвержден');
      const receiptHash = current.receipts.at(-1),
        receipt = readReceipt(receiptHash);
      const artifacts = receipt.artifacts.map((hash) => ({ hash, artifact: readArtifact(hash) }));
      const pick = (kind) => {
        const matching = artifacts.filter((a) => a.artifact.kind === kind);
        if (matching.length !== 1) fail(`Требуется ровно один ${kind} artifact`);
        return matching[0];
      };
      return { receiptHash, receipt, diff: pick('diff'), changedFiles: pick('changed-files') };
    });
  return validateReviewEvidence(
    {
      version: 1,
      runId: state.runId,
      taskHash: state.taskHash,
      planHash: state.planHash,
      reviewNodeId: node.id,
      workspaceFingerprint: fingerprint.hash,
      implementations,
    },
    { node, task, plan },
  );
}

function physicalDirectory(directory) {
  if (realpathSync(directory) !== directory) fail('Review file directory содержит ссылку');
  for (let cursor = directory; cursor !== path.dirname(cursor); cursor = path.dirname(cursor))
    if (lstatSync(cursor).isSymbolicLink()) fail('Review file ancestor содержит ссылку');
  if (lstatSync(directory).mode & 0o077) fail('Review file directory должен быть private');
}
export function createReviewEvidenceFile(directory, bundle) {
  physicalDirectory(directory);
  const file = path.join(directory, `review-evidence-${randomUUID()}.json`);
  let writer, fd, identity;
  try {
    writer = openSync(file, 'wx', 0o600);
    const stat = fstatSync(writer);
    identity = { path: file, dev: stat.dev, ino: stat.ino };
    writeFileSync(writer, bundle.content);
    fchmodSync(writer, 0o400);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = { ...identity, fd, hash: bundle.hash, bytes: bundle.bytes };
    verifyReviewEvidenceFile(descriptor);
    return descriptor;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (identity) unlinkOwnedReviewFile(identity);
    throw error;
  } finally {
    if (writer !== undefined) closeSync(writer);
  }
}
export function verifyReviewEvidenceFile(file) {
  try {
    physicalDirectory(path.dirname(file.path));
    const stat = fstatSync(file.fd),
      linked = lstatSync(file.path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o400 ||
      stat.uid !== process.getuid() ||
      stat.size !== file.bytes ||
      stat.size > MAX_REVIEW_EVIDENCE_BYTES ||
      linked.isSymbolicLink() ||
      linked.dev !== file.dev ||
      linked.ino !== file.ino ||
      stat.dev !== file.dev ||
      stat.ino !== file.ino
    )
      fail('Review file заменен или изменен');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('Review file неполный');
      offset += count;
    }
    if (sha256(bytes) !== file.hash) fail('Review file hash изменился');
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail('Review file недоступен');
  }
}
function unlinkOwnedReviewFile(file) {
  // Never remove a replacement or follow a substituted directory during cleanup.
  try {
    physicalDirectory(path.dirname(file.path));
    const linked = lstatSync(file.path);
    if (linked.isFile() && linked.dev === file.dev && linked.ino === file.ino)
      rmSync(file.path, { force: true });
  } catch {
    /* Missing or changed paths are preserved; verification already fails closed. */
  }
}

export function disposeReviewEvidenceFile(file, { unlink = true } = {}) {
  const fd = file.fd;
  // Consume ownership before closing, so repeated cleanup cannot close a reused descriptor.
  file.fd = null;
  if (fd !== null) {
    try {
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.dev === file.dev && stat.ino === file.ino) closeSync(fd);
    } catch (error) {
      if (error.code !== 'EBADF') throw error;
    }
  }
  if (unlink) unlinkOwnedReviewFile(file);
}
