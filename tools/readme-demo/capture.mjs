// Public demo capture: synthetic AI; real Executor, patch, verifier and UI.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createGuildFixture, guildGoal, guildInstruction } from '../ai-graph-viewer/tests/guild-workflow-fixture.mjs';
import { newQuest, closeSurface, openQuest, openDiagnostics } from '../ai-graph-viewer/tests/ui-paths.mjs';
const media = path.resolve('.github/media/demo');
mkdirSync(media, {recursive:true});
const f = await createGuildFixture({repair:true, hold:true, dist:path.resolve('tools/ai-graph-viewer/dist')});
const browser = await chromium.launch();
const context = await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:'output/readme-demo/video',size:{width:1440,height:900}}});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const frames=[];
const pending = async action => { await expect.poll(()=>f.pending().some(p=>p.action===action),{timeout:20000}).toBe(true); return f.pending().find(p=>p.action===action); };
async function capture(id, title, explanation) {
  await page.waitForTimeout(1000); // Hold each real screen long enough for the recording.
  await page.screenshot({path:path.join(media,`${id}.jpg`),type:'jpeg',quality:85});
  const s=f.current();
  // Allowlist public fields; no session token, local root or private store is exported.
  frames.push({id,title,explanation,image:`${id}.jpg`,value:readFileSync(path.join(f.root,'counter.json'),'utf8').trim(),
    runId:s?.runId??null,planHash:s?.planHash??null,proof:s?.proof?.status??null,
    coverage:s?.proof?.coverage??null,
    nodes:(s?.nodes??[]).map(n=>({id:n.id,title:n.title,status:n.status,action:n.action.id,needs:n.needs,receiptIds:n.receiptIds,checks:n.checks.map(c=>({id:c.id,exitCode:c.exitCode,passed:c.passed,inputHash:c.inputHash}))}))});
  console.log(`Captured ${id}`);
}
try {
  await page.goto(`${f.url}/#session=${f.token}`);
  await expect(page.getByTestId('guild-world')).toBeVisible();
  await newQuest(page);
  await page.getByLabel('Название',{exact:true}).fill(guildGoal);
  await page.getByLabel('Что нужно сделать',{exact:true}).fill(guildInstruction);
  await page.getByLabel('Номер задачи',{exact:true}).fill('DEMO-001');
  await capture('request','Поручение','Сохранить число 2 в counter.json. Проверить результат существующим verify.mjs.');
  await page.getByRole('button',{name:'Начать анализ',exact:true}).click();
  await pending('ai-analyze'); await closeSurface(page);
  await capture('analysis','Исследование','Настоящий интерфейс показывает активный анализ. Ответ анализатора в этой записи подготовлен заранее.');
  f.release(); await pending('ai-plan');
  f.release(); await expect.poll(()=>f.current()?.gates.some(g=>g.type==='approve-plan'),{timeout:20000}).toBe(true);
  await openQuest(page);
  await capture('plan','План и разрешение','Согласование обязательно: область записи — counter.json, проверка — verify.mjs. До нажатия кнопки файл равен 0.');
  assert.equal(readFileSync(path.join(f.root,'counter.json'),'utf8'),'0\n');
  await page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true}).click();
  await pending('ai-implement'); await closeSurface(page);
  await capture('work','Выполнение','Executor ожидает ответ исполнителя. Герой связан с настоящим активным узлом, а не с таймером витрины.');
  f.release(); await pending('check-counter');
  f.release(); await pending('ai-implement');
  assert.ok(f.observations.some(o=>o.exitCode!==0&&o.value==='1\n'));
  await capture('repair','Проверка нашла ошибку','Первая правка записала 1 вместо 2. Настоящий процесс verify.mjs завершился с ошибкой; Executor начал ограниченное исправление.');
  f.release();
  for(let i=0;i<12;i++) {
    await expect.poll(()=>f.pending().length>0||f.current()?.proof.status==='PROVEN',{timeout:20000}).toBe(true);
    if(f.current()?.proof.status==='PROVEN') break;
    f.release();
  }
  assert.equal(f.current().proof.status,'PROVEN');
  assert.equal(readFileSync(path.join(f.root,'counter.json'),'utf8'),'2\n');
  assert.ok(f.observations.some(o=>o.exitCode===0));
  await expect(page.getByTestId('guild-world')).toHaveAttribute('data-completed','true');
  await openDiagnostics(page,'result');
  await capture('result','Требование подтверждено','Файл содержит 2. Проверка завершилась с exit 0; оценка связи проверки с требованием предоставлена подставным reviewer. Executor рассчитал PROVEN.');
  await openQuest(page);
  await page.getByRole('button',{name:'Карта этапов и разбор',exact:true}).click();
  await page.getByRole('button',{name:'Открыть итоговый материал',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Сохраненный разбор',exact:true})).toBeVisible();
  await capture('code','Сохраненный код','Открыт настоящий reader с сохраненными исходниками этого запуска. AI-объяснение здесь не генерировалось.');
  await closeSurface(page);
  writeFileSync(path.join(f.root,'counter.json'),'3\n');
  await page.reload();
  await expect(page.getByTestId('guild-world')).toHaveAttribute('data-completed','false');
  await openDiagnostics(page,'result');
  await capture('stale','Код изменился — доказательство устарело','После внешней записи числа 3 прежний успех больше не подтверждает текущий файл. Старый отчет сохраняется в истории.');
  assert.notEqual(f.current().proof.status,'PROVEN');
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(media,'recording.json'),JSON.stringify({schemaVersion:1,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),capturedAt:new Date().toISOString(),provenance:'Synthetic AI responses; real WorkflowService, file edits, Node verifier, receipts and current UI. No external inference.',observations:f.observations,frames},null,2)+'\n');
} finally {
  await context.close(); await page.video().saveAs('output/readme-demo/session.webm'); await browser.close(); await f.close();
}
