import type { Point } from './world-navigation';

export const GUILD_ROLES = ['analyst', 'mage', 'checker', 'reviewer', 'mentor'] as const;
export type GuildRole = typeof GUILD_ROLES[number];
export type GuildAction = 'idle' | 'walk' | 'work' | 'handoff';
export type GuildDirection = 'se' | 'nw' | 'ne' | 'sw';
export type GuildAtlas = { url: string; image: string; frames: number; speed: number | null };
export type GuildManifest = {
  width: number; height: number; fps: number; anchor: Point; scale: number; room: string;
  directions: Record<GuildDirection, Point>;
  roles: Record<GuildRole, { position: Point; world: Point; direction: GuildDirection; states: Record<GuildAction, Partial<Record<GuildDirection, GuildAtlas>>> }>;
  foregrounds: { role: GuildRole; url: string; depth: number; frame: { x: number; y: number; width: number; height: number } | null }[];
  projection: { origin: Point; x: Point; y: Point };
};

function invalid(): never { throw new Error('Некорректный набор гильдии'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function finite(value: unknown, min = 0, max = 16384): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid();
  return value;
}
function pair(value: unknown, min = 0): Point {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return invalid();
  return { x: finite(value[0], min), y: finite(value[1], min) };
}
function file(value: unknown, expected: string): string { if (value !== expected) return invalid(); return `/assets/rpg/${expected}`; }

/** Decode only the bounded, package-owned cast; URLs cannot expand the server's allowlist. */
export function decodeGuildManifest(raw: unknown): GuildManifest {
  const data = object(raw);
  if (data.schemaVersion !== 1) return invalid();
  const size = pair(data.resolution), frames = pair(data.frameSize), pivot = pair(data.pivot), anchor = pair(data.anchor);
  if (size.x !== 1440 || size.y !== 1080 || frames.x !== 256 || frames.y !== 320 || Math.abs(anchor.x * 256 - pivot.x) > .01 || Math.abs(anchor.y * 320 - pivot.y) > .01) return invalid();
  const directions = {} as GuildManifest['directions'];
  for (const key of ['se', 'nw', 'ne', 'sw'] as const) directions[key] = pair(object(object(data.directions)[key]).screenVector, -16384);
  const roles = {} as GuildManifest['roles'];
  for (const role of GUILD_ROLES) {
    const item = object(object(data.roles)[role]), station = object(item.station);
    const states = {} as GuildManifest['roles'][GuildRole]['states'];
    for (const action of ['idle', 'walk', 'work', 'handoff'] as const) {
      const variants: Partial<Record<GuildDirection, GuildAtlas>> = {};
      for (const direction of action === 'walk' ? ['se', 'nw', 'ne', 'sw'] as const : ['se', 'nw'] as const) {
        const atlas = object(object(object(item.states)[action])[direction]);
        if (atlas.rootMotion !== false) return invalid();
        variants[direction] = { url: file(atlas.atlas, `guild-${role}-${action}-${direction}.json`), image: file(atlas.image, `guild-${role}-${action}-${direction}.png`), frames: finite(atlas.frames, 1, 36), speed: action === 'walk' ? finite(atlas.metersPerSecond, .1, 3) : null };
      }
      states[action] = variants;
    }
    if (station.direction !== 'se' && station.direction !== 'nw') return invalid();
    roles[role] = { position: pair(station.pixel), world: pair(station.world, -100), direction: station.direction, states };
  }
  if (!Array.isArray(data.foregrounds) || data.foregrounds.length !== GUILD_ROLES.length) return invalid();
  const seen = new Set<string>();
  const foregrounds = data.foregrounds.map(value => {
    const entry = object(value), role = entry.role as GuildRole;
    if (!GUILD_ROLES.includes(role) || seen.has(role)) return invalid();
    seen.add(role);
    let frame = null;
    if (entry.alphaFrame !== undefined) {
      if (!Array.isArray(entry.alphaFrame) || entry.alphaFrame.length !== 4) return invalid();
      const [x, y, right, bottom] = entry.alphaFrame.map(value => finite(value));
      if (right! <= x! || bottom! <= y! || right! > 1440 || bottom! > 1080) return invalid();
      frame = { x: x!, y: y!, width: right! - x!, height: bottom! - y! };
    }
    return { role, url: file(entry.file, `guild-foreground-${role}.png`), depth: finite(entry.depthY, 0, 1080), frame };
  });
  const rawProjection = object(data.projection), origin = pair(rawProjection.origin);
  const unitX = pair(rawProjection.unitX), unitY = pair(rawProjection.unitY);
  const projection = { origin, x: { x: unitX.x - origin.x, y: unitX.y - origin.y }, y: { x: unitY.x - origin.x, y: unitY.y - origin.y } };
  if (Math.abs(projection.x.x * projection.y.y - projection.x.y * projection.y.x) < 1) return invalid();
  return { width: size.x, height: size.y, anchor, fps: finite(data.fps, 1, 30), scale: finite(data.spriteScale, .1, 2),
    room: file(data.room, 'guild-room.png'), roles, directions, foregrounds, projection };
}
