import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

function observeReads(t, read, action) {
  const original = fs.readSync;
  const whole = t.mock.method(fs, 'readFileSync', () => assert.fail('Citation verification must not retain a whole source file'));
  const chunk = t.mock.method(fs, 'readSync', (...args) => read(original, args));
  syncBuiltinESMExports();
  try { action(); } finally { chunk.mock.restore(); whole.mock.restore(); syncBuiltinESMExports(); }
}

test('citations beyond 2 MiB stream the complete source including a huge unquoted line', t => {
  const source = `${'x'.repeat(3 * 1024 * 1024)}\nsecond\n${'z'.repeat(2 * 1024 * 1024)}`;
  const f = fixture(t, { source });
  let bytes = 0, eof = false;
  observeReads(t, (read, args) => {
    assert.ok(args[3] <= 64 * 1024);
    const count = read(...args); bytes += count; eof ||= count === 0; return count;
  }, () => assert.doesNotThrow(f.validate));
  assert.equal(bytes, Buffer.byteLength(source));
  assert.equal(eof, true);
  writeFileSync(f.file, `${source.slice(0, -1)}y`);
  rejected(f.validate);
});

test('UTF-8 and CRLF chunk boundaries preserve exact multiline quotations', t => {
  for (const prefix of ['x'.repeat(65534) + '\n', 'x'.repeat(65535) + '\r\n']) {
    const f = fixture(t, { source: `${prefix}Я🙂\r\nконец\r\n` });
    f.assessment.citations[0].quote = 'Я🙂\nконец\n';
    assert.doesNotThrow(f.validate);
    f.assessment.citations[0].quote = 'Я🙂\nконе';
    rejected(f.validate);
  }
  const bom = fixture(t, { source: '\uFEFFfirst\nsecond\r' });
  bom.assessment.citations[0].quote = 'second\r';
  assert.doesNotThrow(bom.validate);
});

test('a short quotation cannot accept a prefix of a huge selected line', t => {
  const f = fixture(t, { source: `first\nsecond${'x'.repeat(3 * 1024 * 1024)}` });
  rejected(f.validate);
});

test('valid quoted lines never hide invalid UTF-8 or binary tails after 2 MiB', t => {
  for (const tail of [Buffer.from([255]), Buffer.from([0xe2, 0x82]), Buffer.from([0])]) {
    const f = fixture(t, { source: Buffer.concat([Buffer.from(`first\nsecond\n${'x'.repeat(3 * 1024 * 1024)}`), tail]) });
    rejected(f.validate);
  }
});

test('a matching quote is rejected on premature EOF or concurrent source changes', t => {
  for (const change of ['early-eof', 'grow', 'truncate', 'replace', 'ancestor']) {
    const source = `first\nsecond\n${'x'.repeat(192 * 1024)}`;
    const f = fixture(t, { source });
    let changed = false;
    observeReads(t, (read, args) => {
      if (changed && change === 'early-eof') return 0;
      const count = read(...args);
      if (!changed && count) {
        changed = true;
        if (change === 'grow') fs.appendFileSync(f.file, 'extra');
        if (change === 'truncate') fs.truncateSync(f.file, 65536);
        if (change === 'replace') { fs.renameSync(f.file, `${f.file}.old`); writeFileSync(f.file, source); }
        if (change === 'ancestor') {
          const parent = path.dirname(f.file), moved = `${parent}-old`;
          fs.renameSync(parent, moved); symlinkSync(moved, parent);
        }
      }
      return count;
    }, () => rejected(f.validate));
    assert.equal(changed, true);
  }
});

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
