import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

// Focused pure-module tests: transpile in memory, never write viewer/dist.
const output = await build({ stdin: { contents: "export * from './world-navigation'; export {decodeWorldManifest} from './world-manifest-loader';",
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { findRoute, advanceRoute, distance, fitCamera, projectToRoad, insidePolygon, decodeWorldManifest } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const source = JSON.parse(await readFile(new URL('../../assets/rpg/world.json', import.meta.url), 'utf8'));
const world = decodeWorldManifest(source);

test('authored image-space coordinates and all three doors stay reachable on the road graph', () => {
  assert.deepEqual(world.spawn, { x: source.navigation.points.spawn[0], y: source.navigation.points.spawn[1] });
  for (const hotspot of world.hotspots) {
    const route = findRoute(world.spawn, world.navigation.points[hotspot.pointId], world.navigation);
    assert.ok(route?.length > 1);
    for (const p of route) assert.ok(projectToRoad(p, world.navigation).distance < 0.001);
    const endpoint = advanceRoute(world.spawn, route.slice(1), 100000);
    assert.deepEqual(endpoint, world.navigation.points[hotspot.pointId]);
  }
});
test('mid-road retargeting stays on connected segments; off-map clicks cannot teleport', () => {
  const route = findRoute(world.spawn, world.navigation.points['archive-door'], world.navigation);
  const intermediate = advanceRoute(world.spawn, route.slice(1), 260);
  const revised = findRoute(intermediate, world.navigation.points['guild-door'], world.navigation);
  assert.ok(distance(revised[0], intermediate) < 0.001);
  assert.ok(revised.length > 3);
  assert.equal(findRoute(world.spawn, { x: -300, y: -300 }, world.navigation), null);
});
test('disconnected roads cannot bridge via close screen coordinates', () => {
  const navigation = { points: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 11, y: 0 }, d: { x: 20, y: 0 } },
    roads: [{ from: 'a', to: 'b', radius: 1 }, { from: 'c', to: 'd', radius: 1 }], speed: 1, snapTolerance: 1 };
  assert.equal(findRoute({ x: 5, y: 0 }, { x: 15, y: 0 }, navigation), null);
});
test('camera contains the map at base zoom and clamps every world edge when zoomed', () => {
  for (const [width, height] of [[1440, 900], [390, 844], [800, 400], [2560, 1440]]) {
    for (const zoom of [1, 1.8]) for (const hero of Object.values(world.navigation.points)) {
      const camera = fitCamera(width, height, world.bounds, hero, zoom);
      const sizeX = world.bounds.width * camera.scale, sizeY = world.bounds.height * camera.scale;
      if (sizeX <= width) assert.ok(Math.abs(camera.x - (width - sizeX) / 2) < 0.001);
      else assert.ok(camera.x <= 0.001 && camera.x + sizeX >= width - 0.001);
      if (sizeY <= height) assert.ok(Math.abs(camera.y - (height - sizeY) / 2) < 0.001);
      else assert.ok(camera.y <= 0.001 && camera.y + sizeY >= height - 0.001);
    }
  }
});
test('decoder rejects traversal, unknown version and non-finite navigation', () => {
  const wrongPath = JSON.parse(JSON.stringify(source)); wrongPath.assets.world.file = '../secret.png';
  assert.throws(() => decodeWorldManifest(wrongPath));
  assert.throws(() => decodeWorldManifest({ ...source, schemaVersion: 99 }));
  const broken = JSON.parse(JSON.stringify(source)); broken.navigation.points.spawn[0] = Infinity;
  assert.throws(() => decodeWorldManifest(broken));
});
test('hotspot polygon and movement retain intended interaction boundaries', () => {
  const polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(insidePolygon({ x: 5, y: 5 }, polygon), true);
  assert.equal(insidePolygon({ x: 20, y: 5 }, polygon), false);
  const route = [{ x: 3, y: 0 }, { x: 3, y: 4 }];
  assert.deepEqual(advanceRoute({ x: 0, y: 0 }, route, 5), { x: 3, y: 2 });
  assert.equal(route.length, 1);
});
