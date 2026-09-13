import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  fstatSync,
  lstatSync,
  readdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashObject } from './lib/io.mjs';
import {
  buildReviewEvidence,
  validateReviewEvidence,
  createReviewEvidenceFile,
  verifyReviewEvidenceFile,
  disposeReviewEvidenceFile,
  MAX_REVIEW_EVIDENCE_BYTES,
} from './lib/review-evidence.mjs';

function fixture({
  diff = '--- a/src/old.txt\n+++ /dev/null\n-deleted tail\n',
  noop = false,
  count = 1,
} = {}) {
  const hash = hashObject('fixture');
  const node = { id: 'review', action: { id: 'ai-review' }, resources: { reads: ['src'] } };
  const task = { scope: ['src'], forbiddenPaths: [] };
  const implementations = Array.from({ length: count }, (_, i) => ({
    id: `implement-${i}`,
    action: { id: 'ai-implement', version: 1 },
  }));
  const plan = {
    nodes: [...implementations, node],
    sourceHash: hash,
    runtimeHash: hash,
    version: 1,
  };
  const objects = new Map();
  const artifact = (kind, content, mediaType) => {
    const value = { schemaVersion: 2, kind, title: kind, mediaType, content };
    const parts = [];
    for (let i = 0; i < content.length; i += 8000) parts.push(content.slice(i, i + 8000));
    const { content: _, ...metadata } = value;
    const id = hashObject({ ...metadata, parts });
    objects.set(id, value);
    return id;
  };
  const state = {
    runId: 'run-test',
    taskHash: hashObject(task),
    planHash: hashObject(plan),
    nodes: {},
  };
  for (const [i, definition] of implementations.entries()) {
    const before = hashObject(`before-${i}`),
      after = noop ? before : hashObject(`after-${i}`);
    const changedFiles = noop ? [] : ['src/old.txt'];
    const receipt = {
      schemaVersion: 2,
      runId: state.runId,
      nodeId: definition.id,
      attemptId: `attempt-${i}`,
      attempt: 1,
      phase: 'finished',
      actionId: 'ai-implement',
      actionVersion: 1,
      planVersion: 1,
      planHash: state.planHash,
      taskHash: state.taskHash,
      sourceHash: hash,
      runtimeHash: hash,
      instructionsHash: hash,
      skills: [],
      permissions: ['workspace.source.write'],
      grantedPermissions: ['workspace.source.write'],
      termination: {
        stopped: true,
        uncertain: false,
        timedOut: false,
        outputLimit: false,
        signal: null,
        ticketHash: null,
        execution: null,
      },
      startedAt: '2026-09-13T01:00:00.000Z',
      finishedAt: '2026-09-13T01:00:01.000Z',
      durationMs: 1000,
      exitCode: 0,
      verdict: 'pass',
      checks: [],
      artifacts: [
        artifact('diff', noop ? '' : diff, 'text/x-diff'),
        artifact(
          'changed-files',
          JSON.stringify({ changedFiles, before, after, complete: true }),
          'application/json',
        ),
      ],
      changedFiles,
      failureReason: null,
      beforeFingerprint: before,
      afterFingerprint: after,
      actor: 'fixture',
      operationId: `operation-${i}`,
      previousReceipt: null,
    };
    const id = hashObject(receipt);
    objects.set(id, receipt);
    state.nodes[definition.id] = { status: 'passed', receipts: [id] };
  }
  const options = {
    state,
    task,
    plan,
    node,
    fingerprint: { hash },
    readReceipt: (id) => objects.get(id),
    readArtifact: (id) => objects.get(id),
  };
  return { options, objects, build: () => buildReviewEvidence(options) };
}

// ASCII limit tests here; real Graph follow-up adds the separate exact UTF-8 boundary regression.
test('complete >32 KiB evidence retains tail after 1500 chars and every deletion/implementation', () => {
  const diff = `--- a/src/old.txt\n+++ /dev/null\n-${'x'.repeat(40000)}\n-last deleted line\n`;
  const f = fixture({ diff, count: 2 });
  const bundle = f.build();
  assert.ok(bundle.bytes > 32 * 1024);
  assert.equal(bundle.evidence.implementations.length, 2);
  for (const entry of bundle.evidence.implementations) {
    assert.equal(entry.diff.artifact.content, diff);
    assert.deepEqual(entry.receipt.changedFiles, ['src/old.txt']);
    assert.notEqual(entry.receipt.beforeFingerprint, entry.receipt.afterFingerprint);
  }
  assert.equal(bundle.hash, hashObject(bundle.evidence));
});

test('no-op is explicit complete empty diff bound to identical before/after', () => {
  const bundle = fixture({ noop: true }).build();
  const entry = bundle.evidence.implementations[0];
  assert.equal(entry.diff.artifact.content, '');
  assert.deepEqual(entry.receipt.changedFiles, []);
  assert.equal(entry.receipt.beforeFingerprint, entry.receipt.afterFingerprint);
});

test('missing implementation, missing artifact, tampered receipt/diff and stale binding fail closed', () => {
  for (const mutate of [
    (f) => {
      f.options.state.nodes['implement-0'].status = 'pending';
    },
    (f) => {
      f.options.readArtifact = () => undefined;
    },
    (f) => {
      const r = f.options.readReceipt(f.options.state.nodes['implement-0'].receipts[0]);
      r.afterFingerprint = hashObject('tampered');
    },
    (f) => {
      const r = f.options.readReceipt(f.options.state.nodes['implement-0'].receipts[0]);
      f.objects.get(r.artifacts[0]).content += 'tampered';
    },
    (f) => {
      f.options.state.planHash = hashObject('old-plan');
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => f.build());
  }
  const f = fixture({ count: 2 });
  const bundle = f.build();
  bundle.evidence.implementations.pop();
  assert.throws(() => validateReviewEvidence(bundle.evidence, f.options), {
    code: 'REVIEW_EVIDENCE_INVALID',
  });
});

test('incomplete, wrong before/after, binary, read scope and total ASCII oversize cannot pass', () => {
  for (const content of ['Binary evidence: omitted\n', 'Content withheld: sensitive marker\n'])
    assert.throws(() => fixture({ diff: content }).build(), { code: 'REVIEW_EVIDENCE_INVALID' });
  for (const update of [
    { complete: false },
    { before: hashObject('wrong') },
    { changedFiles: [] },
  ]) {
    const f = fixture();
    const receipt = f.options.readReceipt(f.options.state.nodes['implement-0'].receipts[0]);
    const original = f.objects.get(receipt.artifacts[1]);
    original.content = JSON.stringify({ ...JSON.parse(original.content), ...update });
    // Rebind artifact/receipt to prove semantic validation, not only tamper detection.
    const { content, ...metadata } = original;
    const artifactId = hashObject({ ...metadata, parts: [content] });
    f.objects.set(artifactId, original);
    receipt.artifacts[1] = artifactId;
    const receiptId = hashObject(receipt);
    f.objects.set(receiptId, receipt);
    f.options.state.nodes['implement-0'].receipts = [receiptId];
    assert.throws(() => f.build(), { code: 'REVIEW_EVIDENCE_INVALID' });
  }
  const scope = fixture();
  scope.options.node.resources.reads = ['other'];
  assert.throws(() => scope.build(), { code: 'REVIEW_EVIDENCE_INVALID' });
  assert.throws(() => fixture({ diff: 'x'.repeat(MAX_REVIEW_EVIDENCE_BYTES) }).build(), {
    code: 'REVIEW_EVIDENCE_LIMIT',
  });
});

test('private exact file keeps complete bounded bytes; repeated pre/post checks and cleanup', (t) => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-evidence-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = fixture({ diff: 'x'.repeat(40000) }).build();
  const file = createReviewEvidenceFile(directory, bundle);
  assert.equal(readFileSync(file.path, 'utf8'), bundle.content);
  verifyReviewEvidenceFile(file);
  verifyReviewEvidenceFile(file);
  disposeReviewEvidenceFile(file);
  assert.throws(() => readFileSync(file.path));
});

test('file replacement, symlink, hardlink, missing bytes and same-size tamper are rejected', (t) => {
  for (const mutation of ['replace', 'symlink', 'hardlink', 'missing', 'tamper']) {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-evidence-')));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bundle = fixture().build();
    const file = createReviewEvidenceFile(directory, bundle);
    const other = path.join(directory, 'other');
    if (mutation === 'replace' || mutation === 'symlink') {
      renameSync(file.path, other);
      if (mutation === 'replace') writeFileSync(file.path, bundle.content, { mode: 0o400 });
      else symlinkSync(other, file.path);
    } else if (mutation === 'hardlink') linkSync(file.path, other);
    else if (mutation === 'missing') rmSync(file.path);
    else {
      chmodSync(file.path, 0o600);
      writeFileSync(file.path, 'x'.repeat(bundle.bytes));
      chmodSync(file.path, 0o400);
    }
    assert.throws(() => verifyReviewEvidenceFile(file), { code: 'REVIEW_EVIDENCE_INVALID' });
    const ownedFd = file.fd;
    const replacement = ['replace', 'symlink'].includes(mutation) ? lstatSync(file.path) : null;
    disposeReviewEvidenceFile(file);
    assert.throws(() => fstatSync(ownedFd), { code: 'EBADF' });
    if (replacement) {
      const retained = lstatSync(file.path);
      assert.equal(retained.dev, replacement.dev);
      assert.equal(retained.ino, replacement.ino);
      assert.equal(retained.isSymbolicLink(), mutation === 'symlink');
      assert.equal(readFileSync(other, 'utf8'), bundle.content);
    }
  }
});

test('creation failure preserves a replacement using the original writer FD identity', (t) => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-evidence-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let originalPath;
  const moved = path.join(directory, 'retained-original');
  const bundle = {
    get content() {
      originalPath = path.join(directory, readdirSync(directory)[0]);
      renameSync(originalPath, moved);
      writeFileSync(originalPath, 'foreign replacement', { mode: 0o400 });
      throw new Error('controlled preparation failure');
    },
  };
  assert.throws(
    () => createReviewEvidenceFile(directory, bundle),
    /controlled preparation failure/,
  );
  assert.equal(readFileSync(originalPath, 'utf8'), 'foreign replacement');
  assert.equal(readFileSync(moved, 'utf8'), '');
});

test('creation failure removes the file only when its original identity still owns the path', (t) => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-evidence-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = fixture().build();
  assert.throws(
    () => createReviewEvidenceFile(directory, { ...bundle, hash: hashObject('wrong') }),
    {
      code: 'REVIEW_EVIDENCE_INVALID',
    },
  );
  assert.deepEqual(readdirSync(directory), []);
});
