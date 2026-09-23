import { useState } from 'react';
import type { Snapshot } from './contracts';
import type { ProofEvidence, ProofFinding, RequirementProof, TaskProof } from './proof-contracts';
import { humanText, nodeTitle, runtimeProblem, technicalProblem } from './presentation';
import { ResourcePanel } from './ResourcePanel';
import { TechnicalDetails } from './TechnicalDetails';

const requirementLabels = { proven: 'Подтверждено', unproven: 'Нужна проверка', stale: 'Нужна перепроверка', failed: 'Проверка не пройдена', blocked: 'Заблокировано' };
const taskLabels = { PROVEN: 'Результат подтвержден', UNPROVEN: 'Результат пока не подтвержден', STALE: 'Нужна повторная проверка', FAILED: 'Проверка не пройдена', BLOCKED: 'Работа заблокирована', RUNNING: 'Работа продолжается' };
const methodLabels: Record<string, string> = { check: 'Выполнение проверки', 'source-review': 'Проверка исходных данных', human: 'Приемка человеком' };
const evidenceLabels = { passed: 'Проверка пройдена', failed: 'Проверка не пройдена', uncertain: 'Результат неоднозначен', unavailable: 'Проверка недоступна' };
const checkLabels: Record<string, string> = { 'check-tests': 'Тесты', 'check-typecheck': 'Проверка типов', 'check-lint': 'Проверка стиля кода', 'check-build': 'Сборка' };
const views = { requirements: 'Требования', evidence: 'Доказательства', changes: 'Изменения', cost: 'Ресурсы' };
type View = keyof typeof views;
type OpenEvidence = (evidence: ProofEvidence, artifactId?: string) => void;

function date(value: string | null) {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'Время не передано';
}

function blockerText(reason: string, proof: TaskProof) {
  if (reason === 'Исполнение находится в состоянии cancelled') return 'Выполнение остановлено пользователем.';
  if (reason === 'Исполнение находится в состоянии failed') return 'Этап завершился с ошибкой; откройте причину выше.';
  if (reason === 'Исполнение находится в состоянии uncertain') return 'Исход этапа не подтвержден; требуется восстановление.';
  const check = /^Обязательная проверка (check-[a-z]+) не подтверждена на текущем результате$/.exec(reason);
  if (check?.[1]) return `${checkLabels[check[1]] ?? 'Проверку'} нужно повторить для текущего состояния файлов.`;
  const requirement = proof.requirements.find(item => reason.startsWith(`${item.id}: `));
  if (requirement) return `${requirement.title}: ${humanText(reason.slice(requirement.id.length + 2))}`;
  return humanText(reason);
}

export function TaskCockpit({ snapshot, busy, unavailable = false, embedded = false, wide = false, onOpenEvidence, onOpenArtifact, onAcceptRequirement }: {
  snapshot: Snapshot;
  busy: boolean;
  unavailable?: boolean;
  embedded?: boolean;
  wide?: boolean;
  onOpenEvidence: OpenEvidence;
  onOpenArtifact: (artifactId: string) => void;
  onAcceptRequirement?: ((requirementId: string, reason: string) => void) | undefined;
}) {
  const proof = snapshot.proof;
  const [view, setView] = useState<View>('requirements');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!proof) return null;
  if (unavailable || !snapshot.integrity.valid) return <section className="task-cockpit" aria-label="Задача и доказательства"><header className="cockpit-header">
    <h2>Актуальность результата не подтверждена</h2>
    <p role="status">Не удалось прочитать текущее состояние задачи. Предыдущие результаты проверок и отчет скрыты до успешного обновления.</p>
  </header></section>;
  const selected = proof.requirements.find(item => item.id === selectedId) ?? proof.requirements.find(item => item.status !== 'proven') ?? proof.requirements[0];
  const proven = snapshot.integrity.valid && proof.status === 'PROVEN';
  const current = snapshot.nodes.find(node => node.id === snapshot.activeNodeId);
  const changes = proof.changedFiles ?? [...new Set(snapshot.nodes.flatMap(node => node.changedFiles))];
  const openFindings = proof.findings.filter(finding => finding.status === 'open');
  const failedNode = snapshot.nodes.find(node => node.status === 'failed');
  const failureSource = snapshot.failureReason || failedNode?.reason;
  const runtimeFailure = snapshot.status === 'failed' ? runtimeProblem(failureSource) : null;
  const diagnostic = runtimeFailure ? technicalProblem(failureSource) : null;
  const selectRequirement = (id: string) => { setSelectedId(id); setView('requirements'); };
  return <section className="task-cockpit" aria-label="Задача и доказательства">
    <header className="cockpit-header">
      {!embedded && <><div className="cockpit-title"><h2>{snapshot.task?.title || proof.contract?.goal || snapshot.task?.goal || 'Задача'}</h2>
        <span className={`proof-status ${proven ? 'is-proven' : ''}`} data-testid="task-proof-status">
          {snapshot.integrity.valid ? taskLabels[proof.status] : 'Целостность данных не подтверждена'}
        </span>
      </div>
      <p>{proof.contract?.goal || snapshot.task?.goal || 'Контракт задачи еще формируется.'}</p></>}
      <div className="coverage-summary">
        <span data-testid="requirement-coverage"><strong>{proof.coverage.proven} из {proof.coverage.required}</strong> обязательных требований подтверждено</span>
        <progress aria-label="Подтвержденные обязательные требования" value={proof.coverage.proven} max={Math.max(proof.coverage.required, 1)} />
      </div>
      {runtimeFailure && <div className="workflow-problem" role="alert">
        <strong>{runtimeFailure.title}</strong>
        <p>{runtimeFailure.summary}</p>
        <p>{runtimeFailure.action}</p>
        {diagnostic && <TechnicalDetails code={diagnostic.code} message={diagnostic.message} />}
      </div>}
      {current && !proven && <p className="cockpit-current"><strong>Сейчас:</strong> {nodeTitle(current, 'ru')}<span>{current.outcome}</span></p>}
      {proof.blockers.length > 0 && <div className="proof-blockers"><strong>Что мешает завершению</strong><ul>{proof.blockers.map((reason, index) => <li key={index}>{blockerText(reason, proof)}</li>)}</ul></div>}
    </header>
    <div className="cockpit-content">
      {proven && proof.certificate && <Certificate expanded={!wide} proof={proof} onSelectRequirement={selectRequirement} />}
      <nav className="cockpit-nav" aria-label="Сведения о задаче">{Object.entries(views).map(([name, label]) =>
        <button type="button" key={name} aria-pressed={view === name} onClick={() => setView(name as View)}>{label}</button>)}</nav>
      {view === 'requirements' && <div className="requirements-layout">
        <section className="requirements-list" aria-label="Требования задачи">
          <h3>Что нужно получить</h3>
          {proof.requirements.length === 0 && <p>Требования еще не сформированы. Выполнение этапов само по себе не доказывает результат.</p>}
          {proof.requirements.map(requirement => <button type="button" key={requirement.id} className="requirement-choice" aria-pressed={selected?.id === requirement.id} onClick={() => setSelectedId(requirement.id)}>
            <span>{requirement.title}</span>
            <small className={`requirement-status status-${requirement.status}`}>{requirementLabels[requirement.status]}{!requirement.mandatory && ' · необязательное'}</small>
          </button>)}
        </section>
        {selected && <RequirementDetails key={`${snapshot.runId}:${selected.id}`} requirement={selected} snapshot={snapshot} busy={busy} onOpenEvidence={onOpenEvidence} onOpenArtifact={onOpenArtifact} onAcceptRequirement={onAcceptRequirement} />}
      </div>}
      {view === 'evidence' && <section className="proof-evidence-list" aria-label="Доказательства задачи"><h3>Проверки и их актуальность</h3>
        {proof.evidence.length === 0 && <p>Проверяемых доказательств пока нет. Успешный этап или сообщение AI не заменяет проверку требования.</p>}
        {proof.evidence.map(evidence => <EvidenceDetails key={evidence.id} evidence={evidence} onOpen={onOpenEvidence} requirements={proof.requirements} onSelectRequirement={selectRequirement} />)}
      </section>}
      {view === 'changes' && <section className="proof-changes"><h3>Результаты работы</h3>
        {snapshot.delivery && <p>{snapshot.delivery.mode === 'direct' ? 'Изменения в текущем проекте' : 'Рабочая копия'}: <code>{snapshot.delivery.workspacePath}</code></p>}
        {changes.length ? <ul className="path-list">{changes.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p>Изменения файлов не зарегистрированы.</p>}
        <h3>Проблемы и исправления</h3>
        {proof.findings.length ? proof.findings.map(finding => <Finding key={finding.id} finding={finding} snapshot={snapshot} />) : <p>Проблемы не зарегистрированы. Это не заменяет проверку требований.</p>}
      </section>}
      {view === 'cost' && <ResourcePanel usage={proof.usage} requirements={proof.requirements} />}
      {view !== 'changes' && openFindings.length > 0 && <section className="open-findings"><h3>Открытые проблемы</h3>{openFindings.map(finding => <Finding key={finding.id} finding={finding} snapshot={snapshot} />)}</section>}
      {proof.contract && <details className="contract-details"><summary>Границы и условия задачи</summary>
        <ContractList title="Разрешенная область" values={proof.contract.scope} />
        <ContractList title="Ограничения" values={proof.contract.constraints} />
        <ContractList title="Предположения" values={proof.contract.assumptions} />
        <ContractList title="Неизвестное" values={proof.contract.unknowns} />
        <ContractList title="Необязательные улучшения" values={proof.contract.optionalImprovements} />
        <ContractList title="Почему выбрана такая проверка" values={proof.contract.rigor.reasons} />
      </details>}
    </div>
  </section>;
}

function RequirementDetails({ requirement, snapshot, busy, onOpenEvidence, onOpenArtifact, onAcceptRequirement }: {
  requirement: RequirementProof;
  snapshot: Snapshot;
  busy: boolean;
  onOpenEvidence: OpenEvidence;
  onOpenArtifact: (artifactId: string) => void;
  onAcceptRequirement?: ((requirementId: string, reason: string) => void) | undefined;
}) {
  const [reason, setReason] = useState('');
  const proof = snapshot.proof!;
  const evidence = proof.evidence.filter(item => requirement.evidenceIds.includes(item.id));
  const work = snapshot.nodes.filter(node => requirement.workNodeIds.includes(node.id));
  const artifacts = work.flatMap(node => node.artifacts).filter((artifact, index, all) => all.findIndex(item => item.id === artifact.id) === index);
  const findings = proof.findings.filter(finding => requirement.findingIds.includes(finding.id));
  const acceptsHuman = requirement.verification.method === 'human' && requirement.status !== 'proven' && onAcceptRequirement && snapshot.integrity.valid && proof.acceptance?.allowed;
  return <section className="requirement-detail" aria-label="Доказательство требования">
    <h3>{requirement.title}</h3>
    <p className={`requirement-status status-${requirement.status}`}>{requirementLabels[requirement.status]}</p>
    {requirement.reason && <p>{humanText(requirement.reason)}</p>}
    <h4>Как проверяется</h4>
    <p>{methodLabels[requirement.verification.method] ?? requirement.verification.method}: {requirement.verification.criterion}</p>
    {requirement.verification.checkIds.length > 0 && <p>Проверки: {requirement.verification.checkIds.map(id => checkLabels[id] ?? id).join(', ')}</p>}
    {requirement.verification.paths.length > 0 && <ul className="path-list">{requirement.verification.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
    <h4>Связанная работа</h4>
    {work.length ? <ul>{work.map(node => <li key={node.id}><strong>{nodeTitle(node, 'ru')}</strong><p>{node.status === 'passed' ? 'Этап завершен. ' : node.status === 'running' ? 'Выполняется. ' : 'Этап еще не завершен. '}{node.outcome}</p></li>)}</ul> : <p>Работа с этим требованием еще не связана.</p>}
    {artifacts.length > 0 && <><h4>Связанные результаты</h4><ul>{artifacts.map(artifact => <li key={artifact.id}><button className="text-button" type="button" onClick={() => onOpenArtifact(artifact.id)}>{artifact.title}</button></li>)}</ul></>}
    <h4>Доказательства</h4>
    {evidence.length ? evidence.map(item => <EvidenceDetails key={item.id} evidence={item} onOpen={onOpenEvidence} />) : <p>Актуального успешного доказательства нет.</p>}
    {findings.map(finding => <Finding key={finding.id} finding={finding} snapshot={snapshot} />)}
    {requirement.verification.method === 'human' && requirement.status !== 'proven' && !proof.acceptance?.allowed && proof.acceptance?.reason && <p>{humanText(proof.acceptance.reason)}</p>}
    {acceptsHuman && <form className="requirement-acceptance" onSubmit={event => { event.preventDefault(); if (reason.trim() && !busy) onAcceptRequirement(requirement.id, reason.trim()); }}>
      <h4>{requirement.verification.method === 'human' ? 'Подтвердить приемку' : 'Подтвердить проверку результата'}</h4>
      <p>Проверьте требование и связанные результаты. Подтверждение будет связано с текущим состоянием результата; после влияющих изменений потребуется новая проверка.</p>
      <label htmlFor={`acceptance-${requirement.id}`}>Что вы проверили и чем подтверждается результат?</label>
      <textarea id={`acceptance-${requirement.id}`} value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} disabled={busy} required />
      <button className="button" type="submit" disabled={busy || !reason.trim()}>Подтверждаю выполнение требования</button>
    </form>}
  </section>;
}

function EvidenceDetails({ evidence, onOpen, requirements, onSelectRequirement }: {
  evidence: ProofEvidence;
  onOpen: OpenEvidence;
  requirements?: RequirementProof[];
  onSelectRequirement?: (id: string) => void;
}) {
  return <article className={`proof-evidence evidence-${evidence.freshness}`}>
    <p className="evidence-verdict"><strong>{evidenceLabels[evidence.status]}</strong><span>{evidence.freshness === 'current' ? 'Актуально' : 'Устарело'}</span></p>
    <p>{humanText(evidence.summary)}</p>
    <p className="evidence-method">{methodLabels[evidence.method] ?? evidence.method} · {date(evidence.checkedAt)}</p>
    {evidence.freshness === 'stale' && <p className="stale-explanation">{humanText(evidence.staleReason) || 'Проверенное состояние изменилось. Это доказательство больше не подтверждает требование.'}</p>}
    {requirements && onSelectRequirement && <ul className="evidence-requirements">{requirements.filter(requirement => evidence.requirementIds.includes(requirement.id)).map(requirement => <li key={requirement.id}><button className="text-button" type="button" onClick={() => onSelectRequirement(requirement.id)}>{requirement.title}</button></li>)}</ul>}
    <div className="evidence-actions">
      {evidence.receiptId && <button type="button" className="button compact" onClick={() => onOpen(evidence)}>Открыть отчет проверки</button>}
      {evidence.artifactIds.map((id, index) => <button type="button" className="button compact" key={id} onClick={() => onOpen(evidence, id)}>Результат {index + 1}</button>)}
    </div>
    <details className="proof-technical"><summary>Проверенное состояние и источник</summary><dl>
      <dt>Состояние результата</dt><dd><code>{evidence.resultHash || 'Не передано'}</code></dd>
      <dt>Доказательство</dt><dd><code>{evidence.id}</code></dd>
      <dt>Запуск</dt><dd><code>{evidence.runId}</code></dd>
      <dt>Работа</dt><dd><code>{evidence.nodeId || 'Приемка требования'}</code></dd>
    </dl></details>
  </article>;
}

function Finding({ finding, snapshot }: { finding: ProofFinding; snapshot: Snapshot }) {
  const repairs = snapshot.nodes.filter(node => finding.repairNodeIds.includes(node.id));
  return <article className="proof-finding"><p><strong>{finding.title}</strong></p>
    <p>{finding.status === 'resolved' ? 'Исправлено и перепроверено' : finding.blocking ? 'Блокирует завершение' : 'Открытое замечание'}</p>
    {repairs.length > 0 && <ul>{repairs.map(node => <li key={node.id}>Исправление: {nodeTitle(node, 'ru')} — {node.outcome}</li>)}</ul>}
  </article>;
}

function Certificate({ proof, onSelectRequirement, expanded }: { proof: TaskProof; onSelectRequirement: (id: string) => void; expanded: boolean }) {
  const certificate = proof.certificate!;
  return <details className="completion-certificate" open={expanded}>
    <summary>Отчет о выполнении</summary>
    <p>Все обязательные требования подтверждены. Здесь собраны результаты проверок и приемки для текущего состояния задачи.</p>
    <ul>{proof.requirements.filter(requirement => certificate.requirementIds.includes(requirement.id)).map(requirement => <li key={requirement.id}><button type="button" className="text-button" onClick={() => onSelectRequirement(requirement.id)}>{requirement.title}</button></li>)}</ul>
    <p>Подтверждено требований: {proof.coverage.proven} / {proof.coverage.required}. Результатов проверок: {certificate.evidenceIds.length}. Блокирующих проблем: {proof.findings.filter(finding => finding.blocking && finding.status === 'open').length}.</p>
    <ContractList title="Известные ограничения" values={certificate.limitations ?? proof.contract?.unknowns ?? []} />
    <details className="proof-technical"><summary>Данные отчета</summary><dl>
      <dt>Создан</dt><dd>{date(certificate.issuedAt)}</dd><dt>Идентификатор</dt><dd><code>{certificate.id}</code></dd>
      <dt>Контракт</dt><dd><code>{certificate.contractHash}</code></dd><dt>Состояние результата</dt><dd><code>{certificate.resultHash}</code></dd>
    </dl></details>
  </details>;
}

function ContractList({ title, values }: { title: string; values: string[] }) {
  return values.length ? <section><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></section> : null;
}
