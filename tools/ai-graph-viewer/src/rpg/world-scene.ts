import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, type Ticker } from 'pixi.js';
import { acquireTexture } from './world-assets';
import { advanceRoute, distance, findRoute, fitCamera, insidePolygon, projectToRoad, type Camera, type Point } from './world-navigation';
import type { LocationId, WorldAsset, WorldManifest } from './world-manifest';

export type WorldScene = {
  destroy: () => void; setPaused: (paused: boolean) => void; fastTravel: (id: LocationId) => void;
  travel: (id: LocationId) => void; zoom: (delta: number) => void;
};
export function createWorldScene(host: HTMLDivElement, manifest: WorldManifest, callbacks: {
  onLocation: (id: LocationId) => void; onCamera: (camera: Camera) => void;
  onReady: () => void; onError: (message: string) => void; onHint: (message: string) => void;
}): WorldScene {
  const app = new Application();
  const world = new Container();
  const textures: ReturnType<typeof acquireTexture>[] = [];
  const keys = new Set<string>();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false, initialized = false, paused = false, ready = false;
  let position = { ...manifest.spawn }, route: Point[] = [], destination: LocationId | null = null;
  let hero: Sprite | null = null, shadow: Graphics | null = null, zoom = 1, camera: Camera = { x: 0, y: 0, scale: 1 };
  let observer: ResizeObserver | null = null;
  let width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
  const clearInput = () => { keys.clear(); route = []; destination = null; };
  const updateCamera = () => {
    camera = fitCamera(width, height, manifest.bounds, position, zoom);
    world.position.set(camera.x, camera.y); world.scale.set(camera.scale);
    callbacks.onCamera(camera);
  };
  const redraw = () => { hero?.position.set(position.x, position.y); shadow?.position.set(position.x, position.y); updateCamera(); };
  const arrival = () => {
    if (!destination || route.length) return;
    const id = destination; destination = null;
    callbacks.onHint('Вы у входа. E — войти; журнал — быстрое перемещение.');
    callbacks.onLocation(id);
  };
  const go = (target: Point, id: LocationId | null, instant = false) => {
    if (disposed || !ready || (paused && !instant)) return;
    const next = findRoute(position, target, manifest.navigation);
    if (!next) { callbacks.onHint('Выберите дорожку или место в журнале.'); return; }
    keys.clear(); destination = id;
    if (instant || motion.matches) { position = next.at(-1)!; route = []; redraw(); arrival(); }
    else { route = next.slice(1); callbacks.onHint(id ? `Идем: ${manifest.hotspots.find(h => h.id === id)?.label ?? id}` : 'Идем по дорожке'); }
  };
  const travel = (id: LocationId, instant = false) => {
    const hotspot = manifest.hotspots.find(item => item.id === id);
    const point = hotspot && manifest.navigation.points[hotspot.pointId];
    if (point) go(point, instant ? null : id, instant);
  };
  const pointer = (event: PointerEvent) => {
    if (paused || !ready || event.button !== 0) return;
    host.focus();
    const rect = host.getBoundingClientRect();
    const target = { x: (event.clientX - rect.left - camera.x) / camera.scale, y: (event.clientY - rect.top - camera.y) / camera.scale };
    const hotspot = manifest.hotspots.find(item => insidePolygon(target, item.polygon));
    if (hotspot) travel(hotspot.id); else go(target, null);
  };
  const movement = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  const keydown = (event: KeyboardEvent) => {
    if (event.target !== host || paused || !ready) return;
    if (movement.has(event.code)) { event.preventDefault(); keys.add(event.code); route = []; destination = null; }
    if ((event.code === 'Enter' || event.code === 'KeyE') && !event.repeat) {
      event.preventDefault();
      const hotspot = manifest.hotspots.find(h => distance(position, manifest.navigation.points[h.pointId]!) <= h.interactionRadius);
      if (hotspot) { clearInput(); callbacks.onLocation(hotspot.id); }
      else callbacks.onHint('Подойдите ко входу или выберите место в журнале.');
    }
  };
  const keyup = (event: KeyboardEvent) => keys.delete(event.code);
  const tick = (ticker: Ticker) => {
    if (paused || disposed || document.hidden) return;
    const step = Math.min(50, ticker.deltaMS) / 1000 * manifest.navigation.speed;
    let x = Number(keys.has('ArrowRight') || keys.has('KeyD')) - Number(keys.has('ArrowLeft') || keys.has('KeyA'));
    let y = Number(keys.has('ArrowDown') || keys.has('KeyS')) - Number(keys.has('ArrowUp') || keys.has('KeyW'));
    if (x || y) {
      const length = Math.hypot(x, y); x /= length; y /= length;
      const target = { x: position.x + x * step, y: position.y + y * step };
      const projection = projectToRoad(target, manifest.navigation);
      const path = projection && findRoute(position, projection.point, manifest.navigation);
      // Reject short-screen-space jumps between disconnected/parallel roads.
      const pathLength = path?.slice(1).reduce((sum, point, index) => sum + distance(path[index]!, point), 0) ?? Infinity;
      if (projection && projection.distance <= projection.road.radius && path && pathLength <= step * 1.5) position = advanceRoute(position, path.slice(1), step);
    } else if (route.length) { position = advanceRoute(position, route, step); arrival(); }
    if (x || y || route.length || destination) redraw();
    else if (hero && (hero.x !== position.x || hero.y !== position.y)) redraw();
  };
  const syncTicker = () => {
    if (!initialized || !ready || disposed) return;
    if (document.hidden || paused) app.stop(); else app.start();
  };
  const visibility = () => { clearInput(); syncTicker(); };
  const lost = (event: Event) => { event.preventDefault(); clearInput(); app.stop(); callbacks.onError('Графическая сцена недоступна. Повторите загрузку или используйте журнал.'); };
  const loadSprite = async (asset: WorldAsset) => {
    const lease = acquireTexture(asset.url); textures.push(lease);
    const texture = await lease.texture;
    if (disposed) throw new Error('Scene disposed');
    const sprite = new Sprite(texture);
    world.addChild(sprite);
    sprite.anchor.set(asset.anchor.x / asset.width, asset.anchor.y / asset.height);
    sprite.scale.set(asset.displayHeight / asset.visibleHeight);
    return sprite;
  };
  void (async () => {
    try {
      callbacks.onHint('Подготавливаем графическую сцену…');
      await app.init({ width, height, background: manifest.matte, preference: 'webgl',
        autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoStart: false, sharedTicker: false });
      initialized = true;
      if (disposed) { app.destroy({ removeView: true }, { children: true }); return; }
      app.stage.addChild(world);
      callbacks.onHint('Загружаем иллюстрации мира…');
      const [background, actor, mentor] = await Promise.all([
        loadSprite(manifest.background), loadSprite(manifest.hero), manifest.mentor ? loadSprite(manifest.mentor.asset) : null,
      ]);
      if (disposed) return;
      background.position.set(manifest.bounds.x, manifest.bounds.y);
      world.addChild(background);
      if (mentor && manifest.mentor) { mentor.position.set(manifest.mentor.position.x, manifest.mentor.position.y); world.addChild(mentor); }
      shadow = new Graphics().ellipse(0, 0, 16, 5).fill({ color: 0x101811, alpha: 0.4 });
      world.addChild(shadow);
      hero = actor; world.addChild(actor);
      host.appendChild(app.canvas); app.canvas.setAttribute('aria-hidden', 'true');
      app.canvas.addEventListener('pointerdown', pointer); app.canvas.addEventListener('webglcontextlost', lost);
      host.addEventListener('keydown', keydown); host.addEventListener('keyup', keyup); host.addEventListener('blur', clearInput);
      window.addEventListener('blur', clearInput); document.addEventListener('visibilitychange', visibility); motion.addEventListener('change', clearInput);
      observer = new ResizeObserver(() => { width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight); app.renderer.resize(width, height); redraw(); if (paused) app.render(); });
      observer.observe(host); ready = true; redraw(); app.ticker.add(tick); app.render(); syncTicker(); callbacks.onReady();
    } catch {
      if (!disposed) callbacks.onError('Не удалось загрузить графическую сцену. Повторите загрузку или используйте журнал.');
    }
  })();
  return {
    travel: id => travel(id), fastTravel: id => travel(id, true),
    setPaused(value) { paused = value; clearInput(); syncTicker(); },
    zoom(delta) { zoom = Math.max(1, Math.min(1.8, zoom + delta)); if (ready) { redraw(); app.render(); } },
    destroy() {
      if (disposed) return;
      disposed = true; clearInput(); observer?.disconnect();
      host.removeEventListener('keydown', keydown); host.removeEventListener('keyup', keyup); host.removeEventListener('blur', clearInput);
      window.removeEventListener('blur', clearInput); document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', clearInput);
      if (initialized) {
        app.canvas.removeEventListener('pointerdown', pointer); app.canvas.removeEventListener('webglcontextlost', lost);
        app.ticker.remove(tick); app.destroy({ removeView: true }, { children: true });
      }
      textures.forEach(lease => lease.release());
    },
  };
}
