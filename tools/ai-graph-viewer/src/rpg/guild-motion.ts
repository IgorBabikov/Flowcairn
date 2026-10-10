import type { GuildDirection, GuildManifest } from './guild-manifest';
import type { Point } from './world-navigation';

export function worldPoint(pixel: Point, manifest: GuildManifest): Point {
  const { origin, x, y } = manifest.projection;
  const px = pixel.x - origin.x, py = pixel.y - origin.y, determinant = x.x * y.y - x.y * y.x;
  return { x: (px * y.y - py * y.x) / determinant, y: (x.x * py - x.y * px) / determinant };
}
export function imagePoint(point: Point, manifest: GuildManifest): Point {
  const { origin, x, y } = manifest.projection;
  return { x: origin.x + x.x * point.x + y.x * point.y, y: origin.y + x.y * point.x + y.y * point.y };
}
export function walkingDirection(from: Point, to: Point, manifest: GuildManifest): GuildDirection {
  const dx = to.x - from.x, dy = to.y - from.y;
  return (Object.entries(manifest.directions) as [GuildDirection, Point][]).sort(([, a], [, b]) =>
    (dx * b.x + dy * b.y) / Math.hypot(b.x, b.y) - (dx * a.x + dy * a.y) / Math.hypot(a.x, a.y))[0]![0];
}
/** Four authored walk directions follow world axes; the front aisle avoids workstation props. */
export function handoffRoute(from: Point, to: Point, manifest: GuildManifest): Point[] {
  const a = worldPoint(from, manifest), b = worldPoint(to, manifest);
  const exit = a.y > .75 ? { x: a.x < 0 ? -1.25 : 1.25, y: a.y } : a;
  const entry = b.y > .75 ? { x: b.x < 0 ? -1.25 : 1.25, y: b.y } : b;
  const goal = { x: b.x, y: b.y - .55 };
  const points = [a, exit, { x: exit.x, y: -2.7 }, { x: entry.x, y: -2.7 }, { x: entry.x, y: goal.y }, goal];
  return points.filter((p, index) => index === 0 || Math.hypot(p.x - points[index - 1]!.x, p.y - points[index - 1]!.y) > .01).map(p => imagePoint(p, manifest));
}
export function advanceGuildRoute(position: Point, route: Point[], meters: number, manifest: GuildManifest): { point: Point; direction: GuildDirection } {
  let current = position, direction: GuildDirection = 'nw';
  while (route.length && meters > 0) {
    const target = route[0]!, a = worldPoint(current, manifest), b = worldPoint(target, manifest);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    direction = walkingDirection(current, target, manifest);
    if (length <= meters) { current = target; route.shift(); meters -= length; }
    else { current = imagePoint({ x: a.x + (b.x - a.x) * meters / length, y: a.y + (b.y - a.y) * meters / length }, manifest); break; }
  }
  return { point: current, direction };
}
