const q = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const shell = q('.workspace-body');
const context = q('#context-body');
const defaultContext = context.innerHTML;
const dialog = q('#dialog');
let lastFocus = null;
const escapeText = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const steps = all('.plan-step').map((el,index)=>({
  title:el.querySelector('.step-work strong').textContent,
  outcome:el.querySelector('.step-outcome').textContent,
  check:el.querySelector('.check-label').textContent,
  index
}));
const narrow = window.matchMedia('(max-width:1099px)');
function setContext(open) {
  shell.classList.toggle('context-closed',!open);
  q('#context-toggle').setAttribute('aria-expanded',String(open));
}
function resetContext() {
  context.innerHTML=defaultContext;
  q('#context-title').textContent='Критерии и границы';
  all('[data-step]').forEach(el=>{el.classList.remove('selected');el.setAttribute('aria-pressed','false');});
  setContext(true);
}
function selectStep(index) {
  const step=steps[index];
  all('[data-step]').forEach(el=>{const selected=Number(el.dataset.step)===index;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',String(selected));});
  q('#context-title').textContent='Детали шага';
  context.innerHTML=`<button class="back-context" data-reset-context>← Критерии задачи</button><span class="eyebrow">ШАГ ${index+1} ИЗ ${steps.length}</span><h3 class="step-context-title">${escapeText(step.title)}</h3><p class="step-context-subtitle">Ожидает согласования плана</p><section class="step-context-section"><h3>Ожидаемый результат</h3><p>${escapeText(step.outcome)}</p></section><section class="step-context-section"><h3>Как проверим</h3><p>${escapeText(step.check)}</p><p>Результат будет подтвержден только после выполнения проверки для актуального состояния проекта.</p></section><section class="step-context-section"><h3>Область задачи</h3><p><code>src/registration</code></p></section>`;
  setContext(true);
}
q('#graph-chain').innerHTML=steps.map(step=>`<button class="graph-node" data-step="${step.index}" aria-pressed="false"><small>ШАГ ${step.index+1}</small><strong>${escapeText(step.title)}</strong><span>Ожидает решения</span></button>`).join('');
all('[data-step]').forEach(el=>{
  el.setAttribute('aria-label',`Шаг ${Number(el.dataset.step)+1}: ${steps[Number(el.dataset.step)].title}`);
  el.setAttribute('aria-pressed','false');
  el.addEventListener('click',()=>selectStep(Number(el.dataset.step)));
});
context.addEventListener('click',event=>{if(event.target.closest('[data-reset-context]'))resetContext();});
all('[data-view]').forEach(el=>el.addEventListener('click',()=>{
  const graph=el.dataset.view==='graph';
  q('#task-view').hidden=graph;q('#graph-view').hidden=!graph;
  all('[data-view]').forEach(tab=>{const selected=tab===el;tab.classList.toggle('active',selected);tab.setAttribute('aria-pressed',String(selected));});
  q('.primary-area').setAttribute('aria-label',graph?'Граф задачи':'План задачи');
}));
q('#context-toggle').addEventListener('click',()=>setContext(shell.classList.contains('context-closed')));
q('#close-context').addEventListener('click',()=>{setContext(false);q('#context-toggle').focus();});
q('#open-criteria').addEventListener('click',resetContext);
function showDialog(title,content) {
  lastFocus=document.activeElement;
  q('#dialog-title').textContent=title;q('#dialog-body').innerHTML=content;
  dialog.showModal();
}
dialog.addEventListener('close',()=>lastFocus?.focus());
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!dialog.open&&!shell.classList.contains('context-closed')){setContext(false);q('#context-toggle').focus();}
});
q('#approve').addEventListener('click',()=>showDialog('Согласование плана',`<p>Вы разрешаете выполнить пять шагов в области <code>src/registration</code>.</p><p>Критерии приемки и границы изменений сохраняются. Новые права потребуют отдельного решения.</p><p class="dialog-hint">Это макет. AI не запускается, файлы проекта не изменяются.</p>`));
q('#revise').addEventListener('click',()=>showDialog('Что изменить в плане?',`<label for="feedback">Уточнение к текущему плану</label><textarea id="feedback" placeholder="Например: сначала проверить ограничения ИНН"></textarea><p class="dialog-hint">Поле демонстрационное. Текст никуда не отправляется.</p>`));
const projectInfo=()=>showDialog('Состояние проекта','<p><strong>Форма регистрации</strong></p><p>Вы смотрите демонстрационную задачу. Исполнитель не подключен; выполнение и проверки не запускались.</p><p class="dialog-hint">Основной интерфейс Flowcairn остается без изменений.</p>');
q('#project-status').addEventListener('click',projectInfo);q('#mobile-project').addEventListener('click',projectInfo);
q('#settings').addEventListener('click',()=>showDialog('Настройки проекта','<p>В макете сохранены привычные цвета, Manrope и логика Flowcairn. Меняется расположение рабочих областей на широком экране.</p><p class="dialog-hint">Настройки и права реального проекта здесь не изменяются.</p>'));
q('#new-task').addEventListener('click',()=>showDialog('Новая задача','<p>Этот макет показывает согласование уже подготовленного плана.</p><p class="dialog-hint">Создание реальной задачи остается в текущем интерфейсе Flowcairn.</p>'));
q('.task-row').addEventListener('click',()=>{resetContext();all('[data-view]')[0].click();});
q('#theme').addEventListener('click',()=>{const dark=document.body.classList.toggle('dark');q('#theme').textContent=dark?'Светлая тема':'Темная тема';});
const adapt=()=>setContext(!narrow.matches);narrow.addEventListener('change',adapt);adapt();
