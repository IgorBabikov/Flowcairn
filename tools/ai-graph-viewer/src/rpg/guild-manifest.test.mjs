import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: "export * from './guild-manifest'; export * from './guild-motion'; export * from './guild-presentation';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { decodeGuildManifest, worldPoint, imagePoint, handoffRoute, walkingDirection, advanceGuildRoute, actorAssignments } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const roles = ['analyst','mage','checker','reviewer','mentor'];
function authoredFixture() {
  return { schemaVersion:1, resolution:[1440,1080], frameSize:[256,320], pivot:[128,242],anchor:[.5,242/320],spriteScale:.83237,fps:12,room:'guild-room.png',
    projection:{origin:[720,601],unitX:[779,635],unitY:[779,567]},
    directions:{se:{screenVector:[-59,34]},nw:{screenVector:[59,-34]},ne:{screenVector:[59,34]},sw:{screenVector:[-59,-34]}},
    roles:Object.fromEntries(roles.map((role,i)=>[role,{station:{world:[i-2,0,0],pixel:[720+(i-2)*59,601+(i-2)*34],direction:'nw'},
      states:Object.fromEntries(['idle','walk','work','handoff'].map(state=>[state,Object.fromEntries((state==='walk'?['se','nw','ne','sw']:['se','nw']).map(direction=>[direction,{image:`guild-${role}-${state}-${direction}.png`,atlas:`guild-${role}-${state}-${direction}.json`,frames:12,rootMotion:false,metersPerSecond:1}]))]))}])),
    foregrounds:roles.map((role,i)=>({role,file:`guild-foreground-${role}.png`,depthY:400+i*20})) };
}
test('bounded authored manifest rejects URL/traversal, wrong role file, root motion and singular projection',()=>{
  const valid=authoredFixture(); assert.equal(decodeGuildManifest(valid).roles.mage.states.walk.ne.speed,1);
  valid.foregrounds[0].alphaFrame=[547,301,764,487];assert.deepEqual(decodeGuildManifest(valid).foregrounds[0].frame,{x:547,y:301,width:217,height:186});
  for(const mutate of [d=>d.roles.mage.states.walk.ne.atlas='https://example.test/private.json',d=>d.foregrounds[0].file='../secret.png',d=>d.foregrounds[0].alphaFrame=[500,300,1441,500],d=>d.roles.analyst.states.idle.se.image='guild-mentor-idle-se.png',d=>d.roles.mage.states.walk.ne.rootMotion=true,d=>d.projection.unitY=d.projection.unitX]) {
    const altered=JSON.parse(JSON.stringify(valid));mutate(altered);assert.throws(()=>decodeGuildManifest(altered));
  }
});
test('image/world projection roundtrips and walk routing uses exactly four authored world axes',()=>{
  const m=decodeGuildManifest(authoredFixture());
  for(const p of [{x:-3,y:.9},{x:.25,y:.3},{x:3,y:-1.5}]) {
    const restored=worldPoint(imagePoint(p,m),m);assert.ok(Math.hypot(restored.x-p.x,restored.y-p.y)<1e-8);
  }
  const route=handoffRoute(imagePoint({x:-3,y:.9},m),imagePoint({x:3,y:-1.5},m),m);
  for(let i=1;i<route.length;i++) {
    const a=worldPoint(route[i-1],m),b=worldPoint(route[i],m);
    assert.ok(Math.abs(a.x-b.x)<1e-6||Math.abs(a.y-b.y)<1e-6,'no sideways gait');
    assert.ok(['se','nw','ne','sw'].includes(walkingDirection(route[i-1],route[i],m)));
  }
  const path=route.slice(1),start=route[0];
  const step=advanceGuildRoute(start,path,.2,m),a=worldPoint(start,m),b=worldPoint(step.point,m);
  assert.ok(Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-.2)<1e-8);
});
test('six rendered actors represent actual concurrent assignments; idle faculty never invents workers',()=>{
  const view={workers:[],freshness:'current',runtimeStatus:'ready'};
  assert.equal(actorAssignments(view).length,5);assert.ok(actorAssignments(view).every(item=>item.worker===null));
  const worker={id:'one',role:'mage',active:true,historical:false,state:'running'};
  view.workers=[worker,{...worker,id:'two'}];
  assert.equal(actorAssignments(view).length,6);assert.equal(actorAssignments(view).filter(item=>item.worker?.active).length,2);
});
