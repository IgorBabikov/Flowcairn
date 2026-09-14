import { useEffect, useState } from 'react';
import { api } from './api';
import type { OnboardingStatus } from './contracts';

export function SetupPanel({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.onboarding().then(value => { if (active) setSetup(value); })
      .catch(() => { if (active) setError('Настройки недоступны. Перезапустите Flowcairn и повторите.'); });
    return () => { active = false; };
  }, []);
  const values = setup?.values;
  return <section className="setup-panel" aria-labelledby="setup-title">
    <header><h2 id="setup-title">Настройки проекта</h2><button type="button" className="button quiet" onClick={onClose}>Закрыть настройки</button></header>
    {!setup && !error && <p role="status">Загружаем настройки…</p>}
    {error && <p role="alert">{error}</p>}
    {setup && values && <>
      <p>{setup.configured ? 'Первоначальная настройка завершена.' : 'Перед первой задачей завершите настройку.'}</p>
      <dl className="fact-list">
        <dt>AI-инструмент</dt><dd>{setup.providers.find(item => item.id === values.provider)?.label ?? values.provider}</dd>
        <dt>Выбор модели</dt><dd>{values.modelMode === 'manual' ? 'Ручной' : 'Автоматический'}</dd>
        <dt>Модель</dt><dd>{values.model || 'Не указана'}</dd>
        <dt>Усиление</dt><dd>{values.reasoningEffort || 'Настройки AI-инструмента'}</dd>
        <dt>Тесты</dt><dd>{values.testPolicy === 'add' ? 'Добавлять тесты по задаче' : 'Следовать правилам проекта'}</dd>
        <dt>Покрытие</dt><dd>{values.coverage ? 'Включено' : 'Не навязывается'}</dd>
        <dt>Контекст для AI</dt><dd>{values.readConsent ? 'Разрешен при настройке' : 'Требуется согласие'}</dd>
      </dl>
      {setup.limitations.length > 0 && <ul>{setup.limitations.map(item => <li key={item}>{item}</li>)}</ul>}
    </>}
    <p>Для настройки закройте интерфейс, остановите Flowcairn в терминале и выполните:</p>
    <code className="setup-command">npx flowcairn setup</code>
    <p>Существующие инструкции проекта сохраняются. Настройки выполняющихся задач не меняются.</p>
  </section>;
}
