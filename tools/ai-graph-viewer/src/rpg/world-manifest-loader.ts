import { LOCATION_LABELS, type Hotspot, type WorldAsset, type WorldManifest, type LocationId } from './world-manifest';
import type { Point } from './world-navigation';

const invalid = () => { throw new Error('Некорректная карта мира'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function number(value: unknown, minimum = 0, maximum = 16384): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 160) return invalid(); return value; }
function point(value: unknown): Point {
  if (!Array.isArray(value) || value.length !== 2) return invalid();
  return { x: number(value[0]), y: number(value[1]) };
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) return invalid(); return value; }

/** Parse only authored package data; language/runtime/source contracts remain elsewhere. */
export function decodeWorldManifest(value: unknown): WorldManifest {
  const data = record(value), projection = record(data.projection), rawBounds = record(data.bounds);
  if (data.schemaVersion !== 1 || projection.coordinates !== 'image-pixels' || projection.transform !== 'identity') return invalid();
  const bounds = { x: number(rawBounds.x), y: number(rawBounds.y), width: number(rawBounds.width, 1), height: number(rawBounds.height, 1) };
  const inside = (p: Point) => p.x >= bounds.x && p.y >= bounds.y && p.x <= bounds.x + bounds.width && p.y <= bounds.y + bounds.height;
  const rawAssets = record(data.assets);
  const asset = (id: string): WorldAsset => {
    const entry = record(rawAssets[id]), size = point(entry.sizePx), anchor = point(entry.anchorPx);
    const file = string(entry.file);
    if (!/^[a-z0-9][a-z0-9-]*\.(png|webp)$/.test(file) || !size.x || !size.y || anchor.x > size.x || anchor.y > size.y) return invalid();
    const visible = entry.visibleBoundsPx === undefined ? null : list(entry.visibleBoundsPx, 4);
    if (visible && visible.length !== 4) return invalid();
    const visibleHeight = visible ? number(visible[3], 1) - number(visible[1]) : size.y;
    if (visibleHeight <= 0 || visibleHeight > size.y) return invalid();
    return { id, url: `/assets/rpg/${file}`, width: size.x, height: size.y, anchor,
      visibleHeight, displayHeight: entry.visibleHeightWorldPx === undefined ? size.y : number(entry.visibleHeightWorldPx, 1) };
  };
  const nav = record(data.navigation), points: Record<string, Point> = Object.create(null);
  const entries = Object.entries(record(nav.points));
  if (!entries.length || entries.length > 128 || nav.bidirectional !== true) return invalid();
  for (const [id, coordinate] of entries) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(id)) return invalid();
    points[id] = point(coordinate); if (!inside(points[id]!)) return invalid();
  }
  const roads = list(nav.edges, 256).map(value => {
    const edge = record(value), from = string(edge.from), to = string(edge.to);
    if (!points[from] || !points[to] || from === to) return invalid();
    return { from, to, radius: number(edge.radiusPx, 1, 100) };
  });
  if (!roads.length) return invalid();
  const spawn = points[string(record(data.spawn).pointId)];
  if (!spawn) return invalid();
  const hotspots: Hotspot[] = [];
  for (const value of list(data.hotspots, 16)) {
    const entry = record(value);
    if (entry.scene !== 'world') continue;
    const id = string(entry.id) as LocationId, pointId = string(entry.arrivalNode);
    if (!Object.hasOwn(LOCATION_LABELS, id) || hotspots.some(h => h.id === id) || !points[pointId]) return invalid();
    const polygon = list(entry.polygonPx, 32).map(point), labelPosition = point(entry.labelAnchorPx);
    if (polygon.length < 3 || !polygon.every(inside) || !inside(labelPosition)) return invalid();
    hotspots.push({ id, label: string(entry.label), pointId, polygon, labelPosition, interactionRadius: number(nav.interactionRadiusPx, 1, 100) });
  }
  if (!['guild', 'workshop', 'archive'].every(id => hotspots.some(h => h.id === id))) return invalid();
  const rooms: WorldManifest['rooms'] = {};
  for (const id of ['workshop', 'archive'] as const) {
    const entry = record(record(data.rooms)[id]);
    rooms[id] = { background: asset(string(entry.background)), hero: asset('hero-idle'),
      heroPosition: point(entry.heroPositionPx), heroHeight: number(entry.heroVisibleHeightPx, 1),
      mentor: entry.mentorPositionPx ? { asset: asset('mentor-idle'), position: point(entry.mentorPositionPx), height: number(entry.mentorVisibleHeightPx, 1) } : null };
  }
  const matte = string(record(data.viewport).matte);
  if (!/^#[0-9a-f]{6}$/i.test(matte)) return invalid();
  return { bounds, background: asset(string(data.background)), hero: asset('hero-idle'), mentor: null,
    navigation: { points, roads, snapTolerance: number(nav.clickSnapTolerancePx, 0, 100), speed: number(nav.speedPxPerSecond, 1, 1000) }, spawn, hotspots, matte, rooms };
}

export async function loadWorldManifest(signal: AbortSignal): Promise<WorldManifest> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/assets/rpg/world.json', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Карта недоступна');
    const text = await response.text();
    if (text.length > 65536) return invalid();
    return decodeWorldManifest(JSON.parse(text));
  } finally { window.clearTimeout(timeout); signal.removeEventListener('abort', forward); }
}
