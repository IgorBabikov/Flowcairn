import type { WorkflowController } from '../workflow-controller-types';
import { CloseObject } from './GameControls';
import { LOCATION_LABELS, type LocationId } from './world-manifest';

export function WorldTravelMenu({ onTravel, onClose }: { onTravel: (id: LocationId) => void; onClose: () => void }) {
  return <section className="game-menu"><CloseObject label="Закрыть карту" onClose={onClose} />
    <h2 data-overlay-heading tabIndex={-1}>Куда отправимся?</h2><p>Можно перейти сразу, без ходьбы.</p>
    {(Object.keys(LOCATION_LABELS) as LocationId[]).map(id => <button className="game-menu-link" type="button" key={id} onClick={() => onTravel(id)}>{LOCATION_LABELS[id]}</button>)}
  </section>;
}
export function SettingsMenu({ controller: c, onClose }: { controller: WorkflowController; onClose: () => void }) {
  return <section className="game-menu"><CloseObject label="Закрыть меню" onClose={onClose} />
    <h2 data-overlay-heading tabIndex={-1}>Служебные записи</h2>
    <button className="game-menu-link" type="button" onClick={() => c.setShowSetup(true)}>Настройки проекта</button>
    <button className="game-menu-link" type="button" onClick={() => { c.setShowCreate(false); c.setDiagnosticsOpen(true); c.setDiagnosticPage('nodes'); }}>Книга диагностики</button>
    <button className="game-menu-link" type="button" onClick={() => c.setLocale(c.locale === 'ru' ? 'en' : 'ru')}>{c.labels.language}</button>
    <button className="game-menu-link" type="button" onClick={() => document.documentElement.toggleAttribute('data-dark')}>{c.labels.theme}</button>
    <a className="game-menu-link" href="https://t.me/Babikov_build" target="_blank" rel="noreferrer">Telegram автора · внешняя ссылка</a>
    <details><summary>Связь с сервисом</summary><p>{c.streamConnected ? 'Соединение с локальным сервисом установлено.' : 'Состояние обновляется отдельными запросами.'}</p></details>
  </section>;
}
