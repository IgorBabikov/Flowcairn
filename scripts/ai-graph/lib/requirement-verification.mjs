import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { RequirementAcceptanceReceiptSchema, RelativePath } from './schemas.mjs';

const fail = (message) => { throw new GraphError('REQUIREMENT_EVIDENCE_INVALID', message); };
const includesPath = (paths, file) => paths.some((scope) => file === scope.replace(/\/$/, '') || file.startsWith(`${scope.replace(/\/$/, '')}/`));

// Quotes are evidence only after the host checks the actual bytes in the reviewed snapshot.
function readCitation(worktree, citation, fingerprint) {
  RelativePath.parse(citation.path);
  const expected = fingerprint.files.find((entry) => entry.path === citation.path);
  if (!expected || expected.size > 2 * 1024 * 1024) fail('Цитата не относится к доступному проверенному исходнику');
  const root = realpathSync(worktree);
  let absolute = root;
  for (const part of citation.path.split('/')) {
    absolute = path.join(absolute, part);
    if (lstatSync(absolute).isSymbolicLink()) fail('Цитата не может проходить через symlink');
  }
  if (realpathSync(absolute) !== absolute) fail('Путь цитаты изменился');
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size) fail('Исходник цитаты изменился');
    const bytes = readFileSync(fd);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.hash) fail('Хеш цитируемого исходника не совпадает с проверенным состоянием');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Цитируемый исходник не является UTF-8 текстом'); }
    if (source.includes('\0')) fail('Бинарное содержимое не является текстовым evidence');
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const quote = citation.quote.replace(/\r\n/g, '\n');
    const actual = lines.slice(citation.startLine - 1, citation.startLine - 1 + quote.split('\n').length).join('\n').replace(/\r\n/g, '\n');
    if (!quote.trim() || actual !== quote) fail('Цитата или номер строки не совпадают с проверенным исходником');
  } finally { if (fd !== undefined) closeSync(fd); }
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
