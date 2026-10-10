/** Publish only an accepted cast into the package's authored image-space manifest. */
import { readFileSync, writeFileSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RPG_ASSET_FILES } from '../ai-graph-viewer/server.mjs';

const assets = fileURLToPath(new URL('../ai-graph-viewer/assets/rpg/', import.meta.url));
const cast = JSON.parse(readFileSync(path.join(assets, 'guild-cast.json'), 'utf8'));
if (cast.visualRevision !== 'fantasy-v2') throw new Error('Only the reviewed fantasy-v2 cast may enter the active manifest');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bundledFiles = {};
for (const file of RPG_ASSET_FILES.filter(file => file !== 'world.json')) {
  const source = path.join(assets, file), stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid authored asset ${file}`);
  bundledFiles[file] = { bytes: stat.size, sha256: hash(readFileSync(source)) };
}
const describe = (file, size, anchor = [0, 0]) => ({ file, sizePx: size, anchorPx: anchor, ...bundledFiles[file], alpha: true });
const p = cast.projection, x = p.unitX.map((value, i) => value - p.origin[i]), y = p.unitY.map((value, i) => value - p.origin[i]);
const point = (a, b) => [p.origin[0] + x[0] * a + y[0] * b, p.origin[1] + x[1] * a + y[1] * b].map(value => Math.round(value * 1000) / 1000);
const worldPoints = { spawn: [0, -3.4], south: [0, -2.7], plaza: [0, -2], junction: [0, -1],
  'guild-bend': [-1.25, -1], 'guild-lane': [-1.25, .3], 'guild-approach': [-1.25, .9], 'guild-door': [-3, .9],
  'workshop-lane': [.25, -1], 'workshop-approach': [.25, -.3], 'workshop-door': [.25, .3],
  'east-lane': [1.25, -1], 'bridge-west': [1.25, -2.1], 'bridge-mid': [2.2, -2.1], 'bridge-east': [3, -2.1], 'archive-approach': [3, -1.85], 'archive-door': [3, -1.5],
  'mentor-lane': [-1.25, -2.7], 'mentor-door': [-2.8, -2.4] };
const points = Object.fromEntries(Object.entries(worldPoints).map(([id, [a, b]]) => [id, point(a, b)]));
const paths = [['spawn','south','plaza','junction'], ['junction','guild-bend','guild-lane','guild-approach','guild-door'],
  ['junction','workshop-lane','workshop-approach','workshop-door'], ['junction','east-lane','bridge-west','bridge-mid','bridge-east','archive-approach','archive-door'], ['south','mentor-lane','mentor-door']];
const edges = paths.flatMap(ids => ids.slice(1).map((to, i) => ({ from: ids[i], to, radiusPx: 24 })));
const hotspots = [['guild','Гильдия','analyst','guild-door'],['workshop','Мастерская','mage','workshop-door'],['archive','Архив','checker','archive-door'],['mentor','Наставник','mentor','mentor-door']].map(([id,label,role,arrivalNode]) => {
  const [px, py] = cast.roles[role].station.pixel;
  return { id, label, scene:'world', arrivalNode, labelAnchorPx:[px,py-185], polygonPx:[[px-68,py-165],[px+68,py-165],[px+68,py+20],[px-68,py+20]], action:'open-book' };
});
const world = { schemaVersion:1, visualRevision:'fantasy-v2', guildManifest:'guild-cast.json', projection:{kind:'orthographic-prerender',coordinates:'image-pixels',transform:'identity'},
  bounds:{x:0,y:0,width:1440,height:1080}, viewport:{fit:'contain',preserveAspect:true,matte:'#1b252c'}, background:'world',
  assets:{world:describe('guild-room.png',[1440,1080]),'hero-idle':describe('guild-mentor-portrait.png',[256,320],cast.pivot)},
  uiAssets:{'ui-codex':describe('ui-codex.png',[1536,1024]),'ui-quest-scroll':describe('ui-quest-scroll.png',[1024,1536])},
  bundledFiles, rooms:{}, spawn:{pointId:'spawn'},
  navigation:{points,edges,bidirectional:true,clickSnapTolerancePx:28,speedPxPerSecond:180,interactionRadiusPx:45}, hotspots,
  rendering:{charactersSortBy:'foot-y',foregroundLayers:true,animationFps:12,hiddenTab:'stop',reducedMotion:'static-and-instant-navigation'},
  restrictions:['Executor owns execution and proof; the scene only projects snapshots.','Idle faculty does not imply an assigned executor.','Only fresh dependency-start receipts animate once; history/reload establishes a silent baseline.','All text, forms, books, errors and commands remain in the DOM.'] };
writeFileSync(path.join(assets,'world.json'), JSON.stringify(world,null,2)+'\n');
console.log(JSON.stringify({ files:Object.keys(bundledFiles).length, bytes:Object.values(bundledFiles).reduce((sum,item)=>sum+item.bytes,0), worldBytes:statSync(path.join(assets,'world.json')).size }));
