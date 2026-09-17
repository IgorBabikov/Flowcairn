import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './lib/io.mjs';
import { validateRequirementAssessments } from './lib/requirement-verification.mjs';

function fixture(t, { source = 'first\nsecond\nthird\n', method = 'source-review' } = {}) {
  const worktree = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-citation-'));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  mkdirSync(path.join(worktree, 'src'));
  const bytes = Buffer.from(source);
  const file = path.join(worktree, 'src/result.mjs');
  writeFileSync(file, bytes);
  const verification = { method, criterion: 'Исходник содержит ожидаемый текст', checkIds: method === 'check' ? ['check-tests'] : [], paths: ['src'] };
  const assessment = { requirementId: 'req-001', verdict: 'pass', criterion: verification.criterion, checkIds: verification.checkIds,
    citations: [{ path: 'src/result.mjs', startLine: 2, quote: 'second' }], reason: 'Сравнение с проверенным исходником' };
  const input = { worktree, output: { requirementAssessments: [assessment] },
    plan: { taskContract: { requirements: [{ id: 'req-001', verification }] } }, node: { resources: { reads: ['src'] } },
    fingerprint: { files: [{ path: 'src/result.mjs', hash: sha256(bytes), size: bytes.length }] } };
  return { input, file, worktree, assessment, verification, validate: () => validateRequirementAssessments(input) };
}
const rejected = (action) => assert.throws(action, (error) => error.code === 'REQUIREMENT_EVIDENCE_INVALID');

test('real LF and CRLF files accept exact single-line and multiline citations', (t) => {
  for (const newline of ['\n', '\r\n']) {
    const f = fixture(t, { source: ['first', 'second', 'third', ''].join(newline) });
    assert.doesNotThrow(f.validate);
    f.assessment.citations = [{ path: 'src/result.mjs', startLine: 1, quote: `first${newline}second` }];
    assert.doesNotThrow(f.validate);
  }
});

test('invalid UTF-8 bytes cannot become a replacement-character citation', (t) => {
  const f = fixture(t, { source: Buffer.from([255]) });
  f.assessment.citations = [{ path: 'src/result.mjs', startLine: 1, quote: '\uFFFD' }];
  rejected(f.validate);
});

test('NUL-containing binary content is rejected even if the quoted line is textual', (t) => {
  const f = fixture(t, { source: 'first\nsecond\n\0binary' });
  rejected(f.validate);
});

test('a symlinked citation file is rejected despite matching bytes and scope', (t) => {
  const f = fixture(t); const target = path.join(f.worktree, 'real-file.mjs');
  writeFileSync(target, 'first\nsecond\nthird\n'); rmSync(f.file); symlinkSync(target, f.file);
  rejected(f.validate);
});

test('a symlinked citation ancestor is rejected', (t) => {
  const f = fixture(t); const target = path.join(f.worktree, 'actual-source');
  mkdirSync(target); writeFileSync(path.join(target, 'result.mjs'), 'first\nsecond\nthird\n');
  rmSync(path.join(f.worktree, 'src'), { recursive: true }); symlinkSync(target, path.join(f.worktree, 'src'));
  rejected(f.validate);
});

test('hardlinked citation bytes do not bypass the single-file ownership rule', (t) => {
  const f = fixture(t); linkSync(f.file, path.join(f.worktree, 'shared.mjs'));
  rejected(f.validate);
});

test('citation must belong to both requirement verification scope and node read scope', (t) => {
  const f = fixture(t); f.verification.paths = ['elsewhere']; rejected(f.validate);
  f.verification.paths = ['src']; f.input.node.resources.reads = ['elsewhere']; rejected(f.validate);
});

test('missing fingerprint entry, size drift and same-size hash drift reject otherwise exact quotes', (t) => {
  const missing = fixture(t); missing.input.fingerprint.files = []; rejected(missing.validate);
  const resized = fixture(t); writeFileSync(resized.file, 'first\nsecond\nthird\nextra'); rejected(resized.validate);
  const changed = fixture(t); writeFileSync(changed.file, 'FIRST\nsecond\nthird\n'); rejected(changed.validate);
});

test('invented text, wrong line numbers and blank citations are rejected', (t) => {
  const f = fixture(t);
  for (const citation of [
    { path: 'src/result.mjs', startLine: 2, quote: 'invented' },
    { path: 'src/result.mjs', startLine: 1, quote: 'second' },
    { path: 'src/result.mjs', startLine: 100, quote: 'second' },
    { path: 'src/result.mjs', startLine: 4, quote: ' ' },
  ]) { f.assessment.citations = [citation]; rejected(f.validate); }
});

test('duplicate and unknown requirement assessments fail closed', (t) => {
  const duplicate = fixture(t); duplicate.input.output.requirementAssessments.push(structuredClone(duplicate.assessment)); rejected(duplicate.validate);
  const unknown = fixture(t); unknown.assessment.requirementId = 'req-unknown'; rejected(unknown.validate);
});

test('AI cannot accept a human requirement even with a genuine source quotation', (t) => {
  const f = fixture(t, { method: 'human' }); rejected(f.validate);
});

test('changed criterion, mismatched check identity and missing check citations are rejected', (t) => {
  const criterion = fixture(t); criterion.assessment.criterion = 'Другой критерий'; rejected(criterion.validate);
  const check = fixture(t, { method: 'check' }); check.assessment.checkIds = ['check-lint']; rejected(check.validate);
  const missing = fixture(t, { method: 'check' }); missing.assessment.citations = []; rejected(missing.validate);
});
