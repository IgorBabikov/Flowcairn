import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from './host-filesystem.mjs';
import { isPrivateMode } from './host-filesystem.mjs';
import { assertSafeText } from './source-policy.mjs';
import { randomUUID } from 'node:crypto';
import {
  fchmodSync,
  closeSync,
  constants,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ArtifactSchema, Hash, Id, ReceiptSchema, TaskSpecSchema, GraphPlanSchema, assertJsonBounds } from './schemas.mjs';
import { GraphError, canonicalJson, hashObject, sha256 } from './io.mjs';
import { isWithin, pathAllowed } from './registry.mjs';
import { CHANGE_EVIDENCE_FORMAT, validateChangeEvidence } from './change-evidence.mjs';

// Separate from the 32 KiB prior-evidence / 128 KiB prompt budgets; never truncate a diff.
export const MAX_REVIEW_EVIDENCE_BYTES = 512 * 1024;
export const MAX_HISTORICAL_EXECUTIONS = 20;
const Artifact = z.strictObject({ hash: Hash, artifact: ArtifactSchema });
const CompletedImplementation = z.strictObject({
  receiptHash: Hash,
  receipt: ReceiptSchema,
  diff: Artifact,
  changedFiles: Artifact,
});
const CurrentEvidence = z.strictObject({
  version: z.literal(1),
  runId: Id,
  taskHash: Hash,
  planHash: Hash,
  reviewNodeId: Id,
  workspaceFingerprint: Hash,
  implementations: z.array(CompletedImplementation).max(100),
});
const HistoricalIncompleteImplementation = z.strictObject({
  nodeId: Id,
  status: z.enum(['pending', 'failed', 'cancelled', 'uncertain']),
  receiptHash: Hash.nullable(),
  receipt: ReceiptSchema.nullable(),
});
const HistoricalEvidence = z.strictObject({
  version: z.literal(1),
  runId: Id,
  taskHash: Hash,
  planHash: Hash,
  reviewNodeId: Id,
  workspaceFingerprint: Hash,
  completedImplementations: z.array(CompletedImplementation).max(100),
  incompleteImplementations: z.array(HistoricalIncompleteImplementation).max(100),
});
const PreviousExecution = z.strictObject({ task: TaskSpecSchema, plan: GraphPlanSchema, evidence: HistoricalEvidence });
const Evidence = CurrentEvidence.extend({ previousExecutions: z.array(PreviousExecution).max(MAX_HISTORICAL_EXECUTIONS).optional() });
function fail(message) {
  throw new GraphError('REVIEW_EVIDENCE_INVALID', message);
}
function artifactHash(artifact) {
  const { content, ...metadata } = artifact;
  const parts = [];
  for (let i = 0; i < content.length; i += 8000) parts.push(content.slice(i, i + 8000));
  return hashObject({ ...metadata, parts });
}

function validateCompletedImplementation(entry, definition, evidence, task, plan, node) {
  const { receipt, receiptHash, diff, changedFiles } = entry;
  if (
    !definition ||
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
    if (!receipt.artifacts.includes(artifact.hash) || artifactHash(artifact.artifact) !== artifact.hash)
      fail('Artifact hash не совпадает с implementation receipt');
  if (
    diff.artifact.kind !== 'diff' ||
    !['text/x-diff', 'application/json'].includes(diff.artifact.mediaType) ||
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
      (file) => !pathAllowed(file, task) || !node.resources.reads.some((prefix) => isWithin(file, prefix)),
    )
  )
    fail('Review evidence выходит за разрешенный read scope');
  if (
    (receipt.changedFiles.length === 0) !== (diff.artifact.content.length === 0) ||
    (receipt.changedFiles.length === 0) !== (receipt.beforeFingerprint === receipt.afterFingerprint)
  )
    fail('No-op/diff не совпадает с fingerprint');
  if (diff.artifact.mediaType === 'application/json') {
    if (changes.format !== CHANGE_EVIDENCE_FORMAT) fail('Неизвестный формат структурного evidence');
    validateChangeEvidence(diff.artifact.content, { changedFiles: receipt.changedFiles,
      beforeFingerprint: receipt.beforeFingerprint, afterFingerprint: receipt.afterFingerprint });
  } else if (changes.format && changes.format !== 'unified-diff') {
    fail('Формат diff не соответствует artifact media type');
  } else if (/^Binary evidence:|^Content withheld:|^Diff exceeds |^Git metadata changed:/m.test(diff.artifact.content))
    fail('Diff не содержит полного проверяемого текста');
}

function validateCompletedSet(entries, implementations, evidence, task, plan, node, label) {
  if (
    hashObject(implementations.map((item) => item.id).sort()) !==
    hashObject(entries.map((item) => item.receipt.nodeId).sort())
  )
    fail(label);
  for (const entry of entries) {
    const definition = implementations.find((item) => item.id === entry.receipt.nodeId);
    validateCompletedImplementation(entry, definition, evidence, task, plan, node);
  }
}

function validateHistoricalEvidence(value, { node, task, plan }) {
  const parsed = HistoricalEvidence.safeParse(value);
  if (!parsed.success) fail('Historical review evidence поврежден');
  const evidence = parsed.data;
  if (
    node.action.id !== 'ai-review' ||
    evidence.reviewNodeId !== node.id ||
    evidence.taskHash !== hashObject(task) ||
    evidence.planHash !== hashObject(plan)
  )
    fail('Historical review evidence не совпадает с task/plan/node');
  const implementations = plan.nodes.filter((item) => item.action.id === 'ai-implement');
  const completed = new Map(evidence.completedImplementations.map((item) => [item.receipt.nodeId, item]));
  const incomplete = new Map(evidence.incompleteImplementations.map((item) => [item.nodeId, item]));
  if (
    completed.size !== evidence.completedImplementations.length ||
    incomplete.size !== evidence.incompleteImplementations.length ||
    [...completed.keys()].some((id) => incomplete.has(id)) ||
    hashObject([...new Set([...completed.keys(), ...incomplete.keys()])].sort()) !==
      hashObject(implementations.map((item) => item.id).sort())
  )
    fail('Historical review evidence не покрывает immutable implementation nodes');
  for (const entry of evidence.completedImplementations)
    validateCompletedImplementation(entry, implementations.find((item) => item.id === entry.receipt.nodeId), evidence, task, plan, node);
  let previousFingerprint = null;
  let pendingSeen = false;
  for (const definition of implementations) {
    const complete = completed.get(definition.id);
    if (complete) {
      if (pendingSeen) fail('Historical execution имеет эффект после незапущенного node');
      if (previousFingerprint && complete.receipt.beforeFingerprint !== previousFingerprint)
        fail('Historical execution имеет разрыв fingerprint');
      previousFingerprint = complete.receipt.afterFingerprint;
      continue;
    }
    const item = incomplete.get(definition.id);
    pendingSeen ||= item.status === 'pending';
    if (item.status === 'pending') {
      if (item.receipt || item.receiptHash) fail('Pending historical node не должен иметь receipt');
      continue;
    }
    const receipt = item.receipt;
    if (
      !receipt ||
      !item.receiptHash ||
      hashObject(receipt) !== item.receiptHash ||
      receipt.runId !== evidence.runId ||
      receipt.taskHash !== evidence.taskHash ||
      receipt.planHash !== evidence.planHash ||
      receipt.sourceHash !== plan.sourceHash ||
      receipt.runtimeHash !== plan.runtimeHash ||
      receipt.planVersion !== plan.version ||
      receipt.actionId !== definition.action.id ||
      receipt.actionVersion !== definition.action.version ||
      !['finished', 'recovery'].includes(receipt.phase) ||
      receipt.verdict !== (item.status === 'failed' ? 'fail' : item.status === 'cancelled' ? 'cancelled' : 'uncertain') ||
      !receipt.termination?.stopped ||
      receipt.termination.uncertain ||
      !receipt.afterFingerprint ||
      receipt.beforeFingerprint !== receipt.afterFingerprint ||
      receipt.changedFiles.length !== 0
    )
      fail('Незавершенный historical node не доказал отсутствие изменений');
    if (previousFingerprint && receipt.beforeFingerprint !== previousFingerprint)
      fail('Historical execution имеет разрыв fingerprint');
    previousFingerprint = receipt.afterFingerprint;
  }
  if (previousFingerprint && previousFingerprint !== evidence.workspaceFingerprint)
    fail('Historical execution не связан с финальным workspace fingerprint');
  return evidence;
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
  validateCompletedSet(
    evidence.implementations,
    implementations,
    evidence,
    task,
    plan,
    node,
    'Review требует evidence всех implementation текущего плана',
  );
  const previous = evidence.previousExecutions ?? [];
  for (const entry of previous) {
    const priorNode = entry.plan.nodes.find((candidate) => candidate.action.id === 'ai-review');
    if (!priorNode || plan.workflow !== 'autonomous' || entry.plan.workflow !== 'autonomous' ||
        entry.plan.version >= plan.version ||
        hashObject(entry.task.scope) !== hashObject(task.scope) || entry.task.id !== task.id ||
        entry.task.instructions !== task.instructions || hashObject(entry.task.checks) !== hashObject(task.checks))
      fail('Предыдущая версия не относится к согласованной задаче');
    validateHistoricalEvidence(entry.evidence, { node: priorNode, task: entry.task, plan: entry.plan });
    if (entry.evidence.completedImplementations.some((implementation) => implementation.receipt.changedFiles.some((file) =>
      !pathAllowed(file, task) || !node.resources.reads.some((scope) => isWithin(file, scope)))))
      fail('Предыдущие изменения выходят за текущий read scope');
  }
  const ordered = [...previous.map((entry) => ({
    fingerprint: entry.evidence.workspaceFingerprint,
    first: [...entry.evidence.completedImplementations, ...entry.evidence.incompleteImplementations]
      .map((item) => item.receipt?.beforeFingerprint ?? null).find(Boolean),
  })), { fingerprint: null, first: evidence.implementations[0]?.receipt.beforeFingerprint ?? null }];
  for (let index = 1; index < ordered.length; index++) {
    const before = ordered[index - 1].fingerprint;
    const after = ordered[index].first;
    if (before && after && before !== after) fail('Цепочка fingerprint между версиями неполная');
  }
  const content = canonicalJson(evidence);
  assertSafeText(content);
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
  previousExecutions = [],
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
      ...(previousExecutions.length ? { previousExecutions } : {}),
    },
    { node, task, plan },
  );
}

export function buildHistoricalReviewEvidence({ state, task, plan, node, fingerprint, readReceipt, readArtifact }) {
  if (!fingerprint?.hash) fail('Historical execution не сохранил workspace fingerprint');
  const completedImplementations = [];
  const incompleteImplementations = [];
  for (const definition of plan.nodes.filter((item) => item.action.id === 'ai-implement')) {
    const current = state.nodes[definition.id];
    if (current?.status === 'passed') {
      if (!current.receipts.length) fail('Historical implementation не сохранил receipt');
      const receiptHash = current.receipts.at(-1);
      const receipt = readReceipt(receiptHash);
      const artifacts = receipt.artifacts.map((hash) => ({ hash, artifact: readArtifact(hash) }));
      const pick = (kind) => {
        const matching = artifacts.filter((item) => item.artifact.kind === kind);
        if (matching.length !== 1) fail(`Historical implementation требует ровно один ${kind} artifact`);
        return matching[0];
      };
      completedImplementations.push({ receiptHash, receipt, diff: pick('diff'), changedFiles: pick('changed-files') });
      continue;
    }
    if (!current || !['pending', 'failed', 'cancelled', 'uncertain'].includes(current.status))
      fail('Historical implementation не имеет доказуемого статуса');
    if (current.status === 'pending') {
      if (current.attempts !== 0 || current.receipts.length !== 0)
        fail('Pending historical implementation содержит незавершенную попытку');
      incompleteImplementations.push({ nodeId: definition.id, status: 'pending', receiptHash: null, receipt: null });
      continue;
    }
    const receiptHash = current.receipts.at(-1);
    if (!receiptHash) fail('Незавершенный historical implementation не сохранил receipt');
    incompleteImplementations.push({
      nodeId: definition.id,
      status: current.status,
      receiptHash,
      receipt: readReceipt(receiptHash),
    });
  }
  return validateHistoricalEvidence(
    {
      version: 1,
      runId: state.runId,
      taskHash: state.taskHash,
      planHash: state.planHash,
      reviewNodeId: node.id,
      workspaceFingerprint: fingerprint.hash,
      completedImplementations,
      incompleteImplementations,
    },
    { node, task, plan },
  );
}

function physicalDirectory(directory) {
  if (realpathSync(directory) !== directory) fail('Review file directory содержит ссылку');
  for (let cursor = directory; cursor !== path.dirname(cursor); cursor = path.dirname(cursor))
    if (lstatSync(cursor).isSymbolicLink()) fail('Review file ancestor содержит ссылку');
  if (!isPrivateMode(lstatSync(directory))) fail('Review file directory должен быть private');
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
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o400) ||
      (process.getuid && stat.uid !== process.getuid()) ||
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
