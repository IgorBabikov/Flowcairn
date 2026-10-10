import { useRef, useState } from 'react';
import type { Snapshot } from '../contracts';
import type { WorkflowController } from '../workflow-controller-types';
import { DiagnosticBook } from './DiagnosticBook';
import { RuntimeNotices } from './RuntimeNotices';
import { WorldCanvas, type WorldHandle } from './WorldCanvas';
import type { LocationId } from './world-manifest';
import { GameOverlayHost, type GameSurface } from './GameOverlayHost';
import { GameIcon } from './GameControls';
import { NpcConversation } from './NpcConversation';
import { QuestTracker } from './QuestTracker';
import { QuestIntake } from './QuestIntake';
import { QuestPlan } from './QuestPlan';
import { QuestJournal } from './QuestJournal';
import { QuestClarification } from './QuestClarification';
import { WorldTravelMenu, SettingsMenu } from './GameMenus';
import { LearningStageMap } from '../learning/LearningStageMap';
import { LearningReader, type LearningBinding } from '../learning/LearningReader';
import { learningCapability, learningRun, knownLearningMaterial } from '../learning/learning-projection';

export function RpgShell({ controller: c }: { controller: WorkflowController }) {
  const [localSurface, setSurface] = useState<GameSurface | null>(null);
  const [learningBinding, setLearningBinding] = useState<LearningBinding | null>(null);
  const world = useRef<WorldHandle>(null);
  const surface: GameSurface | null = c.diagnosticsOpen ? 'diagnostics' : localSurface;
  const externalDialog = Boolean(c.showSetup || c.showDraft || c.gate || c.evidence);
  const close = () => {
    if (surface === 'quest' && c.composing && (c.busy || c.pending || c.projectContextRefreshing)) return;
    c.setDiagnosticsOpen(false); setSurface(null); };
  const newQuest = () => { c.setShowCreate(true); setSurface('quest'); };
  const currentQuest = () => { c.setShowCreate(false); setSurface('quest'); };
  const reports = () => { c.setShowCreate(false); c.setDiagnosticPage('result'); c.setDiagnosticsOpen(true); };
  const openLocation = (id: LocationId) => {
    if (id === 'guild') newQuest();
    else setSurface(id === 'archive' ? 'journal' : 'conversation');
  };
  const travel = (id: LocationId) => { world.current?.fastTravel(id); openLocation(id); };
  const openLearning = () => { setSurface('learning-map'); };
  const openMaterial = (runId: string, materialHash: string, predecessors: Snapshot[] = []) => {
    const run = learningRun(c.snapshot);
    const cap = learningCapability(run, 'openLearning');
    const known = run && knownLearningMaterial(run, materialHash, predecessors);
    if (!run || run.runId !== runId || !cap.allowed || c.snapshotUnavailable || !known) {
      c.setNotice(cap.reason || 'Ссылка на материал сейчас недоступна. Обновите состояние.'); return;
    }
    setLearningBinding({ runId, materialHash }); setSurface('codex');
  };
  const title = surface === 'diagnostics' ? 'Книга диагностики' : surface === 'codex' ? 'Сохраненный разбор' : surface === 'learning-map' ? 'Карта разбора' : surface === 'conversation' ? 'Разговор с наставником' : surface === 'journal' ? 'Журнал поручений'
    : surface === 'travel' ? 'Карта' : surface === 'settings' ? 'Служебные записи' : c.clarifying ? 'Уточнить поручение' : c.composing ? 'Новое поручение' : 'План и результат';
  return <main className="rpg-shell" data-testid="rpg-shell" aria-label="Мир Flowcairn">
    <a className="skip-link" href="#game-map-button">Перейти к быстрым переходам</a>
    <WorldCanvas ref={world} paused={Boolean(surface) || externalDialog} snapshot={c.snapshot} snapshotUnavailable={c.snapshotUnavailable} onLocation={openLocation}
      onWorker={(nodeId, sourceRunId) => {
        const id = sourceRunId ? `history-${sourceRunId}-${nodeId}` : nodeId;
        if (c.diagnosticNodes.some(node => node.id === id)) c.selectDiagnosticNode(id);
        else c.setDiagnosticPage('history');
        c.setDiagnosticsOpen(true);
      }} />
    <div className="world-vignette" aria-hidden="true" />
    <header className="game-brand"><GameIcon kind="cairn" /><div><h1>Flowcairn</h1><p>{c.project?.name || 'Гильдия разработчиков'}</p></div></header>
    <QuestTracker controller={c} passive={Boolean(surface) || externalDialog} onLearning={openLearning} onOpen={() => c.snapshot ? currentQuest() : newQuest()} />
    {!surface && <RuntimeNotices controller={c} />}
    <nav className="game-belt" hidden={Boolean(surface) || externalDialog} aria-label="Игровое меню">
      <button type="button" onClick={() => { setSurface('journal'); }}><GameIcon kind="book" />Журнал</button>
      <button id="game-map-button" type="button" onClick={() => { setSurface('travel'); }}><GameIcon kind="map" />Карта</button>
      <button type="button" onClick={() => setSurface('settings')}><GameIcon kind="settings" />Настройки</button>
    </nav>
    <GameOverlayHost surface={surface} suspended={externalDialog} title={title} onClose={close}>
      {surface === 'diagnostics' && <DiagnosticBook controller={c} onClose={close} onQuest={() => { c.setDiagnosticsOpen(false); currentQuest(); }} />}
      {surface === 'conversation' && <NpcConversation controller={c} onPlan={() => c.snapshot ? currentQuest() : newQuest()} onReports={reports} onLearning={openLearning} onClose={close} />}
      {surface === 'quest' && (c.clarifying ? <QuestClarification controller={c} onClose={close} /> : c.composing
        ? <QuestIntake controller={c} onClose={close} /> : <QuestPlan controller={c} onClose={close} onReports={reports}
          onWork={() => { setSurface(null); }} onLearning={openLearning} />)}
      {surface === 'journal' && <QuestJournal controller={c} onClose={close} onNew={newQuest} onOpen={id => { c.selectRun(id); currentQuest(); }} />}
      {surface === 'travel' && <WorldTravelMenu onTravel={travel} onClose={close} />}
      {surface === 'learning-map' && <LearningStageMap controller={c} onOpen={openMaterial} onClose={close} />}
      {surface === 'codex' && learningBinding && <LearningReader key={`${learningBinding.runId}:${learningBinding.materialHash}`} controller={c} binding={learningBinding} onMap={openLearning} onClose={close} />}
      {surface === 'settings' && <SettingsMenu controller={c} onClose={close} />}
    </GameOverlayHost>
  </main>;
}
