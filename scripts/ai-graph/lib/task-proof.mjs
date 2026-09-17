import { hashObject } from './io.mjs';

const unique = (items) => [...new Set(items)];
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (left, right) => hashObject(left) === hashObject(right);
const contained = (file, scope) => file === scope.replace(/\/$/, '') || file.startsWith(`${scope.replace(/\/$/, '')}/`);
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const terminal = (receipt) => receipt.phase === 'finished' && receipt.exitCode === 0 && receipt.termination?.stopped === true && receipt.termination.uncertain === false;
const checkName = (definition) => definition.action.id;
const requirementMeaning = ({ id, title, mandatory, verification }) => ({ id, title, mandatory, verification });

function artifactDigest(artifact) {
  const { content, ...metadata } = artifact;
  const parts = [];
  for (let offset = 0; offset < content.length; offset += 8000) parts.push(content.slice(offset, offset + 8000));
  return hashObject({ ...metadata, parts });
}

/** The store and service own state. This projection only derives conclusions from immutable objects. */
/** @param {{state:any,task:any,plan:any,currentFingerprint:any,currentReason?:string|null,readReceipt:Function,readArtifact:Function,previousExecutions?:any[]}} input */
export function deriveTaskProof({ state, task, plan, currentFingerprint, currentReason = null, readReceipt, readArtifact, previousExecutions = [] }) {
  const contract = plan.taskContract ?? null;
  const definitions = contract?.requirements ?? [];
  const required = definitions.filter((item) => item.mandatory);
  const blockers = [];
  const currentHash = hash(currentFingerprint?.hash) ? currentFingerprint.hash : null;
  if (!contract || contract.version !== 1 || !definitions.length) blockers.push('Контракт требований еще не сформирован');
  if (contract && (contract.goal !== task.goal || contract.instructionsHash !== hashObject(task.instructions))) blockers.push('Контракт не соответствует исходной цели и инструкциям задачи');
  if (!required.length) blockers.push('Нет обязательных требований для подтверждения');
  if (new Set(definitions.map((item) => item.id)).size !== definitions.length) blockers.push('Идентификаторы требований повторяются');
  if (!currentHash) blockers.push('Текущее состояние результата не подтверждено');
  if (currentReason) blockers.push(currentReason);
  if (plan.stage === 'planning') blockers.push('Планирование еще не завершено');
  if (state.finalDisposition === 'superseded' || state.finalDisposition === 'rejected') blockers.push('Эта версия задачи закрыта без подтверждения результата');

  const evidence = [], findings = [], records = [];
  const artifactCache = new Map();
  const executions = [...previousExecutions, { state, task, plan }];
  const currentExecution = executions.length - 1;
  const readArtifactData = (id) => {
    if (artifactCache.has(id)) return artifactCache.get(id);
    const artifact = readArtifact(id);
    if (!artifact || typeof artifact.content !== 'string' || artifactDigest(artifact) !== id) throw new Error('Artifact integrity');
    const item = { artifact, data: artifact.mediaType === 'application/json' ? JSON.parse(artifact.content) : null };
    artifactCache.set(id, item);
    return item;
  };
  for (const [executionIndex, execution] of executions.entries()) {
    for (const definition of execution.plan.nodes) {
      const actual = execution.state.nodes[definition.id];
      if (!actual) { blockers.push(`Отсутствует состояние работы ${definition.id}`); continue; }
      for (const receiptId of actual.receipts) {
        try {
          const receipt = readReceipt(receiptId);
          if (hashObject(receipt) !== receiptId || receipt.runId !== execution.state.runId || receipt.nodeId !== definition.id ||
              receipt.taskHash !== execution.state.taskHash || receipt.planHash !== execution.state.planHash ||
              receipt.actionId !== definition.action.id || receipt.actionVersion !== definition.action.version ||
              receipt.planVersion !== execution.plan.version) throw new Error('Receipt integrity');
          if (!['finished', 'gate'].includes(receipt.phase)) continue;
          const artifacts = receipt.artifacts.map((id) => ({ id, ...readArtifactData(id) }));
          records.push({ receiptId, receipt, definition, actual, execution, executionIndex, artifacts, order: records.length });
        } catch {
          blockers.push(`Доказательство работы ${definition.id} повреждено или недоступно`);
        }
      }
    }
  }
  const related = (record) => definitions.filter((requirement) => {
    const original = record.execution.plan.taskContract?.requirements.find((item) => item.id === requirement.id);
    return original && same(requirementMeaning(original), requirementMeaning(requirement));
  });
  const addEvidence = (record, requirementIds, method, verdict, summary, artifactIds = record.receipt.artifacts, suffix = '') => {
    const resultHash = record.receipt.afterFingerprint ?? record.receipt.beforeFingerprint ?? null;
    const fresh = Boolean(currentHash && resultHash === currentHash && record.receipt.beforeFingerprint === resultHash && !currentReason);
    const item = {
      id: hashObject({ receiptId: record.receiptId, requirementIds, method, suffix }), requirementIds,
      nodeId: record.definition.id, runId: record.execution.state.runId, receiptId: record.receiptId,
      artifactIds, method, summary, status: verdict, freshness: fresh ? 'current' : 'stale',
      checkedAt: record.receipt.finishedAt, resultHash,
      staleReason: fresh ? null : currentReason || (!currentHash ? 'Текущее состояние результата недоступно' : 'Результат изменился после проверки'),
    };
    evidence.push(item);
    return item;
  };
  const addFinding = (record, requirementIds, title, blocking, suffix) => {
    const item = { id: hashObject({ receiptId: record.receiptId, suffix }), requirementIds, title, blocking, status: 'open', repairNodeIds: [] };
    findings.push({ ...item, order: record.order, runId: record.execution.state.runId });
  };
  const checkRecords = [], assessments = [], acceptances = [];
  for (const record of records) {
    const { receipt, definition, artifacts } = record;
    const compatible = related(record);
    const assessmentIds = new Set();
    if (definition.action.id.startsWith('check-')) {
      const requirementIds = compatible.filter((item) => item.verification.checkIds.includes(checkName(definition))).map((item) => item.id);
      const check = receipt.checks.find((item) => item.id === definition.id);
      const passed = terminal(receipt) && receipt.verdict === 'pass' && check?.passed === true && check.exitCode === 0 &&
        check.inputHash === receipt.beforeFingerprint && receipt.afterFingerprint === receipt.beforeFingerprint;
      const failed = receipt.verdict === 'fail' && receipt.termination?.stopped === true && receipt.termination.uncertain === false &&
        check?.passed === false && check.exitCode !== null && check.exitCode !== 0;
      const item = addEvidence(record, requirementIds, 'check', passed ? 'passed' : failed ? 'failed' : 'unavailable', check?.summary || receipt.failureReason || 'Проверка не предоставила подтвержденный результат');
      checkRecords.push({ record, item, checkId: checkName(definition) });
      if (failed) addFinding(record, requirementIds.length ? requirementIds : required.map((item) => item.id), item.summary, true, 'failed-check');
    }
    for (const artifact of artifacts) {
      if (['review-findings', 'analysis'].includes(artifact.artifact.kind) && artifact.data) {
        const output = artifact.data;
        for (const [index, finding] of (output.findings ?? []).entries()) {
          const explicit = finding.requirementIds?.filter((id) => compatible.some((item) => item.id === id));
          const scoped = finding.path ? compatible.filter((item) => item.verification.paths.some((scope) => contained(finding.path, scope))).map((item) => item.id) : [];
          addFinding(record, explicit?.length ? explicit : scoped.length ? scoped : required.map((item) => item.id), finding.message, finding.severity === 'blocking', `${artifact.id}-${index}`);
        }
        if (definition.action.id !== 'ai-review' || artifact.artifact.kind !== 'review-findings') continue;
        const verifiedReview = terminal(receipt) && hash(receipt.reviewEvidenceHash) && output.reviewEvidenceHash === receipt.reviewEvidenceHash &&
          receipt.beforeFingerprint === receipt.afterFingerprint;
        for (const assessment of output.requirementAssessments ?? []) {
          const requirement = compatible.find((item) => item.id === assessment.requirementId);
          if (!requirement) {
            // Old contracts can legitimately have different verifier bindings; unknown IDs cannot.
            if (!record.execution.plan.taskContract?.requirements.some((item) => item.id === assessment.requirementId)) blockers.push('Review содержит неизвестное требование');
            continue;
          }
          const duplicate = assessmentIds.has(requirement.id); assessmentIds.add(requirement.id);
          if (duplicate) blockers.push(`Review содержит повторяющееся требование ${requirement.id}`);
          const verification = requirement.verification;
          const citations = assessment.citations ?? [];
          const validCitations = citations.length > 0 && citations.every((citation) => typeof citation.quote === 'string' && citation.quote.length > 0 && Number.isInteger(citation.startLine) && citation.startLine > 0 &&
            verification.paths.some((scope) => contained(citation.path, scope)));
          const valid = verifiedReview && !duplicate && assessment.criterion === verification.criterion &&
            same([...(assessment.checkIds ?? [])].sort(), [...verification.checkIds].sort()) &&
            validCitations;
          const passed = valid && receipt.verdict === 'pass' && output.verdict === 'pass' && assessment.verdict === 'pass';
          const failed = valid && assessment.verdict === 'fail';
          const item = addEvidence(record, [requirement.id], 'source-review', passed ? 'passed' : failed ? 'failed' : 'uncertain', assessment.reason || 'Оценка требования не подтверждена', [artifact.id], requirement.id);
          assessments.push({ record, item, requirementId: requirement.id });
          if (failed) addFinding(record, [requirement.id], assessment.reason || `Требование ${requirement.id} не прошло проверку`, requirement.mandatory, `assessment-${requirement.id}`);
        }
      }
    }
  }
  for (const [executionIndex, execution] of executions.entries()) {
    const humanReceipts = execution.state.requirementReceipts ?? [];
    for (const [receiptIndex, receiptId] of humanReceipts.entries()) {
      try {
        const receipt = readReceipt(receiptId);
        const requirement = definitions.find((item) => item.id === receipt.requirementId && item.verification.method === 'human');
        if (hashObject(receipt) !== receiptId || receipt.phase !== 'requirement' || receipt.runId !== execution.state.runId ||
            receipt.taskHash !== execution.state.taskHash || receipt.planHash !== execution.state.planHash ||
            receipt.contractHash !== hashObject(execution.plan.taskContract)) throw new Error('Requirement receipt integrity');
        if (!requirement || receipt.contractHash !== hashObject(contract)) continue;
        const executionEnd = records.filter((item) => item.executionIndex <= executionIndex).at(-1)?.order ?? -1;
        const record = { receiptId, receipt: { ...receipt, beforeFingerprint: receipt.resultHash, afterFingerprint: receipt.resultHash, finishedAt: receipt.acceptedAt },
          definition: { id: `accept-${requirement.id}` }, execution, order: executionEnd + (receiptIndex + 1) / (humanReceipts.length + 1) };
        const item = addEvidence(record, [requirement.id], 'human', receipt.decision === 'accept' && typeof receipt.actor === 'string' && hash(receipt.resultHash) ? 'passed' : 'uncertain', receipt.reason || 'Личная приемка требования', receipt.artifacts ?? []);
        acceptances.push({ record, item });
      } catch { blockers.push('Личная приемка повреждена или недоступна'); }
    }
  }
  const latest = (items) => items.at(-1);
  const successful = (entry) => entry?.item.status === 'passed' && entry.item.freshness === 'current';
  const requirements = definitions.map((requirement) => {
    const workNodeIds = requirement.workIds ?? [];
    const work = workNodeIds.map((id) => latest(records.filter((record) => record.executionIndex === currentExecution && record.definition.id === id && record.definition.action.id === 'ai-implement')));
    const workComplete = work.length > 0 && work.every((record) => record && terminal(record.receipt) && record.receipt.verdict === 'pass' && record.actual.status === 'passed');
    const assessment = latest(assessments.filter((entry) => entry.requirementId === requirement.id));
    const checks = requirement.verification.checkIds.map((id) => latest(checkRecords.filter((entry) => entry.checkId === id && entry.item.requirementIds.includes(requirement.id))));
    const acceptance = latest(acceptances.filter((entry) => entry.item.requirementIds.includes(requirement.id)));
    const selected = requirement.verification.method === 'human' ? [acceptance] : [assessment, ...(requirement.verification.method === 'check' ? checks : [])];
    const validPath = ['source-review', 'human'].includes(requirement.verification.method) || (requirement.verification.method === 'check' && checks.length > 0);
    const verified = validPath && selected.length > 0 && selected.every(successful);
    // A new generic check cannot close a later semantic finding using an older requirement review.
    const resolutionOrder = verified ? Math.min(...selected.map((entry) => entry.record.order)) : -1;
    const relevantFindings = findings.filter((item) => item.requirementIds.includes(requirement.id));
    const relatedEvidence = evidence.filter((item) => item.requirementIds.includes(requirement.id));
    return { ...requirement, workNodeIds, artifactIds: unique([...relatedEvidence.flatMap((item) => item.artifactIds), ...work.flatMap((record) => record?.receipt.artifacts ?? [])]),
      evidenceIds: relatedEvidence.map((item) => item.id), findingIds: relevantFindings.map((item) => item.id),
      status: verified && workComplete ? 'proven' : !validPath || !workNodeIds.length ? 'blocked' : selected.some((entry) => entry?.item.status === 'failed') ? 'failed' :
        selected.some((entry) => entry?.item.freshness === 'stale') ? 'stale' : 'unproven',
      reason: verified && workComplete ? 'Есть актуальные доказательства и выполненная работа' : !workComplete ? 'Не подтверждено выполнение всей связанной работы' :
        !validPath ? 'Нет допустимого способа проверки' : 'Нужна актуальная успешная проверка требования',
      resolutionOrder, selected,
    };
  });
  for (const finding of findings) {
    const affected = requirements.filter((item) => finding.requirementIds.includes(item.id));
    if (affected.length && affected.every((item) => item.resolutionOrder > finding.order)) {
      finding.status = 'resolved';
      finding.repairNodeIds = unique(affected.flatMap((item) => item.workNodeIds));
    }
  }
  for (const requirement of requirements) {
    if (findings.some((item) => item.blocking && item.status === 'open' && item.requirementIds.includes(requirement.id))) {
      requirement.status = 'failed'; requirement.reason = 'Есть открытое блокирующее замечание';
    }
  }
  const requiredCheckIds = unique([...(task.checks ?? []).map((id) => id.startsWith('check-') ? id : `check-${id}`), ...plan.nodes.filter((node) => node.action.id.startsWith('check-')).map(checkName)]);
  for (const id of requiredCheckIds) {
    const entry = latest(checkRecords.filter((item) => item.checkId === id && item.record.executionIndex === currentExecution));
    if (!successful(entry)) blockers.push(`Обязательная проверка ${id} не подтверждена на текущем результате`);
  }
  for (const item of requirements.filter((item) => item.mandatory && item.status !== 'proven')) blockers.push(`${item.id}: ${item.reason}`);
  if (findings.some((item) => item.blocking && item.status === 'open')) blockers.push('Есть открытые блокирующие замечания');
  if (['failed', 'uncertain', 'stale'].includes(state.status)) blockers.push(`Исполнение находится в состоянии ${state.status}`);
  if (state.activeOperation || Object.values(state.nodes).some((node) => ['ready', 'pending', 'running', 'waiting-for-human'].includes(node.status))) blockers.push('Выполнение обязательной работы еще не завершено');
  const coverage = { required: required.length, proven: requirements.filter((item) => item.mandatory && item.status === 'proven').length };
  const proven = blockers.length === 0 && coverage.required > 0 && coverage.required === coverage.proven;
  const status = proven ? 'PROVEN' : state.activeOperation || state.status === 'running' ? 'RUNNING' :
    requirements.some((item) => item.status === 'failed') || state.status === 'failed' ? 'FAILED' :
      requirements.some((item) => item.status === 'stale') || state.status === 'stale' ? 'STALE' :
        currentReason || !currentHash || !contract || requirements.some((item) => item.status === 'blocked') ? 'BLOCKED' : 'UNPROVEN';
  const usage = deriveUsage(records, requirements, coverage.proven);
  let certificate = null;
  if (proven) {
    const proofEvidence = unique([...requirements.filter((item) => item.mandatory).flatMap((item) => item.selected.map((entry) => entry.item.id)),
      ...requiredCheckIds.map((id) => latest(checkRecords.filter((item) => item.checkId === id && item.record.executionIndex === currentExecution)).item.id)]);
    const items = evidence.filter((item) => proofEvidence.includes(item.id));
    const body = { version: 1, status: 'PROVEN', taskId: task.id, goal: contract.goal, contractHash: hashObject(contract), resultHash: currentHash,
      coverage,
      requirements: requirements.filter((item) => item.mandatory).map((item) => ({ id: item.id, title: item.title,
        method: item.verification.method, evidenceIds: item.selected.map((entry) => entry.item.id) })),
      verifications: items.map((item) => ({ id: item.id, method: item.method, summary: item.summary,
        checkedAt: item.checkedAt, resultHash: item.resultHash, receiptId: item.receiptId })),
      blockingFindings: [],
      changedFiles: unique(records.flatMap((record) => record.receipt.changedFiles ?? [])),
      artifactIds: unique(requirements.filter((item) => item.mandatory).flatMap((item) => item.artifactIds)),
      limitations: unique([...(contract.unknowns ?? []),
        ...(requirements.some((item) => item.verification.method === 'human') ? ['Часть требований подтверждена личной приемкой оператора'] : []),
        ...(requirements.some((item) => item.verification.method === 'source-review') ? ['Проверка исходников подтверждает наблюдаемые в коде свойства; запуск браузера или production из нее не следует'] : [])]),
      requirementIds: required.map((item) => item.id), evidenceIds: proofEvidence, receiptIds: unique(items.map((item) => item.receiptId)),
      issuedAt: items.map((item) => item.checkedAt).sort().at(-1) ?? null };
    certificate = { ...body, id: hashObject(body) };
  }
  return { contract, requirements: requirements.map(({ resolutionOrder: _, selected: __, ...item }) => item), evidence,
    findings: findings.map(({ order: _, runId: __, ...item }) => item), coverage, status, blockers: unique(blockers), certificate, usage,
    changedFiles: unique(records.flatMap((record) => record.receipt.changedFiles ?? [])) };
}

/** @param {any[]} records @param {any[]} requirements */
function deriveUsage(records, requirements, provenCount) {
  const calls = records.filter((record) => record.receipt.phase === 'finished' && record.definition.action.id.startsWith('ai-'));
  const reported = (record) => record.receipt.termination?.execution?.usage?.source === 'provider' ? record.receipt.termination.execution.usage : null;
  const aggregate = (subset, key) => subset.length > 0 && subset.every((record) => number(reported(record)?.[key]))
    ? subset.reduce((sum, record) => sum + reported(record)[key], 0) : null;
  const totalTokens = aggregate(calls, 'totalTokens'), costUsd = aggregate(calls, 'costUsd');
  const contexts = calls.map((record) => record.receipt.termination?.execution?.context);
  return { aiCalls: calls.length, reportedCalls: calls.filter((record) => reported(record)).length,
    unknownCalls: calls.filter((record) => !reported(record)).length,
    inputTokens: aggregate(calls, 'inputTokens'), cachedInputTokens: aggregate(calls, 'cachedInputTokens'),
    outputTokens: aggregate(calls, 'outputTokens'), totalTokens, costUsd,
    tokensPerProvenRequirement: provenCount > 0 && totalTokens !== null ? totalTokens / provenCount : null,
    costPerProvenRequirement: provenCount > 0 && costUsd !== null ? costUsd / provenCount : null,
    contextBytes: contexts.length && contexts.every((context) => number(context?.bytes ?? context?.promptBytes))
      ? contexts.reduce((sum, context) => sum + (context.bytes ?? context.promptBytes), 0) : null,
    durationMs: records.reduce((sum, record) => sum + (number(record.receipt.durationMs) ? record.receipt.durationMs : 0), 0),
    repairCalls: calls.filter((record) => record.execution.state.policyGrant?.cycle > 0).length,
    verificationCalls: calls.filter((record) => record.definition.action.id === 'ai-review').length,
    byRequirement: requirements.map((requirement) => {
      const subset = calls.filter((record) => record.execution.plan.taskContract?.requirements.some((item) => item.id === requirement.id && item.workIds.includes(record.definition.id)) ||
        record.receipt.termination?.execution?.context?.requirementIds?.includes(requirement.id) ||
        record.artifacts.some((artifact) => artifact.data?.requirementAssessments?.some((assessment) => assessment.requirementId === requirement.id)));
      return { requirementId: requirement.id, aiCalls: subset.length, inputTokens: aggregate(subset, 'inputTokens'),
        outputTokens: aggregate(subset, 'outputTokens'), totalTokens: aggregate(subset, 'totalTokens'), costUsd: aggregate(subset, 'costUsd') };
    }) };
}
