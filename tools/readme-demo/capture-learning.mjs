// README-only capture of the production reader with explicitly synthetic lesson data.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fixture, hash } from '../ai-graph-viewer/src/learning/learning-fixtures.test-support.mjs';
import { mockApi, snapshot, token } from '../ai-graph-viewer/tests/fixtures.mjs';
import { RPG_ASSET_FILES } from '../ai-graph-viewer/server.mjs';
const dist=path.resolve('tools/ai-graph-viewer/dist'), out=path.resolve('.github/media/learning');
mkdirSync(out,{recursive:true});
const allowed=new Set(['index.html','app.js','app.css','fonts/Manrope-Latin-Variable.woff2','fonts/Manrope-Cyrillic-Variable.woff2',...RPG_ASSET_FILES.map(f=>`assets/rpg/${f}`)]);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json','.woff2':'font/woff2'};
const server=createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!allowed.has(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',types[path.extname(name)]);res.end(readFileSync(path.join(dist,name)));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900}});
const f=fixture();
const text=[
 'export function createSearch(load, show) {','  let latest = 0;','  return async function search(query) {','    const request = ++latest;','    try {','      const products = await load(query);','      if (request !== latest) return;','      show({ products, error: null });','    } catch {','      if (request !== latest) return;',"      show({ products: [], error: 'Ошибка поиска' });",'    }','  };','}',
].join('\n');
const lines=text.split('\n');
const fileHash=createHash('sha256').update(text).digest('hex');
const source={...f.source,path:'src/search.js',fileHash,bytes:Buffer.byteLength(text),lineCount:lines.length,chunkHashes:[fileHash]};
const anchor=(startLine,endLine)=>({sourceId:source.id,fileHash,startLine,endLine,quote:lines.slice(startLine-1,endLine).join('\n')});
const material={...f.response.material,goal:'Исправить поиск товаров: старый ответ не заменяет новую выдачу',outcome:'Последний запрос управляет списком и ошибками',status:'complete',gaps:[],planHash:snapshot().planHash,sourceCatalogHash:hash({version:1,sources:[source]})};
const materialHash=hash(material);
const steps=[
 {...f.lesson.steps[0],id:'request-order',title:'Почему в списке остается «термос»',caller:'Событие input вызывает search(input.value) в форме поиска.',input:'Сначала «рюкзак» (request=1), затем «термос» (request=2). Второй ответ приходит раньше первого.',anchors:[anchor(3,8)],transformations:['Новый ввод увеличивает latest до 2. Каждый вызов сохраняет свой request.','Ответ «термос»: 2 === 2 → show обновляет список.','Поздний ответ «рюкзак»: 1 !== 2 → return. Список не меняется.'],output:'На экране остаются товары по последнему запросу.',next:'show обновляет состояние и перерисовывает список.',purpose:'Защита от гонки асинхронных запросов.',changeConsequence:'Без проверки старый ответ перезапишет новую выдачу.',alternatives:['Порядок ответов сервера может отличаться от порядка ввода.'],origin:{kind:'teaching-example',label:'Демонстрационные данные, не ответ реального API.',receiptId:null,artifactId:null,anchor:anchor(3,8)}},
 {...f.lesson.steps[0],id:'request-errors',title:'Старая ошибка тоже не меняет экран',caller:'catch обрабатывает отклоненный Promise от load(query).',input:'Выдача «термос» уже показана. Запрос «рюкзак» позже завершился ошибкой.',anchors:[anchor(9,12)],transformations:['У старого запроса request=1, а latest уже равен 2.','Проверка в catch завершает старый вызов без show.','Только ошибка текущего запроса очищает товары и показывает сообщение.'],output:'Успешная новая выдача остается на экране.',next:'Пользователь может продолжить поиск.',purpose:'Не показывать ошибку запроса, который уже не нужен.',changeConsequence:'Без строки 10 старая ошибка очистит актуальный список.',alternatives:['Проверка только в try не защищает от устаревшей ошибки.'],origin:{kind:'teaching-example',label:'Демонстрационный сценарий ошибки.',receiptId:null,artifactId:null,anchor:anchor(9,12)}},
];
const lesson={...f.lesson,materialHash,title:'Ваш поиск: от ввода до результата',scope:'Разбор frontend-исправления в src/search.js',steps,wholeFlow:'input → search(query) → request → await load → проверка latest → show → список товаров',takeaways:['После await нужно снова проверить актуальность запроса.','Защита нужна и в успешном, и в ошибочном ответе.'],limitations:['Данные урока подготовлены для демонстрации. AI-вызов и реальный API не запускались.'],questions:[{id:'predict-result',text:'Что увидит пользователь, если убрать проверку request !== latest из catch, а старый запрос завершится ошибкой после нового?',anchors:[anchor(9,12)]}]};
const lessonHash=hash(lesson);
const response={...f.response,id:materialHash,material,sources:[source],lessonHash,progress:'unread',freshness:{state:'current',reason:null}};
const state={...snapshot(),...f.snapshot,planHash:material.planHash,task:{...snapshot().task,title:material.goal,goal:material.goal},approvalExpiresAt:Date.now()+3600000,continuation:{...f.snapshot.continuation,materialHash},learning:{...f.snapshot.learning,stages:[{...f.snapshot.learning.stages[0],title:'Поиск без устаревших ответов',materialHash,lessonHash,freshness:'current',materialStatus:'complete',progress:'unread',reason:null}]}};
const api=await mockApi(page,state);
await page.route('**/api/runs/*/learning/**',async route=>{const url=new URL(route.request().url());
 if(url.pathname.endsWith(`/materials/${materialHash}`))return route.fulfill({json:response});
 if(url.pathname.endsWith(`/lessons/${lessonHash}`))return route.fulfill({json:{id:lessonHash,lesson}});
 if(url.pathname.endsWith(`/sources/${source.id}`)){const startLine=Number(url.searchParams.get('startLine')||1),endLine=Math.min(lines.length,startLine+Number(url.searchParams.get('lineCount')||100)-1);return route.fulfill({json:{sourceId:source.id,fileHash,text:lines.slice(startLine-1,endLine).join('\n'),startLine,endLine,totalLines:lines.length,next:null}});}
 return route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'Demo resource unavailable'}}});
});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/#session=${token}`);
 await page.getByRole('button',{name:'Карта этапов и разбор',exact:true}).click();
 await page.getByRole('button',{name:'Открыть сохраненный материал',exact:true}).click();
 await expect(page.getByRole('heading',{name:steps[0].title,exact:true})).toBeVisible();
 await expect(page.locator('.saved-code')).toContainText('createSearch');
 await page.screenshot({path:path.join(out,'search-flow.jpg'),type:'jpeg',quality:90});
 await page.getByRole('button',{name:'Следующий шаг разбора',exact:true}).click();
 await expect(page.getByRole('heading',{name:steps[1].title,exact:true})).toBeFocused();
 await expect(page.locator('.source-line-selected')).toHaveCount(4);
 await page.screenshot({path:path.join(out,'search-error.jpg'),type:'jpeg',quality:90});
 await page.getByRole('textbox',{name:'Твой ответ',exact:true}).fill('Старая ошибка вызовет show и очистит новую выдачу. Проверка нужна в catch, потому что await может завершиться ошибкой.');
 await page.getByRole('heading',{name:'Попробуй сам',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(out,'search-question.jpg'),type:'jpeg',quality:90});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('navigation',{name:'Переходы по книге'}).getByRole('button',{name:'Код',exact:true}).click();
 await expect(page.locator('.saved-code')).toBeVisible();
 await page.screenshot({path:path.join(out,'search-mobile.jpg'),type:'jpeg',quality:90});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(errors).toEqual([]);expect(api.calls).toEqual([]);
 writeFileSync('output/readme-demo/learning-check.json',JSON.stringify({ui:'current production reader',source:fileHash,steps:2,selectedLines:4,mobile:true,externalAI:false,errors},null,2));
 console.log('Captured frontend lesson: flow, error, self-question, mobile. No execution calls.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
