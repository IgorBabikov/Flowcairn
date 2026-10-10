import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { Snapshot } from '../contracts';
import { loadWorldManifest, type LocationId, type WorldManifest } from './world-manifest';
import { createWorldScene, type WorldScene } from './world-scene';
import type { Camera, Point } from './world-navigation';
import { projectWorldExecution } from './world-execution';
import { actorAssignments, GUILD_LABELS, workerReply } from './guild-presentation';
import type { GuildRole } from './guild-manifest';

export type WorldHandle = { fastTravel: (location: LocationId) => void };
const destinations: Record<GuildRole, LocationId> = { analyst: 'guild', mage: 'workshop', checker: 'archive', reviewer: 'archive', mentor: 'mentor' };
export function WorldCanvas({ paused, snapshot, snapshotUnavailable, onLocation, onWorker, ref }: {
  paused: boolean; snapshot: Snapshot | null; snapshotUnavailable: boolean;
  onLocation: (location: LocationId) => void; onWorker: (nodeId: string, sourceRunId: string | null) => void; ref: Ref<WorldHandle>;
}) {
  const host = useRef<HTMLDivElement>(null), scene = useRef<WorldScene | null>(null);
  const labels = useRef(new Map<string, HTMLDivElement>()), positions = useRef(new Map<string, Point>());
  const callbacks = useRef({ paused, snapshot, snapshotUnavailable, onLocation });
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState('Загружаем мастерскую гильдии…');
  const [attempt, setAttempt] = useState(0);
  const view = useMemo(() => projectWorldExecution(snapshot, { connected: !snapshotUnavailable, snapshotUnavailable }), [snapshot, snapshotUnavailable]);
  const assignments = actorAssignments(view);
  const labelOffset = (id: string) => assignments.find(item => item.id === id)?.role === 'checker' ? 55 : -180;
  useEffect(() => { callbacks.current = { paused, snapshot, snapshotUnavailable, onLocation }; }, [paused, snapshot, snapshotUnavailable, onLocation]);
  useEffect(() => { scene.current?.setPaused(paused); }, [paused]);
  useEffect(() => { scene.current?.setSnapshot(snapshot, { connected: !snapshotUnavailable, snapshotUnavailable }); }, [snapshot, snapshotUnavailable]);
  useImperativeHandle(ref, () => ({ fastTravel: id => scene.current?.fastTravel(id) }), []);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController(); let current: WorldScene | null = null;
    const watchdog = window.setTimeout(() => {
      if (!disposed) { current?.destroy(); setState('failed'); setMessage('Загрузка сцены заняла слишком много времени. Книги доступны через меню.'); }
    }, 30000);
    const labelPosition = (id: string, position: Point | null) => {
      if (!position) { positions.current.delete(id); return; }
      positions.current.set(id, position);
      const element = labels.current.get(id), value = camera.current;
      if (element) { element.style.left = `${value.x + position.x * value.scale}px`; element.style.top = `${value.y + (position.y + (element.dataset.role === 'checker' ? 55 : -180)) * value.scale}px`; }
    };
    void loadWorldManifest(abort.signal).then(world => {
      if (disposed || !host.current) return;
      setManifest(world);
      current = createWorldScene(host.current, world, {
        onLocation: id => { if (!disposed) callbacks.current.onLocation(id); },
        onActorPosition: labelPosition,
        onCamera: value => { camera.current = value; for (const [id, point] of positions.current) labelPosition(id, point); },
        onReady: () => { window.clearTimeout(watchdog); if (!disposed) { setState('ready'); setMessage('Выберите героя или станцию. Стрелки / WASD — движение указателя, E — открыть станцию.'); } },
        onError: error => { window.clearTimeout(watchdog); if (!disposed) { setState('failed'); setMessage(error); } },
        onHint: hint => { if (!disposed) setMessage(hint); },
      });
      scene.current = current; current.setPaused(callbacks.current.paused);
      current.setSnapshot(callbacks.current.snapshot, { connected: !callbacks.current.snapshotUnavailable, snapshotUnavailable: callbacks.current.snapshotUnavailable });
    }).catch(() => {
      window.clearTimeout(watchdog);
      if (!disposed) { setState('failed'); setMessage('Гильдия недоступна. Повторите загрузку; поручение и книги доступны через меню.'); }
    });
    return () => { disposed = true; window.clearTimeout(watchdog); abort.abort(); current?.destroy(); if (scene.current === current) scene.current = null; };
  }, [attempt]);
  return <section className="rpg-world guild-world" data-testid="guild-world" data-renderer-state={state} data-freshness={view.freshness} data-completed={view.completed} aria-label="Мастерская гильдии">
    <div ref={host} className="rpg-canvas-host" tabIndex={0} role="group" aria-label="Мир: стрелки или WASD для движения, E для входа" aria-describedby="world-help" />
    <div className="guild-world-labels" hidden={state !== 'ready' || paused}>
      {assignments.map(item => <div key={item.id} className="guild-actor" data-role={item.role} data-worker-state={item.worker?.state ?? 'idle'}
        ref={element => {
          if (element) {
            labels.current.set(item.id, element); const value = camera.current;
            const point = positions.current.get(item.id) ?? manifest?.guild?.roles[item.role].position;
            if (point) { element.style.left = `${value.x + point.x * value.scale}px`; element.style.top = `${value.y + (point.y + labelOffset(item.id)) * value.scale}px`; }
          } else labels.current.delete(item.id);
        }}>
        <button type="button" className="guild-role-label" aria-haspopup="dialog" title={workerReply(item.worker, view)}
          onClick={() => item.worker ? onWorker(item.worker.nodeId, item.worker.historical ? item.worker.runId : null) : onLocation(destinations[item.role])}>{GUILD_LABELS[item.role]}</button>
        {item.worker && (item.worker.active || ['failed', 'uncertain', 'waiting-for-human', 'learning-hold', 'disconnected', 'stale'].includes(item.worker.state)) &&
          <span className="guild-reply">{workerReply(item.worker, view)}</span>}
      </div>)}
    </div>
    <div className="rpg-world-help" hidden={paused}>
      <details className="world-instructions" open={state !== 'ready'}><summary>Управление</summary>
        <p id="world-help" role={state === 'failed' ? 'alert' : 'status'}>{message}</p>
        {state === 'failed' ? <button type="button" className="button" onClick={() => { setState('loading'); setMessage('Загружаем гильдию…'); setAttempt(value => value + 1); }}>Повторить загрузку сцены</button>
          : state === 'ready' && <div className="rpg-zoom" aria-label="Масштаб карты">
            <button type="button" className="button" onClick={() => scene.current?.zoom(-.2)} aria-label="Отдалить карту">−</button>
            <button type="button" className="button" onClick={() => scene.current?.zoom(.2)} aria-label="Приблизить карту">+</button>
          </div>}
      </details>
    </div>
    <aside className="guild-activity-book" hidden={paused} aria-label="Работа команды">
      <details><summary>Этапы и доказательства</summary>
        {view.freshness !== 'current' && <p className="guild-freshness">{view.freshness === 'disconnected' ? 'Актуальное состояние недоступно.' : view.freshness === 'stale' ? 'Доказательства устарели.' : 'Нет актуального поручения.'}</p>}
        {view.workers.length ? <ol>{view.workers.map(worker => <li className="guild-activity" key={worker.id} data-node-id={worker.nodeId} data-worker-state={worker.state} data-action={worker.action}>
          <button type="button" onClick={() => onWorker(worker.nodeId, worker.historical ? worker.runId : null)}><strong>{worker.title}</strong><span>{workerReply(worker, view)}</span></button>
          {worker.receiptIds.length > 0 && <small>Отчетов: {worker.receiptIds.length}</small>}
          {worker.dependencies.length > 0 && <small>Зависимости: {worker.dependencies.join(', ')}</small>}
        </li>)}</ol> : <p>Новая работа появится после постановки поручения.</p>}
      </details>
    </aside>
  </section>;
}
