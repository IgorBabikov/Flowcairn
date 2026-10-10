import { AnimatedSprite, Container, Graphics, type Ticker, type Spritesheet } from 'pixi.js';
import { acquireAtlas } from './world-assets';
import type { GuildAction, GuildDirection, GuildManifest, GuildRole } from './guild-manifest';
import { actorAssignments } from './guild-presentation';
import { advanceGuildRoute, handoffRoute } from './guild-motion';
import type { WorldExecutionView, WorldHandoff, WorldWorker } from './world-execution';
import type { Point } from './world-navigation';

type Lease = ReturnType<typeof acquireAtlas>;
type Actor = { id: string; role: GuildRole; position: Point; home: Point; sprite: AnimatedSprite | null; shadow: Graphics;
  worker: WorldWorker | null; action: GuildAction; direction: GuildDirection; request: number; lease: Lease | null; pending: Lease | null;
  motion: { route: Point[]; returnRoute: Point[]; phase: 'out' | 'gesture' | 'back'; seconds: number } | null };

export function createGuildActors(world: Container, manifest: GuildManifest, onError: (message: string) => void, onPosition: (id: string, position: Point | null) => void) {
  const actors = new Map<string, Actor>();
  let disposed = false;
  const atlas = async (actor: Actor, action: GuildAction, direction: GuildDirection) => {
    const spec = manifest.roles[actor.role].states[action][direction];
    if (!spec || disposed || actor.action === action && actor.direction === direction && (actor.lease || actor.pending)) return;
    actor.action = action; actor.direction = direction;
    const request = ++actor.request;
    actor.pending?.release();
    const lease = acquireAtlas(spec.url); actor.pending = lease;
    try {
      const sheet: Spritesheet = await lease.texture;
      const frames = sheet.animations[action];
      if (!frames || frames.length !== spec.frames || frames.some(frame => frame.orig.width !== 256 || frame.orig.height !== 320)) throw new Error('Atlas contract');
      if (disposed || request !== actor.request) { lease.release(); return; }
      for (const texture of frames) texture.source.scaleMode = 'linear';
      if (!actor.sprite) {
        actor.sprite = new AnimatedSprite({ textures: frames, autoUpdate: false, animationSpeed: manifest.fps / 60, updateAnchor: true });
        actor.sprite.anchor.set(manifest.anchor.x, manifest.anchor.y); actor.sprite.scale.set(manifest.scale); world.addChild(actor.sprite);
      } else actor.sprite.textures = frames;
      actor.sprite.gotoAndPlay(0); actor.sprite.loop = action !== 'handoff';
      actor.lease?.release(); actor.lease = lease; actor.pending = null;
      place(actor);
    } catch {
      lease.release(); if (actor.pending === lease) actor.pending = null;
      if (!disposed && request === actor.request) onError('Анимация героя недоступна. Состояние и книги остаются доступны.');
    }
  };
  const place = (actor: Actor) => {
    actor.sprite?.position.set(actor.position.x, actor.position.y);
    if (actor.sprite) actor.sprite.zIndex = actor.position.y;
    actor.shadow.position.set(actor.position.x, actor.position.y); actor.shadow.zIndex = actor.position.y - .5;
    onPosition(actor.id, actor.position);
  };
  const create = (id: string, role: GuildRole, offset: number) => {
    const point = manifest.roles[role].position;
    const home = { x: point.x - offset * 44, y: point.y + offset * 26 };
    const shadow = new Graphics().ellipse(0, 2, 15, 5).fill({ color: 0x121713, alpha: .32 }); world.addChild(shadow);
    const actor: Actor = { id, role, home, position: { ...home }, shadow, sprite: null, worker: null, action: 'idle', direction: manifest.roles[role].direction,
      request: 0, lease: null, pending: null, motion: null };
    actors.set(id, actor); place(actor); return actor;
  };
  const remove = (actor: Actor) => { ++actor.request; actor.pending?.release(); actor.lease?.release(); actor.sprite?.destroy(); actor.shadow.destroy(); actors.delete(actor.id); onPosition(actor.id, null); };
  const reset = (actor: Actor) => { actor.motion = null; actor.position = { ...actor.home }; place(actor); };
  const facts = (view: WorldExecutionView) => {
    const assignments = actorAssignments(view);
    for (const actor of actors.values()) if (!assignments.some(item => item.id === actor.id)) remove(actor);
    for (const assignment of assignments) {
      const actor = actors.get(assignment.id) ?? create(assignment.id, assignment.role, assignment.offset);
      if (actor.worker?.id !== assignment.worker?.id || actor.worker?.attempt !== assignment.worker?.attempt || assignment.worker?.active && !actor.worker?.active || view.freshness !== 'current') reset(actor);
      actor.worker = assignment.worker;
      if (!actor.motion) void atlas(actor, actor.worker?.active ? 'work' : 'idle', manifest.roles[actor.role].direction);
    }
  };
  const handoff = (event: WorldHandoff) => {
    const actor = [...actors.values()].find(item => item.worker?.id === event.fromWorkerId);
    const consumer = [...actors.values()].find(item => item.worker?.id === event.toWorkerId);
    if (!actor || !consumer || actor === consumer) return;
    reset(actor);
    const path = handoffRoute(actor.home, consumer.home, manifest);
    actor.motion = { route: path.slice(1), returnRoute: [...path].reverse().slice(1), phase: 'out', seconds: 0 };
  };
  return {
    initialize: async (view: WorldExecutionView) => {
      for (const assignment of actorAssignments(view)) { const actor = create(assignment.id, assignment.role, assignment.offset); actor.worker = assignment.worker; }
      await Promise.all([...actors.values()].map(actor => atlas(actor, actor.worker?.active ? 'work' : 'idle', manifest.roles[actor.role].direction)));
    },
    facts, handoff,
    cancelMotion() { for (const actor of actors.values()) { reset(actor); void atlas(actor, actor.worker?.active ? 'work' : 'idle', manifest.roles[actor.role].direction); } },
    tick(ticker: Ticker, reduced: boolean) {
      for (const actor of actors.values()) {
        const motion = actor.motion;
        if (motion && !reduced) {
          motion.seconds += Math.min(ticker.deltaMS, 50) / 1000;
          if (motion.phase === 'gesture') {
            if (motion.seconds >= .75) { motion.phase = 'back'; motion.route = motion.returnRoute; motion.seconds = 0; }
          } else {
            const speed = manifest.roles[actor.role].states.walk.se!.speed!;
            const next = advanceGuildRoute(actor.position, motion.route, Math.min(ticker.deltaMS, 50) / 1000 * speed, manifest);
            actor.position = next.point; place(actor); void atlas(actor, 'walk', next.direction);
            if (!motion.route.length) {
              if (motion.phase === 'out') { motion.phase = 'gesture'; motion.seconds = 0; void atlas(actor, 'handoff', 'nw'); }
              else { reset(actor); void atlas(actor, actor.worker?.active ? 'work' : 'idle', manifest.roles[actor.role].direction); }
            }
          }
        }
        if (!reduced) actor.sprite?.update(ticker);
      }
    },
    get count() { return actors.size; },
    destroy() { disposed = true; for (const actor of [...actors.values()]) remove(actor); },
  };
}
