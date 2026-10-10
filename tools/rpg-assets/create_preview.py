"""Write a local, dependency-free art viewer; no executor or synthetic handoff."""
from pathlib import Path
import json

base=Path('output/product-completion/rpg')
hero=json.loads((base/'hero-contract.json').read_text())
scene=json.loads((base/'scene-contract.json').read_text())
data=json.dumps(dict(hero=hero,scene=scene),ensure_ascii=False)
html='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Мастерская гильдии — арт-превью</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#151b29;color:#eee6d3;font:16px/1.5 system-ui,sans-serif}main{max-width:1460px;margin:auto;padding:24px}header{display:flex;gap:20px;justify-content:space-between;align-items:center}h1{font:600 25px/1.2 Georgia,serif;margin:8px 0}.eyebrow{color:#bfaa76;font-size:12px;letter-spacing:.16em}p{color:#aab4c6;margin:8px 0}article{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:18px}.room{background:radial-gradient(ellipse at center,#273345,#1a2130 70%);border:1px solid #3c475c;border-radius:10px}img{max-width:100%;display:block}aside{padding:20px;background:#1d2637;border:1px solid #3c475c;border-radius:10px}canvas{width:256px;height:320px;max-width:100%;background:radial-gradient(ellipse at center,#344254,#202a3b 80%);border-radius:8px}button,select{font:inherit;padding:8px 12px;color:#eee6d3;background:#263349;border:1px solid #51647c;border-radius:6px;cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #d9b268;outline-offset:3px}.controls{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.small{font-size:13px}figure{margin:0}figcaption{padding:10px 16px;font-size:13px;color:#aab4c6}.facts{margin:16px 0;padding-top:12px;border-top:1px solid #3c475c}.facts p{font-size:13px}footer{padding:18px 0;color:#aab4c6;font-size:13px}@media(max-width:850px){article{grid-template-columns:1fr}aside{display:flex;gap:20px;flex-wrap:wrap}header{display:block}}
</style><main><header><div><div class="eyebrow">FLOWCAIRN / АРТ-ПРЕВЬЮ</div><h1>Мастерская гильдии</h1><p>Один зал, четыре станции, один герой. Настоящий offline-рендер Blender.</p></div><div class="small">Quaternius Standard · CC0<br>Blender 5.1.2 · Cycles CPU</div></header>
<article><figure class="room"><img src="guild-art-preview.png" alt="Объемный непиксельный зал с картой аналитика, чародеем у верстака, площадкой проверки и книгой наставника"><figcaption>Аналитик у карты → чародей у верстака → проверяющий на площадке. Наставник с книгой рядом.</figcaption></figure><aside><div><canvas id="hero" width="256" height="320" aria-label="Анимация чародея, художественное превью"></canvas><div class="controls"><select id="state" aria-label="Анимация"><option value="idle">Idle</option><option value="walk">Walk</option></select><button id="pause" type="button">Пауза</button></div></div><div><p class="small" id="status" role="status">Загрузка атласа…</p><div class="facts"><p>256 × 320 px на кадр<br>12 fps · одно направление<br>Фиксированный pivot · RGBA</p><p>Idle: 30 кадров<br>Walk: 16 кадров<br>Атласы меньше 2048 px</p></div><p class="small">Эта сцена проверяет графику. Она не показывает реальное исполнение, сообщения или передачу работы.</p></div></aside></article><footer>DOM-книга и runtime события подключаются отдельным этапом. Здесь нет имитации PROVEN или handoff.</footer></main>
<script>
const contract=CONTRACT;
const canvas=document.querySelector('#hero'),context=canvas.getContext('2d'),control=document.querySelector('#state'),pause=document.querySelector('#pause'),status=document.querySelector('#status');
const images={};let state='idle',paused=matchMedia('(prefers-reduced-motion: reduce)').matches,start=performance.now(),last=0;
pause.textContent=paused?'Играть':'Пауза';
Promise.all(['idle','walk'].map(key=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{images[key]=image;resolve()};image.onerror=reject;image.src='atlases/'+key+'.png'}))).then(()=>{status.textContent='Атласы загружены · 12 fps';draw(performance.now())}).catch(()=>status.textContent='Не удалось загрузить атлас');
function draw(now){const record=contract.hero.states[state],frame=paused?last:Math.floor((now-start)*12/1000)%record.frames;last=frame;context.clearRect(0,0,256,320);context.drawImage(images[state],frame%6*256,Math.floor(frame/6)*320,256,320,0,0,256,320);if(!document.hidden)requestAnimationFrame(draw)}
control.addEventListener('change',()=>{state=control.value;start=performance.now();last=0});pause.addEventListener('click',()=>{paused=!paused;start=performance.now()-last*1000/12;pause.textContent=paused?'Играть':'Пауза'});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&images[state]){start=performance.now()-last*1000/12;requestAnimationFrame(draw)}});
</script></html>'''.replace('CONTRACT',data)
(base/'preview.html').write_text(html)
print(base/'preview.html')
