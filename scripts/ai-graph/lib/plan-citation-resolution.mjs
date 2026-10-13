import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { Hash, RelativePath } from './schemas.mjs';
import { AIPlanReviewResultSchema, PlanReviewCitationSchema } from './semantic-plan-review.mjs';
import { readCitation, scanVerifiedCitationFile } from './requirement-verification.mjs';

export const PLAN_CITATION_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024,
  files: 16, citations: 256, lines: 100000, quoteLines: 128 });
const invalid = (code, message) => { throw new GraphError('PLAN_REVIEW_INVALID', `${code}: ${message}`, { code }); };
const includes = (paths, file) => paths.some(scope => file === scope.replace(/\/$/, '') || file.startsWith(scope.replace(/\/$/, '') + '/'));
const normalizedLine = line => line.replace(/^[ \t]*/, '');
const groups = output => ['requirementAssessments', 'unknownAssessments'].flatMap(group =>
  output[group].flatMap((assessment, assessmentIndex) => assessment.citations.map((citation, citationIndex) => ({
    group, assessmentIndex, citationIndex, citation,
  }))));
export const PlanCitationResolutionSchema = z.strictObject({
  version: z.literal(1), role: z.literal('plan-citation-resolution'), inputHash: Hash,
  reportedOutputHash: Hash, verifiedOutputHash: Hash, fingerprintHash: Hash,
  entries: z.array(z.strictObject({ group: z.enum(['requirementAssessments', 'unknownAssessments']),
    assessmentIndex: z.number().int().min(0), citationIndex: z.number().int().min(0), path: RelativePath,
    sourceHash: Hash, reportedStartLine: z.number().int().min(1), verifiedStartLine: z.number().int().min(1),
    reportedQuoteHash: Hash, verifiedQuoteHash: Hash, method: z.enum(['reported-location', 'unique-anchor']),
    indentationAdjusted: z.boolean(),
  })).max(PLAN_CITATION_LIMITS.citations),
});
export const PlanReviewOutputDigestSchema = z.strictObject({
  version: z.literal(1), role: z.literal('plan-review-output-digest'), inputHash: Hash,
  reportedOutputHash: Hash, fingerprintHash: Hash,
});

// KMP over whole lines bounds searching; internal/trailing bytes are never normalized.
function matches(lines, pattern) {
  const prefix = Array(pattern.length).fill(0), found = [];
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j && pattern[i] !== pattern[j]) j = prefix[j - 1];
    if (pattern[i] === pattern[j]) j++;
    prefix[i] = j;
  }
  for (let i = 0, j = 0; i < lines.length; i++) {
    while (j && lines[i] !== pattern[j]) j = prefix[j - 1];
    if (lines[i] === pattern[j]) j++;
    if (j === pattern.length) {
      found.push(i - pattern.length + 2);
      if (found.length === 2) return found;
      j = prefix[j - 1];
    }
  }
  return found;
}

/** Resolve only exact whole-line anchors in a complete hash-verified authorized source. */
export function resolvePlanReviewCitations({ output, rawOutput = output, inputHash, node, worktree, fingerprint }) {
  const parsed = AIPlanReviewResultSchema.safeParse(output);
  if (!parsed.success || parsed.data.inputHash !== inputHash) invalid('PLAN_CITATION_INPUT', 'Нет bound plan review result.');
  const verified = structuredClone(parsed.data), citations = groups(verified), files = new Map(), entries = [];
  if (citations.length > PLAN_CITATION_LIMITS.citations) invalid('PLAN_CITATION_LIMIT', 'Слишком много source anchors.');
  let totalBytes = 0;
  const source = file => {
    if (!includes(node.resources.reads, file)) invalid('PLAN_CITATION_SCOPE', 'Source anchor вне declared read context.');
    if (files.has(file)) return files.get(file);
    const expected = fingerprint.files.find(entry => entry.path === file);
    if (!expected) invalid('PLAN_CITATION_SOURCE_MISSING', 'Source anchor не существует в проверенном snapshot.');
    if (files.size >= PLAN_CITATION_LIMITS.files || totalBytes + expected.size > PLAN_CITATION_LIMITS.totalBytes)
      invalid('PLAN_CITATION_LIMIT', 'Source anchors превышают общий bounded read.');
    const decoder = new TextDecoder('utf-8', { fatal: true }), text = [];
    try {
      scanVerifiedCitationFile(worktree, file, fingerprint, { maxBytes: PLAN_CITATION_LIMITS.fileBytes,
        onChunk: chunk => { const value = decoder.decode(chunk, { stream: true }); if (value.includes('\0')) throw Error('binary'); text.push(value); },
        onEnd: () => { const tail = decoder.decode(); if (tail.includes('\0')) throw Error('binary'); text.push(tail); } });
    } catch (error) { invalid('PLAN_CITATION_SOURCE_INVALID', error.message); }
    totalBytes += expected.size;
    const lines = text.join('').replace(/\r\n/g, '\n').split('\n');
    if (lines.length > PLAN_CITATION_LIMITS.lines) invalid('PLAN_CITATION_LIMIT', 'Слишком много строк для bounded anchor resolution.');
    const value = { lines, normalized: lines.map(normalizedLine), hash: expected.hash };
    files.set(file, value); return value;
  };
  for (const item of citations) {
    const reported = item.citation, file = source(reported.path);
    const pattern = reported.quote.replace(/\r\n/g, '\n').split('\n').map(normalizedLine);
    if (!reported.quote.trim() || pattern.length > PLAN_CITATION_LIMITS.quoteLines)
      invalid('PLAN_CITATION_LIMIT', 'Пустой или слишком большой source anchor.');
    const atReported = pattern.every((line, index) => file.normalized[reported.startLine - 1 + index] === line);
    const positions = atReported ? [reported.startLine] : matches(file.normalized, pattern);
    if (positions.length !== 1) invalid(positions.length ? 'PLAN_CITATION_AMBIGUOUS' : 'PLAN_CITATION_NOT_FOUND', 'Exact whole-line anchor не имеет однозначного расположения.');
    const canonical = { path: reported.path, startLine: positions[0], quote: file.lines.slice(positions[0] - 1, positions[0] - 1 + pattern.length).join('\n') };
    if (!PlanReviewCitationSchema.safeParse(canonical).success) invalid('PLAN_CITATION_LIMIT', 'Canonical source quote превышает transport bounds.');
    try { readCitation(worktree, canonical, fingerprint); } catch (error) { invalid('PLAN_CITATION_SOURCE_INVALID', error.message); }
    entries.push({ group: item.group, assessmentIndex: item.assessmentIndex, citationIndex: item.citationIndex,
      path: canonical.path, sourceHash: file.hash, reportedStartLine: reported.startLine, verifiedStartLine: canonical.startLine,
      reportedQuoteHash: sha256(reported.quote), verifiedQuoteHash: sha256(canonical.quote),
      method: atReported ? 'reported-location' : 'unique-anchor', indentationAdjusted: reported.quote.replace(/\r\n/g, '\n') !== canonical.quote });
    verified[item.group][item.assessmentIndex].citations[item.citationIndex] = canonical;
  }
  const resolution = { version: 1, role: 'plan-citation-resolution', inputHash,
    reportedOutputHash: hashObject(rawOutput), verifiedOutputHash: hashObject(verified), fingerprintHash: fingerprint.hash, entries };
  return { output: verified, resolution: PlanCitationResolutionSchema.parse(resolution) };
}

/** Host normalization is separate evidence, never a claim that the model supplied correct lines. */
export function validatePlanCitationResolution({ output, resolution, inputHash, fingerprint }) {
  const parsed = PlanCitationResolutionSchema.safeParse(resolution);
  if (!parsed.success || parsed.data.inputHash !== inputHash || parsed.data.fingerprintHash !== fingerprint.hash ||
      parsed.data.verifiedOutputHash !== hashObject(output)) invalid('PLAN_CITATION_RESOLUTION_BINDING', 'Host resolution не относится к этому verified result/input/source.');
  const expected = groups(output), entries = parsed.data.entries;
  if (entries.length !== expected.length || entries.some((entry, i) => {
    const item = expected[i];
    return entry.group !== item.group || entry.assessmentIndex !== item.assessmentIndex || entry.citationIndex !== item.citationIndex ||
      entry.path !== item.citation.path || entry.verifiedStartLine !== item.citation.startLine || entry.verifiedQuoteHash !== sha256(item.citation.quote) ||
      entry.sourceHash !== fingerprint.files.find(file => file.path === entry.path)?.hash ||
      (entry.method === 'reported-location') !== (entry.reportedStartLine === entry.verifiedStartLine);
  })) invalid('PLAN_CITATION_RESOLUTION_BINDING', 'Host resolution не покрывает canonical citations ровно один раз.');
  return parsed.data;
}
