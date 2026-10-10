// Installs Pixi's interpreted shader sync for strict CSP; it does not allow eval.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, Texture, Rectangle, type Ticker } from 'pixi.js';
import type { Snapshot } from '../contracts';
import { acquireTexture } from './world-assets';
import { advanceRoute, distance, findRoute, fitCamera, insidePolygon, projectToRoad, type Camera, type Point } from './world-navigation';
import type { LocationId, WorldManifest } from './world-manifest';
import { createGuildActors } from './guild-actors';
import { projectWorldExecution, selectWorldExecution, type WorldExecutionCursor, type WorldExecutionOptions } from './world-execution';

export type WorldScene = {
  destroy: () => void; setPaused: (paused: boolean) => void; fastTravel: (id: LocationId) => void;
  travel: (id: LocationId) => void; zoom: (delta: number) => void;
  setSnapshot: (snapshot: Snapshot | null, options: WorldExecutionOptions) => void;
};
export function createWorldScene(host: HTMLDivElement, manifest: WorldManifest, callbacks: {
  onLocation: (id: LocationId) => void; onCamera: (camera: Camera) => void;
  onReady: () => void; onError: (message: string) => void; onHint: (message: string) => void;
  onActorPosition: (id: string, point: Point | null) => void;
}): WorldScene {
  const app = new Application(), world = new Container({ sortableChildren: true });
  const telemetry = host.closest<HTMLElement>('[data-testid="guild-world"]') ?? host;
  const textures: ReturnType<typeof acquireTexture>[] = [], keys = new Set<string>();
  const textureViews: Texture[] = [];
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false, initialized = false, paused = false, ready = false, failed = false;
  let position = { ...manifest.spawn }, route: Point[] = [], destination: LocationId | null = null;
  let zoom = 1, camera: Camera = { x: 0, y: 0, scale: 1 }, cursor: WorldExecutionCursor | null = null;
  let view = projectWorldExecution(null, { connected: false });
  let actors: ReturnType<typeof createGuildActors> | null = null, observer: ResizeObserver | null = null;
  let width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
  const marker = new Graphics().ellipse(0, 0, 11, 5).stroke({ color: 0xe6c17b, width: 2, alpha: .9 });
  marker.visible = false; marker.zIndex = 1100; world.addChild(marker);
  const clearInput = () => { keys.clear(); route = []; destination = null; };
  const updateCamera = () => {
    camera = fitCamera(width, height, manifest.bounds, position, zoom);
    world.position.set(camera.x, camera.y); world.scale.set(camera.scale); callbacks.onCamera(camera);
  };
  const redraw = () => { marker.position.set(position.x, position.y); updateCamera(); };
  const render = () => { if (ready && !disposed && !document.hidden) app.render(); };
  const fail = (message: string) => { if (disposed) return; failed = true; ready = false; clearInput(); if (initialized) app.stop(); callbacks.onError(message); };
  const arrival = () => { if (destination && !route.length) { const id = destination; destination = null; callbacks.onLocation(id); } };
  const go = (target: Point, id: LocationId | null, instant = false) => {
    if (!ready || disposed || paused && !instant) return;
    const path = findRoute(position, target, manifest.navigation);
    if (!path) { callbacks.onHint('Выберите свободный проход или станцию.'); return; }
    keys.clear(); destination = id; marker.visible = true;
    if (instant || motion.matches) { position = path.at(-1)!; route = []; redraw(); arrival(); render(); }
    else route = path.slice(1);
  };
  const travel = (id: LocationId, instant = false) => {
    const hotspot = manifest.hotspots.find(item => item.id === id), point = hotspot && manifest.navigation.points[hotspot.pointId];
    if (point) go(point, instant ? null : id, instant);
  };
  const pointer = (event: PointerEvent) => {
    if (paused || !ready || event.button !== 0) return;
    host.focus(); const rect = host.getBoundingClientRect();
    const target = { x: (event.clientX - rect.left - camera.x) / camera.scale, y: (event.clientY - rect.top - camera.y) / camera.scale };
    const hotspot = manifest.hotspots.find(item => insidePolygon(target, item.polygon));
    if (hotspot) { callbacks.onLocation(hotspot.id); return; }
    go(target, null);
  };
  const movement = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== host || paused || !ready) return;
    if (movement.has(event.code)) { event.preventDefault(); keys.add(event.code); route = []; destination = null; marker.visible = true; }
    if ((event.code === 'Enter' || event.code === 'KeyE') && !event.repeat) {
      event.preventDefault(); const hotspot = manifest.hotspots.find(h => distance(position, manifest.navigation.points[h.pointId]!) <= h.interactionRadius);
      if (hotspot) { clearInput(); callbacks.onLocation(hotspot.id); } else callbacks.onHint('Подойдите к станции или выберите ее кнопкой.');
    }
  };
  const keyup = (event: KeyboardEvent) => keys.delete(event.code);
  const frameTimes: number[] = [], renderTimes: number[] = [];
  let rendered = 0, renderingAt = 0, handoffs = 0;
  const percentile = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * .95) - 1)] ?? 0;
  const meter = { prerender() { renderingAt = performance.now(); }, postrender() {
    rendered++; renderTimes.push(performance.now() - renderingAt); if (renderTimes.length > 180) renderTimes.shift();
    telemetry.dataset.renderCount = String(rendered);
    if (rendered % 30 === 0) { telemetry.dataset.frameP95Ms = percentile(frameTimes).toFixed(3); telemetry.dataset.renderP95Ms = percentile(renderTimes).toFixed(3); }
  } };
  const tick = (ticker: Ticker) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      telemetry.dataset.paused = 'true';
      app.stop();
      return;
    }
    if (paused || disposed || document.hidden || failed) return;
    frameTimes.push(ticker.elapsedMS); if (frameTimes.length > 180) frameTimes.shift();
    const step = Math.min(50, ticker.deltaMS) / 1000 * manifest.navigation.speed;
    let x = Number(keys.has('ArrowRight') || keys.has('KeyD')) - Number(keys.has('ArrowLeft') || keys.has('KeyA'));
    let y = Number(keys.has('ArrowDown') || keys.has('KeyS')) - Number(keys.has('ArrowUp') || keys.has('KeyW'));
    if (x || y) {
      const length = Math.hypot(x, y); x /= length; y /= length;
      const target = { x: position.x + x * step, y: position.y + y * step }, projection = projectToRoad(target, manifest.navigation);
      const path = projection && findRoute(position, projection.point, manifest.navigation);
      const pathLength = path?.slice(1).reduce((sum, point, index) => sum + distance(path[index]!, point), 0) ?? Infinity;
      if (projection && projection.distance <= projection.road.radius && path && pathLength <= step * 1.5) position = advanceRoute(position, path.slice(1), step);
      redraw();
    } else if (route.length) { position = advanceRoute(position, route, step); redraw(); arrival(); }
    actors?.tick(ticker, reduced);
  };
  const syncTicker = () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    telemetry.dataset.paused = String(document.hidden || paused || reduced || failed);
    if (!ready || !initialized || disposed) return;
    if (document.hidden || paused || reduced || failed) app.stop(); else app.start();
  };
  const visibility = () => { clearInput(); actors?.cancelMotion(); cursor = null; syncTicker(); if (!document.hidden) render(); };
  const motionChange = () => { clearInput(); actors?.cancelMotion(); syncTicker(); render(); };
  const lost = (event: Event) => { event.preventDefault(); fail('Графическая сцена недоступна. Используйте книги или повторите загрузку.'); };
  const loadImage = async (url: string, depth: number, frame: { x: number; y: number; width: number; height: number } | null = null) => {
    const lease = acquireTexture(url); textures.push(lease); const texture = await lease.texture;
    if (disposed) throw new Error('Disposed'); texture.source.scaleMode = 'linear';
    const region = frame ? new Texture({ source: texture.source, frame: new Rectangle(frame.x, frame.y, frame.width, frame.height) }) : texture;
    if (frame) textureViews.push(region);
    const sprite = new Sprite(region); sprite.zIndex = depth; if (frame) sprite.position.set(frame.x, frame.y); world.addChild(sprite); return sprite;
  };
  void (async () => {
    try {
      if (!manifest.guild) throw new Error('Guild missing');
      await app.init({ width, height, background: manifest.matte, preference: 'webgl', autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2), autoStart: false, sharedTicker: false });
      // The authored character atlases are 12 fps; a 40 Hz render cap keeps the
      // 2D scene responsive while avoiding redundant software-renderer work.
      app.ticker.maxFPS = 40;
      initialized = true;
      if (disposed) { app.destroy({ removeView: true }, { children: true }); return; }
      app.stage.addChild(world); app.renderer.runners.prerender.add(meter); app.renderer.runners.postrender.add(meter);
      actors = createGuildActors(world, manifest.guild, fail, callbacks.onActorPosition);
      await Promise.all([loadImage(manifest.guild.room, -1), ...manifest.guild.foregrounds.map(layer => loadImage(layer.url, layer.depth, layer.frame)), actors.initialize(view)]);
      if (disposed || failed) return;
      actors.facts(view); telemetry.dataset.actorCount = String(actors.count);
      host.appendChild(app.canvas); app.canvas.setAttribute('aria-hidden', 'true');
      app.canvas.addEventListener('pointerdown', pointer); app.canvas.addEventListener('webglcontextlost', lost);
      host.addEventListener('keydown', keydown); host.addEventListener('keyup', keyup); host.addEventListener('blur', clearInput);
      window.addEventListener('blur', clearInput); document.addEventListener('visibilitychange', visibility); motion.addEventListener('change', motionChange);
      observer = new ResizeObserver(() => { width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight); app.renderer.resize(width, height); redraw(); render(); });
      observer.observe(host); ready = true; redraw(); app.ticker.add(tick); app.render(); syncTicker(); callbacks.onReady();
    } catch (error) {
      telemetry.dataset.rendererError = error instanceof Error ? error.message : 'renderer unavailable';
      fail('Не удалось загрузить гильдию. Книги доступны через меню; можно повторить загрузку.');
    }
  })();
  return {
    travel: id => travel(id), fastTravel: id => travel(id, true),
    setPaused(value) { paused = value; clearInput(); if (paused) { actors?.cancelMotion(); cursor = null; } syncTicker(); },
    setSnapshot(snapshot, options) {
      const next = selectWorldExecution(snapshot, options, cursor); cursor = next.cursor; view = next.view;
      telemetry.dataset.freshness = view.freshness; telemetry.dataset.completed = String(view.completed);
      actors?.facts(view); if (actors) telemetry.dataset.actorCount = String(actors.count);
      if (view.freshness !== 'current') actors?.cancelMotion();
      if (!paused && !document.hidden) for (const event of view.handoffs.slice(-8)) {
        handoffs++; if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) actors?.handoff(event);
        callbacks.onHint('Предыдущий этап завершен. Зависимый этап начал работу.');
      }
      telemetry.dataset.handoffCount = String(handoffs); render();
    },
    zoom(delta) { zoom = Math.max(1, Math.min(1.8, zoom + delta)); if (ready) { redraw(); render(); } },
    destroy() {
      if (disposed) return; disposed = true; clearInput(); observer?.disconnect(); actors?.destroy();
      host.removeEventListener('keydown', keydown); host.removeEventListener('keyup', keyup); host.removeEventListener('blur', clearInput);
      window.removeEventListener('blur', clearInput); document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', motionChange);
      if (initialized) { app.canvas.removeEventListener('pointerdown', pointer); app.canvas.removeEventListener('webglcontextlost', lost);
        app.ticker.remove(tick); app.renderer.runners.prerender.remove(meter); app.renderer.runners.postrender.remove(meter); app.destroy({ removeView: true }, { children: true }); }
      textures.forEach(lease => lease.release());
      textureViews.forEach(texture => texture.destroy(false));
    },
  };
}
