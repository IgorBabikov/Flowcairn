import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { snapshot, plan, allDenied } from '../../tests/fixtures.mjs';
const require=createRequire(import.meta.url);
const bundle=await build({stdin:{contents:`import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';export const render=(c,p)=>renderToStaticMarkup(createElement(c,p));export * from './DiagnosticBook';export * from './DiagnosticNodes';export {COPY} from '../ui-copy';`,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'react-instance',setup(b){b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}));}}]});
const m=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text+'\n//# sourceURL=diagnostics-unit.mjs').toString('base64')}`);
const noCommand=()=>assert.fail('Rendering must not execute commands');
function controller(s=snapshot()) {return {snapshot:s,plan,locale:'ru',labels:m.COPY.ru,diagnosticPage:'nodes',selectedNode:s.nodes[0],diagnosticNodes:s.nodes,currentNodeId:s.nodes[0].id,events:[],runs:[],compareRunId:'',comparePlan:null,compareError:null,compareLoading:false,busy:false,pending:null,snapshotUnavailable:false,streamConnected:true,displayedError:null,stopError:null,notice:'',execute:noCommand,openGate:noCommand,requestReplan:noCommand,openReceipt:noCommand,openArtifact:noCommand};}
test('legacy diagnostic book retains plan, node identity, gate actions and dependency facts without canvas',()=>{
 const c=controller();const html=m.render(m.DiagnosticBook,{controller:c,onClose:noCommand,onQuest:noCommand});
 for(const text of ['diagnostic-tab-plan','diagnostic-node-select','approve-plan','human-approve','data-node-id','Зависимости','Подтвердить'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/react-flow|<canvas|contenteditable/);
});
test('historical node evidence retains owning run and manual write controls stay denied',()=>{
 const c=controller();c.selectedNode={...c.selectedNode,id:'history-analysis',sourceRunId:'run-owner',sourcePlanHash:'a'.repeat(64),capabilities:allDenied};c.diagnosticNodes=[c.selectedNode];
 const html=m.render(m.DiagnosticNodes,{controller:c,evidence:true});assert.match(html,/run-owner/);assert.match(html,/Отчет/);
 c.snapshotUnavailable=true;const denied=m.render(m.DiagnosticNodes,{controller:c,evidence:false});assert.match(denied,/<fieldset[^>]*disabled/);assert.match(denied,/Ожидается подтверждение плана/);
});
test('autonomous diagnostics omit legacy plan chapter and expose stale read warning',()=>{
 const c=controller({...snapshot(),workflow:'autonomous'});c.snapshotUnavailable=true;
 const html=m.render(m.DiagnosticBook,{controller:c,onClose:noCommand,onQuest:noCommand});assert.doesNotMatch(html,/diagnostic-tab-plan/);assert.match(html,/Текущее состояние недоступно/);assert.match(html,/diagnostic-tab-history/);
});
