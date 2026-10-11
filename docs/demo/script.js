'use strict';
const $ = selector => document.querySelector(selector);
let recording, current=0, selected=null, timer=null;
const states={'waiting-for-human':'Ждет решения',passed:'Завершен',running:'Выполняется',blocked:'Заблокирован',ready:'Готов',pending:'Ожидает',failed:'Ошибка',stale:'Устарел',uncertain:'Неопределенность',skipped:'Пропущен'};
const element=(tag,text,className)=>{const e=document.createElement(tag);e.textContent=text;if(className)e.className=className;return e;};
function stop(){clearInterval(timer);timer=null;$('#play').textContent='Смотреть по шагам';$('#play').setAttribute('aria-pressed','false');}
function detail(node){
  selected=node.id;
  const panel=$('#node-detail');panel.replaceChildren(element('h3',node.title),element('code',node.id));
  const list=document.createElement('dl');
  for(const [label,value] of [['Действие',node.action],['Состояние',states[node.status]??node.status],['Зависит от',node.needs.join(', ')||'Нет зависимостей'],['Отчеты',node.receiptIds.length?'':'Пока нет']]){
    list.append(element('dt',label),element('dd',value));
  }
  for(const receipt of node.receiptIds)list.append(element('dd',receipt));
  for(const check of node.checks){list.append(element('dt',`Проверка ${check.id}`),element('dd',`exit ${check.exitCode??'неизвестен'} · ${check.passed?'прошла':'не прошла'}`),element('dd',`Input hash: ${check.inputHash}`));}
  panel.append(list);
  for(const button of $('#graph').children)button.setAttribute('aria-pressed',String(button.dataset.node===node.id));
}
function render(index,announce=true){
  current=index;const f=recording.frames[index];
  $('#position').textContent=`Момент ${index+1} из ${recording.frames.length}`;
  $('#chapter-title').textContent=f.title;$('#explanation').textContent=f.explanation;
  $('#frame').src=f.image;$('#frame').alt=`Flowcairn: ${f.title}. ${f.explanation}`;$('#full-frame').href=f.image;
  $('#value').textContent=f.value;$('#proof').textContent=f.proof??'Еще нет';
  $('#coverage').textContent=f.coverage?`${f.coverage.proven} / ${f.coverage.required}`:'Еще нет';
  $('#prev').disabled=index===0;$('#next').disabled=index===recording.frames.length-1;
  for(const [i,b] of [...$('#chapters').children].entries()){if(i===index)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');}
  $('#graph-context').textContent=f.runId?`Запуск ${f.runId} · ${f.nodes.length} узлов`:'До анализа план еще не создан.';
  $('#graph').replaceChildren();
  for(const node of f.nodes){
    const b=element('button','', 'node');b.type='button';b.dataset.node=node.id;
    b.append(element('strong',node.title),element('span',states[node.status]??node.status),element('small',`Зависит от: ${node.needs.join(', ')||'нет'}`));
    b.addEventListener('click',()=>{stop();detail(node);});$('#graph').append(b);
  }
  const node=f.nodes.find(n=>n.id===selected)??f.nodes.find(n=>n.status==='running')??f.nodes[0];
  if(node)detail(node);else $('#node-detail').replaceChildren(element('h3','Сначала — поручение'),element('p','До анализа здесь нет узлов и отчетов.'));
  if(announce)$('#announcement').textContent=`${index+1} из ${recording.frames.length}. ${f.title}.`;
  if(announce)history.replaceState(null,'',`#${f.id}`);
}
$('#prev').addEventListener('click',()=>{stop();render(Math.max(0,current-1));});
$('#next').addEventListener('click',()=>{stop();render(Math.min(recording.frames.length-1,current+1));});
$('#play').addEventListener('click',()=>{
  if(timer){stop();return;}
  if(current===recording.frames.length-1)render(0);
  $('#play').textContent='Остановить показ';$('#play').setAttribute('aria-pressed','true');
  timer=setInterval(()=>{if(current>=recording.frames.length-1){stop();return;}render(current+1);if(current===recording.frames.length-1)stop();},6000);
});
window.addEventListener('hashchange',()=>{if(!recording)return;const index=recording.frames.findIndex(f=>f.id===location.hash.slice(1));if(index>=0){stop();render(index,false);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
fetch('media/recording.json').then(response=>{if(!response.ok)throw Error('recording');return response.json();}).then(data=>{
  if(data.schemaVersion!==1||!Array.isArray(data.frames)||!data.frames.length)throw Error('format');
  recording=data;
  data.frames.forEach((f,i)=>{const b=element('button','');b.type='button';b.append(element('span',String(i+1)),element('strong',f.title));b.addEventListener('click',()=>{stop();render(i);});$('#chapters').append(b);});
  data.observations.forEach((o,i)=>{const row=document.createElement('tr');[i+1,o.value.trim(),o.exitCode,o.exitCode===0?'Проверка прошла':'Проверка не прошла'].forEach(v=>row.append(element('td',String(v))));$('#checks').append(row);});
  $('#play').disabled=false;
  render(Math.max(0,data.frames.findIndex(f=>f.id===location.hash.slice(1))),false);
}).catch(()=>{const error=$('#load-error');error.hidden=false;error.textContent='Не удалось загрузить данные записи. Обновите страницу или посмотрите видео ниже.';$('#position').textContent='Запись недоступна';});
