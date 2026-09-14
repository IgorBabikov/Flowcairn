import { expect, test } from '@playwright/test';
import { mockApi, snapshot, allowed, allDenied, token } from './fixtures.mjs';
function workflow() {
  const state = snapshot();
  state.workflow = 'autonomous'; state.phase = 'execution';
  state.workflowProgress=[{nodeId:'analyze',title:'Анализ задачи',action:'ai-analyze',status:'passed',sourceRunId:'run-analysis',planHash:'e'.repeat(64),receiptIds:['b'.repeat(64)],artifacts:[],outcome:'Изучены проект и требования',attempt:1,durationMs:500}];
  state.capabilities = {...allDenied, approve:allowed,revisePlan:allowed};
  state.task = {...state.task,title:'Форма заявки',description:'Создать форму заявки со строгой валидацией полей.',taskNumber:'FORM-12'};
  return state;
}
test('one approval binds the displayed plan without a manual run', async ({page}) => {
  const fixture = await mockApi(page, workflow());
  await page.goto(`/#session=${token}`);
  await expect(page.getByRole('heading',{name:'План работы',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Согласен',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Выполняем задачу'})).toBeVisible();
  expect(fixture.calls.filter(call=>call.action==='gate')).toHaveLength(1);
  const body=fixture.calls.find(call=>call.action==='gate').body;
  expect(body.challenge).toBe('challenge-fixture'); expect(body.expectedRevision).toBe(3);
  expect(body.permissions).toEqual(['workspace.source.write']);
  expect(fixture.calls.filter(call=>call.action==='run')).toHaveLength(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('feedback blocks approval and creates a new reviewable version', async ({page}) => {
  const fixture = await mockApi(page, workflow());
  await page.goto(`/#session=${token}`);
  await page.getByLabel('Что дополнить или исправить?').fill('Добавить валидацию телефона');
  await expect(page.getByRole('button',{name:'Согласен',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Обновить план',exact:true}).click();
  await expect(page.getByLabel('Что дополнить или исправить?')).toHaveValue('');
  await expect(page.getByRole('button',{name:'Согласен',exact:true})).toBeEnabled();
  expect(fixture.calls.find(call=>call.action==='revise-plan').body.feedback).toBe('Добавить валидацию телефона');
  await page.getByRole('button',{name:'Согласен',exact:true}).click();
  expect(fixture.calls.find(call=>call.action==='gate').body.challenge).toBe('revised-challenge');
});
test('mismatched plan is never approved', async ({page}) => {
  const current=workflow();current.planHash='d'.repeat(64);current.gates[0].planHash=current.planHash;
  await mockApi(page,current);await page.goto(`/#session=${token}`);
  await expect(page.getByRole('button',{name:'Согласен',exact:true})).toBeDisabled();
  await expect(page.getByText('Проверяем сохраненный план…')).toBeVisible();
});
test('completion requires explicit ready-for-review evidence', async ({page}) => {
  const current=workflow();current.status='passed';current.completion='ready-for-review';current.gates=[];current.delivery={workspacePath:'.ai-orchestrator/worktrees/form-12-1'};
  current.nodes=current.nodes.map(node=>({...node,status:'passed',capabilities:allDenied}));current.capabilities=allDenied;
  await mockApi(page,current);await page.goto(`/#session=${token}`);
  await expect(page.getByRole('heading',{name:'Готово к вашему ревью'})).toBeVisible();
  await expect(page.getByText('.ai-orchestrator/worktrees/form-12-1',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Согласен|Принять результат|коммит|PR/})).toHaveCount(0);
});
test('settings stay outside three-field task form', async ({page}) => {
  await mockApi(page,workflow(),{emptyUntilIntake:true});await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Настройки проекта',exact:true}).click();
  await expect(page.getByRole('region',{name:'Настройки проекта',exact:true})).toContainText('Ручной');
  await expect(page.getByText('npx flowcairn setup',{exact:true})).toBeVisible();
  await expect(page.locator('.task-composer form').locator('input,textarea,select')).toHaveCount(3);
});
test('autonomous plan renders on desktop and mobile with reduced motion', async ({page},testInfo) => {
  await mockApi(page,workflow());await page.emulateMedia({reducedMotion:'reduce'});
  for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844]]) {
    await page.setViewportSize({width,height});await page.goto(`/#session=${token}`);
    await expect(page.getByRole('button',{name:'Согласен',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const animation=await page.locator('.graph-node.status-waiting-for-human').first().evaluate(el=>getComputedStyle(el,'::after').animationName);
    expect(animation).toBe('none');
    await page.screenshot({path:testInfo.outputPath(`workflow-${name}.png`),fullPage:true});
  }
});

test('historical analysis opens the original receipt and never creates a write capability', async ({page}) => {
  const fixture=await mockApi(page,workflow());await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Анализ задачи: Завершен',exact:true}).click();
  await expect(page.getByText(/Сохраненный анализ из предыдущей версии/)).toBeVisible();
  const request=page.waitForRequest(request=>request.url().includes('/api/runs/run-analysis/receipts/'));
  await page.getByRole('button',{name:/Отчет 1/}).click();await request;
  expect(fixture.calls.filter(call=>['run','gate'].includes(call.action))).toHaveLength(0);
});

test('plan feedback survives reading reports and historical selection survives refresh', async ({page}) => {
  const fixture=await mockApi(page,workflow());await page.goto(`/#session=${token}`);
  await page.getByLabel('Что дополнить или исправить?').fill('Сохранить введенные значения после ошибки');
  await page.getByRole('button',{name:'Анализ задачи: Завершен',exact:true}).click();
  const reads=fixture.snapshotReads();fixture.current().revision+=1;
  await expect.poll(()=>fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(page.getByText(/Сохраненный анализ из предыдущей версии/)).toBeVisible();
  await page.getByRole('tab',{name:'План',exact:true}).click();
  await expect(page.getByLabel('Что дополнить или исправить?')).toHaveValue('Сохранить введенные значения после ошибки');
  await expect(page.getByRole('button',{name:'Согласен',exact:true})).toBeDisabled();
});

test('scheduler failure is visible even without a failed node', async ({page}) => {
  const state=workflow();state.status='ready';state.activeNodeId=null;state.gates=[];
  state.failureReason='Автономный запуск остановлен: истек лимит времени';
  state.nodes=state.nodes.map(node=>({...node,status:'pending',capabilities:allDenied}));
  await mockApi(page,state);await page.goto(`/#session=${token}`);
  await expect(page.getByRole('heading',{name:'Работа приостановлена'})).toBeVisible();
  await expect(page.getByText(state.failureReason,{exact:true})).toBeVisible();
  await expect(page.getByText('Разбираемся в задаче',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Выполняем задачу',{exact:true})).toHaveCount(0);
  await expect(page.locator('.current-stage')).toHaveCount(0);
});
