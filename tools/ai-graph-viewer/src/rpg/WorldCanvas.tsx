import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { loadWorldManifest, type LocationId, type WorldManifest } from './world-manifest';
import { createWorldScene, type WorldScene } from './world-scene';
import type { Camera } from './world-navigation';

export type WorldHandle = { fastTravel: (location: LocationId) => void };
export function WorldCanvas({ paused, onLocation, onManifest, ref }: {
  onManifest: (manifest: WorldManifest) => void;
  paused: boolean; onLocation: (location: LocationId) => void; ref: Ref<WorldHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<WorldScene | null>(null);
  const labels = useRef(new Map<LocationId, HTMLButtonElement>());
  const callbacks = useRef({ paused, onLocation, onManifest });
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState('Загружаем площадь…');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { callbacks.current = { paused, onLocation, onManifest }; }, [paused, onLocation, onManifest]);
  useEffect(() => { scene.current?.setPaused(paused); }, [paused]);
  useImperativeHandle(ref, () => ({ fastTravel: id => scene.current?.fastTravel(id) }), []);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    let current: WorldScene | null = null;
    const watchdog = window.setTimeout(() => {
      if (!disposed) { current?.destroy(); setState('failed'); setMessage('Загрузка сцены заняла слишком много времени. Повторите попытку или используйте журнал.'); }
    }, 30000);
    const positionLabels = (value: Camera, world: WorldManifest) => {
      camera.current = value;
      for (const hotspot of world.hotspots) {
        const button = labels.current.get(hotspot.id);
        if (button) { button.style.left = `${value.x + hotspot.labelPosition.x * value.scale}px`; button.style.top = `${value.y + hotspot.labelPosition.y * value.scale}px`; }
      }
    };
    void loadWorldManifest(abort.signal).then(world => {
      if (disposed || !host.current) return;
      setManifest(world);
      callbacks.current.onManifest(world);
      current = createWorldScene(host.current, world, {
        onLocation: id => { if (!disposed) callbacks.current.onLocation(id); },
        onCamera: value => { if (!disposed) positionLabels(value, world); },
        onReady: () => { window.clearTimeout(watchdog); if (!disposed) { setState('ready'); setMessage('Нажмите на здание или дорожку. Стрелки / WASD — движение, E — войти.'); } },
        onError: error => { window.clearTimeout(watchdog); if (!disposed) { setState('failed'); setMessage(error); } },
        onHint: hint => { if (!disposed) setMessage(hint); },
      });
      scene.current = current;
      current.setPaused(callbacks.current.paused);
    }).catch(() => {
      window.clearTimeout(watchdog);
      if (!disposed) { setState('failed'); setMessage('Карта недоступна. Повторите загрузку; все места доступны через журнал.'); }
    });
    return () => { disposed = true; window.clearTimeout(watchdog); abort.abort(); current?.destroy(); if (scene.current === current) scene.current = null; };
  }, [attempt]);
  return <section className="rpg-world" aria-label="Площадь">
    <div ref={host} className="rpg-canvas-host" tabIndex={0} role="group" aria-label="Мир: стрелки или WASD для движения, E для входа" aria-describedby="world-help" />
    <div className="rpg-world-labels" hidden={state !== 'ready' || paused}>
      {manifest?.hotspots.map(hotspot => <button key={hotspot.id} type="button" className="rpg-hotspot" aria-haspopup="dialog"
        ref={element => {
          if (element) {
            labels.current.set(hotspot.id, element);
            element.style.left = `${camera.current.x + hotspot.labelPosition.x * camera.current.scale}px`;
            element.style.top = `${camera.current.y + hotspot.labelPosition.y * camera.current.scale}px`;
          } else labels.current.delete(hotspot.id);
        }} onClick={() => { host.current?.focus(); scene.current?.travel(hotspot.id); }}>{hotspot.label}</button>)}
    </div>
    <div className="rpg-world-help" hidden={paused}>
      <details className="world-instructions" open={state !== 'ready'}><summary>Управление</summary>
      <p id="world-help" role={state === 'failed' ? 'alert' : 'status'}>{message}</p>
      {state === 'failed' ? <button type="button" className="button" onClick={() => { setState('loading'); setMessage('Загружаем площадь…'); setAttempt(value => value + 1); }}>Повторить загрузку сцены</button>
        : state === 'ready' && <div className="rpg-zoom" aria-label="Масштаб карты">
          <button type="button" className="button" onClick={() => scene.current?.zoom(-0.2)} aria-label="Отдалить карту">−</button>
          <button type="button" className="button" onClick={() => scene.current?.zoom(0.2)} aria-label="Приблизить карту">+</button>
        </div>}
      </details>
    </div>
  </section>;
}
