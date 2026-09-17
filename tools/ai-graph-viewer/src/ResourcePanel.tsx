import type { ProofUsage, RequirementProof } from './proof-contracts';

function amount(value: number | null | undefined, currency = false) {
  if (value == null || !Number.isFinite(value)) return 'Нет данных';
  return currency ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value) : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}

export function ResourcePanel({ usage, requirements }: { usage: ProofUsage; requirements: RequirementProof[] }) {
  return <section className="resource-panel" aria-label="Расход ресурсов">
    <h3>Расход на задачу</h3>
    <p>Токены и стоимость отображаются только при наличии данных исполнителя. Неизвестный расход не считается нулевым.</p>
    <dl className="resource-metrics">
      <dt>AI-вызовы</dt><dd>{amount(usage.aiCalls)}</dd>
      <dt>Входные токены</dt><dd>{amount(usage.inputTokens)}</dd>
      <dt>Токены из кеша</dt><dd>{amount(usage.cachedInputTokens)}</dd>
      <dt>Выходные токены</dt><dd>{amount(usage.outputTokens)}</dd>
      <dt>Все токены</dt><dd>{amount(usage.totalTokens)}</dd>
      <dt>Стоимость</dt><dd>{amount(usage.costUsd, true)}</dd>
      <dt>Токены на подтвержденное требование</dt><dd>{amount(usage.tokensPerProvenRequirement)}</dd>
      <dt>Стоимость подтвержденного требования</dt><dd>{amount(usage.costPerProvenRequirement, true)}</dd>
      <dt>AI-вызовы проверки</dt><dd>{amount(usage.verificationCalls)}</dd>
      <dt>AI-вызовы исправления</dt><dd>{amount(usage.repairCalls)}</dd>
      <dt>Переданный контекст</dt><dd>{amount(usage.contextBytes)} байт</dd>
      <dt>Время исполнения</dt><dd>{amount(usage.durationMs / 1000)} с</dd>
    </dl>
    <p>Вызовов с отчетом о расходе: {usage.reportedCalls}. Без полного отчета: {usage.unknownCalls}.</p>
    {usage.byRequirement.length > 0 && <><h3>Расход по требованиям</h3><p>Один вызов может относиться к нескольким требованиям. Эти строки не суммируются в общий расход.</p>
      <div className="resource-table-wrap"><table><thead><tr><th>Требование</th><th>AI-вызовы</th><th>Токены</th><th>Стоимость</th></tr></thead>
        <tbody>{usage.byRequirement.map(row => <tr key={row.requirementId}><th scope="row">{requirements.find(requirement => requirement.id === row.requirementId)?.title ?? row.requirementId}</th><td>{amount(row.aiCalls)}</td><td>{amount(row.totalTokens)}</td><td>{amount(row.costUsd, true)}</td></tr>)}</tbody>
      </table></div></>}
  </section>;
}
