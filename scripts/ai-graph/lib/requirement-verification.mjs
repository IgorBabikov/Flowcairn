import { realpathSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, hashObject } from './io.mjs';
import { RequirementAcceptanceReceiptSchema, RelativePath } from './schemas.mjs';
import { lstatHostSync, crossStatIdentity, sameHostPath } from './host-filesystem.mjs';
import { scanSourceFile } from './source-file-scan.mjs';

const fail = (message) => { throw new GraphError('REQUIREMENT_EVIDENCE_INVALID', message); };
const includesPath = (paths, file) => paths.some((scope) => file === scope.replace(/\/$/, '') || file.startsWith(`${scope.replace(/\/$/, '')}/`));

// Compare only the selected lines while decoding every byte. Memory stays bounded
// by the quote and one scan chunk, even when an unquoted line spans gigabytes.
function citationMatcher(citation) {
  const quote = citation.quote.replace(/\r\n/g, '\n');
  if (!quote.trim()) fail('Пустая цитата не является evidence');
  const endLine = citation.startLine + quote.split('\n').length - 1;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = 1, offset = 0, pendingCR = '';
  const compare = (text) => {
    if (!quote.startsWith(text, offset)) fail('Цитата или номер строки не совпадают с проверенным исходником');
    offset += text.length;
  };
  const consume = (chunk, final = false) => {
    let text;
    try { text = pendingCR + decoder.decode(chunk, { stream: !final }); }
    catch { fail('Цитируемый исходник не является UTF-8 текстом'); }
    pendingCR = '';
    if (text.includes('\0')) fail('Бинарное содержимое не является текстовым evidence');
    if (!final && text.endsWith('\r')) { pendingCR = '\r'; text = text.slice(0, -1); }
    const segments = text.replace(/\r\n/g, '\n').split('\n');
    for (const [index, segment] of segments.entries()) {
      if (line >= citation.startLine && line <= endLine) compare(segment);
      if (index < segments.length - 1) {
        if (line >= citation.startLine && line < endLine) compare('\n');
        line++;
      }
    }
    if (final && (line < endLine || offset !== quote.length))
      fail('Цитата или номер строки не совпадают с проверенным исходником');
  };
  return { update: (chunk) => consume(chunk), finish: () => consume(undefined, true) };
}

// Quotes are evidence only after a complete hash, EOF and path/descriptor check.
function readCitation(worktree, citation, fingerprint) {
  RelativePath.parse(citation.path);
  const expected = fingerprint.files.find((entry) => entry.path === citation.path);
  if (!expected) fail('Цитата не относится к доступному проверенному исходнику');
  const root = realpathSync(worktree);
  const directories = [];
  let absolute = root;
  for (const part of citation.path.split('/')) {
    const stat = lstatHostSync(absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameHostPath(realpathSync(absolute), absolute))
      fail('Цитата не может проходить через symlink');
    directories.push({ path: absolute, identity: crossStatIdentity(stat) });
    absolute = path.join(absolute, part);
  }
  try {
    const stat = lstatHostSync(absolute, { bigint: true });
    if (Number(stat.size) !== expected.size) fail('Исходник цитаты изменился');
    const matcher = citationMatcher(citation);
    const scanned = scanSourceFile(absolute, { expected: stat, classify: false, onChunk: matcher.update });
    matcher.finish();
    if (scanned.size !== expected.size || scanned.hash !== expected.hash)
      fail('Хеш цитируемого исходника не совпадает с проверенным состоянием');
    for (const directory of directories) {
      const current = lstatHostSync(directory.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || crossStatIdentity(current) !== directory.identity ||
          !sameHostPath(realpathSync(directory.path), directory.path)) fail('Путь цитаты изменился во время чтения');
    }
  } catch (error) {
    if (error.code === 'REQUIREMENT_EVIDENCE_INVALID') throw error;
    fail('Не удалось полностью прочитать неизменный исходник цитаты');
  }
}

export function validateRequirementAssessments({ output, plan, node, worktree, fingerprint }) {
  const assessments = output.requirementAssessments ?? [];
  if (!plan.taskContract) {
    if (assessments.length) fail('Результаты требований требуют сохраненного контракта');
    return;
  }
  const seen = new Set();
  for (const assessment of assessments) {
    const requirement = plan.taskContract.requirements.find((item) => item.id === assessment.requirementId);
    if (!requirement || seen.has(requirement.id)) fail('Неизвестное или повторяющееся требование в review');
    seen.add(requirement.id);
    const verification = requirement.verification;
    if (assessment.criterion !== verification.criterion) fail('Review подменяет критерий проверки требования');
    if (hashObject([...assessment.checkIds].sort()) !== hashObject([...verification.checkIds].sort())) fail('Review относится к другим проверкам');
    if (assessment.verdict !== 'pass') continue;
    if (verification.method === 'human') fail('AI не может принять субъективное требование за пользователя');
    if (!assessment.citations.length) fail('Успешное review требования требует проверяемых ссылок на исходники');
    for (const citation of assessment.citations) {
      if (!includesPath(verification.paths, citation.path) || !includesPath(node.resources.reads, citation.path)) fail('Цитата выходит за проверяемую область требования');
      readCitation(worktree, citation, fingerprint);
    }
  }
}

/** A requirement verifier's failure is an execution failure, even if the model's summary says pass. */
export function normalizeRequirementReview(output, contract) {
  if (!contract) return output;
  const required = contract.requirements.filter((item) => item.mandatory && item.verification.method !== 'human');
  const unresolved = required.flatMap((requirement) => {
    const assessment = output.requirementAssessments?.find((item) => item.requirementId === requirement.id);
    return assessment?.verdict === 'pass' ? [] : [{ requirement, assessment }];
  });
  if (!unresolved.length) return output;
  const uncertain = output.verdict === 'uncertain' || unresolved.some((item) => item.assessment?.verdict === 'uncertain');
  const issue = { severity: 'blocking', path: null,
    message: `Не подтверждены требования: ${unresolved.map(({ requirement, assessment }) => `${requirement.id}: ${assessment?.reason || 'отсутствует результат проверки'}`).join('; ')}`.slice(0, 4000) };
  // Keep all existing blocking findings. One bounded aggregate carries coverage failures.
  const findings = output.findings.length < 30 ? [...output.findings, issue]
    : output.findings.some((item) => item.severity !== 'blocking')
      ? [...output.findings.filter((item) => item.severity === 'blocking'), issue].slice(0, 30)
      : output.findings;
  return { ...output, verdict: uncertain ? 'uncertain' : 'fail', findings };
}

export function validateRequirementAcceptances({ state, task, plan, readReceipt }) {
  let previous = null;
  for (const id of state.requirementReceipts ?? []) {
    const receipt = RequirementAcceptanceReceiptSchema.parse(readReceipt(id));
    const requirement = plan.taskContract?.requirements.find((item) => item.id === receipt.requirementId);
    if (hashObject(receipt) !== id || receipt.runId !== state.runId || receipt.planHash !== state.planHash ||
        receipt.taskHash !== state.taskHash || receipt.contractHash !== hashObject(plan.taskContract) ||
        !requirement || requirement.verification.method !== 'human' || receipt.previousReceipt !== previous ||
        state.operations[receipt.operationId]?.status !== 'finished' || !task.goal)
      fail('Ручная приемка не связана с контрактом и управляющей операцией');
    previous = id;
  }
}

export function requirementAcceptanceCapability(state, plan, fingerprint, reason, locked = false) {
  const unavailable = reason || (locked ? 'Другая операция владеет задачей' : null) ||
    (plan.stage === 'planning' ? 'Сначала завершите исполнение' : null) ||
    (state.activeOperation || state.setupPending ? 'Действие еще выполняется' : null) ||
    (state.finalDisposition && state.finalDisposition !== 'accepted' ? 'Эта версия задачи закрыта' : null) ||
    (state.status !== 'passed' ? 'Сначала завершите работу и обязательные проверки' : null) ||
    (!fingerprint || fingerprint.hash !== state.workspaceFingerprint?.hash ? 'Результат изменился; требуется повторная проверка' : null) ||
    (!plan.taskContract?.requirements.some((item) => item.verification.method === 'human') ? 'Нет требований с ручной приемкой' : null);
  return { allowed: !unavailable, reason: unavailable };
}
