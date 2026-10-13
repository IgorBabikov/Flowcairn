import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { readCitation } from '../scripts/ai-graph/lib/requirement-verification.mjs';
import { resolvePlanReviewCitations, validatePlanCitationResolution, PLAN_CITATION_LIMITS } from '../scripts/ai-graph/lib/plan-citation-resolution.mjs';

function fixture(t, content = 'const x = 1;\n', quote = 'const x = 1;', startLine = 1) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-plan-anchor-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src')); writeFileSync(path.join(root, 'src/file.mjs'), content);
  const hash = hashObject('citation-input'), files = [{ path: 'src/file.mjs', hash: sha256(content), size: Buffer.byteLength(content) }];
  const fingerprint = { hash: hashObject(files), files };
  const output = { summary: 'Согласованность', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [],
    inputHash: hash, reviewEvidenceHash: hash, dimensions: Object.fromEntries(['source','verifier','interfaces','unknowns','capabilities'].map(id => [id, { status: 'pass', reason: 'Соответствует плану.' }])),
    requirementAssessments: [{ requirementId: 'req-001', criterion: 'Исходный критерий', workIds: ['step-one'], checkIds: [], verdict: 'pass',
      citations: [{ path: 'src/file.mjs', quote, startLine }], planReferences: [], reason: 'План сохраняет свойство.' }], unknownAssessments: [] };
  const args = { output, inputHash: hash, node: { resources: { reads: ['src'] } }, worktree: root, fingerprint };
  return { ...args, root, resolve: () => resolvePlanReviewCitations(args) };
}

test('reported exact whole-line source remains strict and preserves model output identity', t => {
  const f = fixture(t), before = structuredClone(f.output), r = f.resolve();
  assert.deepEqual(r.output, before); assert.deepEqual(f.output, before);
  assert.equal(r.resolution.reportedOutputHash, hashObject(before));
  assert.equal(r.resolution.verifiedOutputHash, hashObject(before));
  assert.equal(r.resolution.entries[0].method, 'reported-location');
  assert.equal(validatePlanCitationResolution({ ...f, resolution: r.resolution, output: r.output }).entries.length, 1);
});

test('only leading indentation is canonicalized, with explicit provenance', t => {
  const f = fixture(t, '// header\n\t  const x = 1;\n', 'const x = 1;', 2), r = f.resolve();
  assert.equal(r.output.requirementAssessments[0].citations[0].quote, '\t  const x = 1;');
  assert.equal(r.resolution.entries[0].indentationAdjusted, true);
  assert.notEqual(r.resolution.reportedOutputHash, r.resolution.verifiedOutputHash);
  assert.equal(r.resolution.entries[0].reportedStartLine, 2);
  readCitation(f.root, r.output.requirementAssessments[0].citations[0], f.fingerprint);
});

test('a wrong reported line is resolved only to a unique complete source anchor', t => {
  const f = fixture(t, '// header\n  const x = 1;\n', 'const x = 1;', 99), r = f.resolve();
  assert.equal(r.output.requirementAssessments[0].citations[0].startLine, 2);
  assert.equal(r.resolution.entries[0].reportedStartLine, 99);
  assert.equal(r.resolution.entries[0].verifiedStartLine, 2);
  assert.equal(r.resolution.entries[0].method, 'unique-anchor');
});

test('an explicit matching reported location disambiguates repeated anchors', t => {
  const f = fixture(t, 'const x = 1;\nconst x = 1;\n', 'const x = 1;', 2);
  assert.equal(f.resolve().resolution.entries[0].method, 'reported-location');
});

test('an unlocated duplicated anchor is rejected instead of guessing its function', t => {
  const f = fixture(t, 'const x = 1;\nconst x = 1;\n', 'const x = 1;', 99);
  assert.throws(f.resolve, error => error.code === 'PLAN_REVIEW_INVALID' && error.details.code === 'PLAN_CITATION_AMBIGUOUS');
});

for (const [name, quote] of [
  ['false content', 'const x = 999;'], ['partial substring', 'x = 1;'],
  ['changed internal whitespace', 'const  x = 1;'], ['dropped trailing whitespace', 'const x = 1;'],
  ['ellipsis', 'const ...'],
]) test(`${name} never becomes a verified citation`, t => {
  const f = fixture(t, '  const x = 1;  \n', quote, 1);
  assert.throws(f.resolve, { code: 'PLAN_REVIEW_INVALID' });
});

test('multiline anchors preserve internal whitespace and CRLF source hashing', t => {
  const f = fixture(t, '// header\r\n  function x() {\r\n    return 1;\r\n  }\r\n', 'function x() {\nreturn 1;\n}', 99), r = f.resolve();
  assert.deepEqual(r.output.requirementAssessments[0].citations[0], { path: 'src/file.mjs', startLine: 2, quote: '  function x() {\n    return 1;\n  }' });
  assert.equal(r.resolution.entries[0].sourceHash, f.fingerprint.files[0].hash);
  readCitation(f.root, r.output.requirementAssessments[0].citations[0], f.fingerprint);
});

test('changed bytes reject even when length and the desired anchor still match', t => {
  const f = fixture(t, '// old\nconst x = 1;\n', 'const x = 1;', 2);
  writeFileSync(path.join(f.root, 'src/file.mjs'), '// new\nconst x = 1;\n');
  assert.throws(f.resolve, { code: 'PLAN_REVIEW_INVALID' });
});

test('out-of-context and missing source reject before any location guessing', t => {
  const f = fixture(t); f.node.resources.reads = ['tests'];
  assert.throws(f.resolve, error => error.details.code === 'PLAN_CITATION_SCOPE');
  f.node.resources.reads = ['src']; f.output.requirementAssessments[0].citations[0].path = 'src/missing.mjs';
  assert.throws(f.resolve, error => error.details.code === 'PLAN_CITATION_SOURCE_MISSING');
});

test('symlink and hardlink aliases retain existing source refusal', t => {
  const f = fixture(t), actual = path.join(f.root, 'actual.mjs');
  writeFileSync(actual, 'const x = 1;\n'); rmSync(path.join(f.root, 'src/file.mjs'));
  symlinkSync(actual, path.join(f.root, 'src/file.mjs')); assert.throws(f.resolve, { code: 'PLAN_REVIEW_INVALID' });
  rmSync(path.join(f.root, 'src/file.mjs')); linkSync(actual, path.join(f.root, 'src/file.mjs'));
  assert.throws(f.resolve, { code: 'PLAN_REVIEW_INVALID' });
});

for (const [name, content] of [['invalid UTF-8', Buffer.from([97,10,0xc3,0x28])], ['binary outside anchor', Buffer.from('const x = 1;\n\0')]])
  test(`${name} cannot provide a partial textual pass`, t => {
    const f = fixture(t, content); assert.throws(f.resolve, { code: 'PLAN_REVIEW_INVALID' });
  });

test('bounds refuse full source instead of truncating to a matching prefix', t => {
  const f = fixture(t, 'const x = 1;\n' + ' '.repeat(PLAN_CITATION_LIMITS.fileBytes));
  assert.throws(f.resolve, { code: 'PLAN_REVIEW_INVALID' });
});

test('source anchor is found correctly across scanner and UTF-8 chunk boundaries', t => {
  const f = fixture(t, '// ' + 'а'.repeat(32766) + '\n  const x = 1;\n', 'const x = 1;', 99);
  assert.equal(f.resolve().output.requirementAssessments[0].citations[0].startLine, 2);
});

test('wrong verified output, source hash, indices or input cannot replay host resolution', t => {
  const f = fixture(t), r = f.resolve();
  for (const mutate of [
    x => { x.inputHash = hashObject('wrong'); }, x => { x.verifiedOutputHash = hashObject('wrong'); },
    x => { x.entries[0].sourceHash = hashObject('wrong'); }, x => { x.entries[0].citationIndex = 1; },
    x => { x.entries[0].verifiedStartLine = 2; }, x => { x.entries = []; },
  ]) {
    const resolution = structuredClone(r.resolution); mutate(resolution);
    assert.throws(() => validatePlanCitationResolution({ ...f, output: r.output, resolution }), { code: 'PLAN_REVIEW_INVALID' });
  }
});
