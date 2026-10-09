export type Point = { x: number; y: number };
export type Road = { from: string; to: string; radius: number };
export type Navigation = { points: Record<string, Point>; roads: Road[]; snapTolerance: number; speed: number };
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function projectToRoad(point: Point, navigation: Navigation) {
  let nearest: { point: Point; road: Road; distance: number } | null = null;
  for (const road of navigation.roads) {
    const a = navigation.points[road.from], b = navigation.points[road.to];
    if (!a || !b) continue;
    const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared)) : 0;
    const projected = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const gap = distance(point, projected);
    if (!nearest || gap < nearest.distance) nearest = { point: projected, road, distance: gap };
  }
  return nearest;
}

/** Dijkstra on authored roads, with start/end inserted on their current segments. */
export function findRoute(start: Point, target: Point, navigation: Navigation): Point[] | null {
  const from = projectToRoad(start, navigation), to = projectToRoad(target, navigation);
  if (!from || !to || to.distance > to.road.radius + navigation.snapTolerance) return null;
  const positions = new Map(Object.entries(navigation.points));
  positions.set('@start', from.point); positions.set('@end', to.point);
  const links = new Map<string, Map<string, number>>();
  const connect = (a: string, b: string) => {
    const weight = distance(positions.get(a)!, positions.get(b)!);
    if (!links.has(a)) links.set(a, new Map());
    if (!links.has(b)) links.set(b, new Map());
    links.get(a)!.set(b, weight); links.get(b)!.set(a, weight);
  };
  navigation.roads.forEach(road => connect(road.from, road.to));
  connect('@start', from.road.from); connect('@start', from.road.to);
  connect('@end', to.road.from); connect('@end', to.road.to);
  if (from.road === to.road) connect('@start', '@end');
  const costs = new Map<string, number>([['@start', 0]]), previous = new Map<string, string>();
  const remaining = new Set(positions.keys());
  while (remaining.size) {
    let next: string | undefined, best = Infinity;
    for (const id of remaining) if ((costs.get(id) ?? Infinity) < best) { next = id; best = costs.get(id)!; }
    if (!next) return null;
    remaining.delete(next);
    if (next === '@end') {
      const ids = [next];
      while (previous.has(ids[0]!)) ids.unshift(previous.get(ids[0]!)!);
      return ids.map(id => positions.get(id)!);
    }
    for (const [neighbor, weight] of links.get(next) ?? []) {
      if (remaining.has(neighbor) && best + weight < (costs.get(neighbor) ?? Infinity)) {
        costs.set(neighbor, best + weight); previous.set(neighbor, next);
      }
    }
  }
  return null;
}

export function advanceRoute(position: Point, route: Point[], delta: number): Point {
  let current = position;
  while (route.length && delta > 0) {
    const target = route[0]!, length = distance(current, target);
    if (length <= delta) { current = target; delta -= length; route.shift(); }
    else { current = { x: current.x + (target.x - current.x) / length * delta, y: current.y + (target.y - current.y) / length * delta }; break; }
  }
  return current;
}

export type Camera = { scale: number; x: number; y: number };
export function fitCamera(width: number, height: number, bounds: { x: number; y: number; width: number; height: number }, hero: Point, zoom = 1): Camera {
  const scale = Math.min(width / bounds.width, height / bounds.height) * Math.max(1, Math.min(1.8, zoom));
  const axis = (viewport: number, size: number, origin: number, focus: number) => size * scale <= viewport
    ? (viewport - size * scale) / 2 - origin * scale
    : Math.max(viewport - (origin + size) * scale, Math.min(-origin * scale, viewport / 2 - focus * scale));
  return { scale, x: axis(width, bounds.width, bounds.x, hero.x), y: axis(height, bounds.height, bounds.y, hero.y) };
}

export function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
