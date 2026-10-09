import type { LessonMaterial, SourceAnchor } from '../contracts';

const originLabels = { 'runtime-evidence': 'Данные запуска', 'test-fixture': 'Данные теста', 'manual-trace': 'Ручная трассировка', 'teaching-example': 'Учебный пример' };
export function LessonExplanation({ lesson, stepIndex, onStep, onAnchor }: {
  lesson: LessonMaterial; stepIndex: number; onStep: (index: number) => void; onAnchor: (anchor: SourceAnchor) => void;
}) {
  const step = lesson.steps[stepIndex];
  if (!step) return <p>Этот шаг отсутствует в сохраненном разборе.</p>;
  return <article className="lesson-explanation">
    <details><summary>Шаг {stepIndex + 1} из {lesson.steps.length} · оглавление</summary><p>{lesson.scope}</p><ol>{lesson.steps.map((item, index) => <li key={item.id}>
      <button className="game-text-action" type="button" aria-current={index === stepIndex ? 'step' : undefined} onClick={() => onStep(index)}>{item.title}</button>
    </li>)}</ol></details>
    <h3>{step.title}</h3>
    <p className="lesson-origin"><strong>{originLabels[step.origin.kind]}</strong> · {step.origin.label}</p>
    <dl><dt>Кто вызывает</dt><dd>{step.caller}</dd><dt>Вход</dt><dd>{step.input}</dd></dl>
    <h4>Преобразования</h4><ol>{step.transformations.map((item, index) => <li key={index}>{item}</li>)}</ol>
    <dl><dt>Выход</dt><dd>{step.output}</dd><dt>Куда дальше</dt><dd>{step.next ?? 'Дальнейший вызов не указан в материале.'}</dd>
      <dt>Зачем это нужно</dt><dd>{step.purpose}</dd><dt>Что изменится при правке</dt><dd>{step.changeConsequence}</dd></dl>
    {step.alternatives.length > 0 && <><h4>Ошибки и альтернативы</h4><ul>{step.alternatives.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    <div className="lesson-anchors">{step.anchors.map((anchor, index) => <button className="game-text-action" type="button" key={`${anchor.sourceId}:${anchor.startLine}:${index}`}
      onClick={() => onAnchor(anchor)}>Исходник · строки {anchor.startLine}–{anchor.endLine}</button>)}</div>
    <div className="lesson-step-controls"><button className="game-secondary" type="button" disabled={stepIndex === 0} onClick={() => onStep(stepIndex - 1)}>Предыдущий шаг разбора</button>
      <button className="game-secondary" type="button" disabled={stepIndex === lesson.steps.length - 1} onClick={() => onStep(stepIndex + 1)}>Следующий шаг разбора</button></div>
    <details><summary>Целый поток выполнения</summary><p>{lesson.wholeFlow}</p></details>
    <details><summary>Выводы и ограничения</summary><ul>{lesson.takeaways.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <ul>{lesson.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>
    {lesson.questions.length > 0 && <details><summary>Вопросы для себя · необязательно</summary><p>Ответы не влияют на продолжение работы и подтверждение кода.</p>
      <ol>{lesson.questions.map(question => <li key={question.id}><p>{question.text}</p>{question.anchors.map((anchor, index) => <button className="game-text-action" type="button"
        key={`${question.id}:${index}`} onClick={() => onAnchor(anchor)}>Посмотреть связанные строки</button>)}</li>)}</ol></details>}
    {(step.origin.receiptId || step.origin.artifactId) && <details><summary>Ссылки на происхождение данных</summary>
      {step.origin.receiptId && <p>Отчет: <code>{step.origin.receiptId}</code></p>}{step.origin.artifactId && <p>Артефакт: <code>{step.origin.artifactId}</code></p>}</details>}
  </article>;
}
