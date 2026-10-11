import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('docs/demo'), out=path.resolve('output/readme-demo/qa');mkdirSync(out,{recursive:true});
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.mp4':'video/mp4'};
const server=createServer((req,res)=>{try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(root+path.sep)||!statSync(file).isFile())throw Error();res.setHeader('Content-Type',types[path.extname(file)]??'text/plain');res.end(readFileSync(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];
try{
 for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844],['zoom',720,450]]){
  await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:'reduce'});await page.goto(url+'/?viewport='+name+'#plan');
  await expect(page.locator('#chapter-title')).toHaveText('План и разрешение');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name} overflow`);
  await expect(page.locator('#frame')).toBeVisible();
  assert.equal(await page.locator('#frame').evaluate(e=>e.complete&&e.naturalWidth===1440),true);
  await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});
  await page.getByRole('button',{name:'4 Выполнение',exact:true}).click();
  await expect(page.locator('#chapter-title')).toHaveText('Выполнение');
  await page.locator('#graph button').last().click();
  await expect(page.locator('#node-detail')).toContainText('Зависит от');
  await page.getByRole('button',{name:'6 Требование подтверждено',exact:true}).click();
  await expect(page.locator('#proof')).toHaveText('PROVEN');
  await page.getByRole('button',{name:'8 Код изменился — доказательство устарело',exact:true}).click();
  await expect(page.locator('#proof')).not.toHaveText('PROVEN');
  await expect(page.locator('#next')).toBeDisabled();
  await page.locator('#prev').focus();await page.keyboard.press('Enter');await expect(page.locator('#chapter-title')).toHaveText('Сохраненный код');
  const data=await (await page.request.get(url+'/media/recording.json')).json();
  for(const f of data.frames){
    await page.locator('#chapters button').nth(data.frames.indexOf(f)).click();
    for(const button of await page.locator('#graph button').all()){
      await button.click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name} ${f.id}: hash overflow`);
    }
  }
  await page.getByRole('button',{name:'6 Требование подтверждено',exact:true}).click();
  await page.locator('#graph button').filter({hasText:'Проверить счетчик'}).click();
  await page.locator('#node-detail').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,`${name}-hashes.png`),fullPage:true});
  results.push({viewport:name,width,height,overflow:false,chapters:true,nodeInspection:true,keyboard:true,provenAndStale:true});
 }
 await page.goto(url+'/#recording');await expect(page.locator('#play')).toBeEnabled();assert.equal(new URL(page.url()).hash,'#recording');
 await page.getByRole('button',{name:'Смотреть по шагам',exact:true}).click();await expect(page.locator('#play')).toHaveText('Остановить показ');await page.locator('#play').click();
 const recorded=await page.request.get(url+'/media/recording.json');assert.equal(recorded.status(),200);
 const json=await recorded.json();assert.deepEqual(json.observations.map(o=>o.exitCode),[1,0]);
 for(const f of json.frames){assert.equal((await page.request.get(url+'/'+f.image)).status(),200);}
 assert.equal((await page.request.get(url+'/media/session.mp4')).status(),200);
 await page.route('**/media/recording.json',route=>route.abort());await page.reload();await expect(page.locator('#load-error')).toBeVisible();await expect(page.locator('#play')).toBeDisabled();
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({results,consoleErrors:errors,recordingAndImages:true,video:true,loadError:true},null,2));console.log(JSON.stringify(results));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
