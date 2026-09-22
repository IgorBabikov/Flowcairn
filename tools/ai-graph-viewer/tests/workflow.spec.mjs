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

test('ready analysis shows a permitted start action or an explicit executor problem', async ({ page }, testInfo) => {
  const current = workflow();
  current.phase = 'planning'; current.status = 'ready'; current.gates = [];
  current.nodes = current.nodes.slice(0, 1).map(node => ({ ...node, status: 'ready', action: { id: 'ai-analyze', kind: 'analysis' }, capabilities: { ...allDenied, run: allowed } }));
  current.capabilities = { ...allDenied, run: allowed };
  const fixture = await mockApi(page, current);
  await page.goto(`/#session=${token}`);
  await expect(page.getByRole('button', { name: 'Начать анализ', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Начать анализ', exact: true }).click();
  expect(fixture.calls.filter(call => call.action === 'run')).toHaveLength(1);
  const reason = 'RUNNER_TOOLCHAIN_INVALID';
  const stopped = fixture.current();
  stopped.status = 'ready'; stopped.runner.ai = { available: false, reason };
  stopped.capabilities = { ...allDenied, run: { allowed: false, reason } };
  stopped.nodes = stopped.nodes.map(node => ({ ...node, status: 'ready', capabilities: allDenied }));
  stopped.revision += 1;
  for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/#session=${token}`);
    await expect(page.getByRole('heading', { name: 'Исполнитель пока не готов', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Начать анализ', exact: true })).toHaveCount(0);
    await expect(page.locator('.workflow-summary')).toContainText('не смог безопасно проверить инструменты');
    if (width < 720) await page.getByRole('button', { name: 'Показать запуски', exact: true }).click();
    const rail = width < 720
      ? page.getByRole('dialog', { name: 'Запуски', exact: true })
      : page.locator('.desktop-run-rail');
    await rail.locator('.health-details summary').click();
    const health = rail.locator('.run-health');
    await health.scrollIntoViewIfNeeded();
    const fits = await health.evaluate(element => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll('dt,dd')].every(item => {
        const bounds = item.getBoundingClientRect();
        return bounds.left >= box.left && bounds.right <= box.right + 1;
      });
    });
    expect(fits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`runner-health-${name}.png`), fullPage: true });
    if (width < 720) await page.keyboard.press('Escape');
  }
});

test('known startup failure explains what happened and offers a new plan', async ({ page }) => {
  const state = workflow();
  state.phase = 'planning'; state.status = 'failed'; state.gates = [];
  state.nodes = [{ ...state.nodes[0], status: 'failed', reason: 'RUNNER_READY_TIMEOUT', capabilities: { ...allDenied, requestReplan: allowed } }];
  state.capabilities = { ...allDenied, requestReplan: allowed };
  const fixture = await mockApi(page, state);
  await page.goto(`/#session=${token}`);
  await expect(page.getByRole('heading', { name: 'AI-исполнитель не запустился', exact: true })).toBeVisible();
  await expect(page.locator('.workflow-summary')).toContainText('Код проекта не изменялся');
  const technical = page.locator('.workflow-panel .technical-details');
  await expect(technical).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Повторить с новым планом', exact: true }).click();
  expect(fixture.calls.filter(call => call.action === 'replan')).toHaveLength(1);
});

test('confirmed stop is shown as cancelled and can start a separate plan', async ({ page }) => {
  const state = workflow();
  state.phase = 'planning'; state.status = 'cancelled'; state.execution = { state: 'stopped', stopRequested: true }; state.gates = [];
  state.nodes = [{ ...state.nodes[0], status: 'cancelled', reason: 'CANCELLED_BY_USER', capabilities: allDenied }];
  state.capabilities = { ...allDenied, requestReplan: allowed };
  const fixture = await mockApi(page, state);
  await page.goto(`/#session=${token}`);
  await expect(page.getByTestId('task-proof-status')).toHaveText('Остановлено пользователем');
  await expect(page.locator('.execution-status')).toContainText('Остановлено пользователем');
  await page.getByRole('button', { name: 'Подготовить новый план', exact: true }).click();
  expect(fixture.calls.filter(call => call.action === 'replan')).toHaveLength(1);
});
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
  await expect(page.getByRole('region',{name:'Настройки проекта',exact:true})).toContainText('Claude Code: Поддержан.');
  await expect(page.getByRole('region',{name:'Настройки проекта',exact:true})).toContainText('Cursor: Поддержан.');
  await expect(page.getByText('npx flowcairn setup',{exact:true})).toBeVisible();
  await expect(page.locator('.task-composer form').locator('input,textarea,select')).toHaveCount(3);
});
test('autonomous plan renders on desktop and mobile with reduced motion', async ({page},testInfo) => {
  await mockApi(page,workflow());await page.emulateMedia({reducedMotion:'reduce'});
  for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844]]) {
    await page.setViewportSize({width,height});await page.goto(`/#session=${token}`);
    await expect(page.getByRole('button',{name:'Согласен',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Граф · детали исполнения',exact:true}).click();
    const animation=await page.locator('.graph-node.status-waiting-for-human').first().evaluate(el=>getComputedStyle(el,'::after').animationName);
    expect(animation).toBe('none');
    await page.screenshot({path:testInfo.outputPath(`workflow-${name}.png`),fullPage:true});
  }
});

test('task heading keeps one collapsible copy of a long description', async ({ page }) => {
  const state = workflow();
  state.task.description = 'Подробное описание задачи с требованиями к интерфейсу, проверкам и безопасному результату. '.repeat(24).trim();
  await mockApi(page, state);
  await page.goto(`/#session=${token}`);

  await expect(page.getByRole('heading', { name: state.task.title, exact: true })).toHaveCount(1);
  const description = page.getByText(state.task.description, { exact: true });
  await expect(description).toHaveCount(1);
  await expect(description).toHaveClass(/clamped/);
  await expect(page.getByRole('button', { name: 'Показать полностью' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать полностью' }).click();
  await expect(description).not.toHaveClass(/clamped/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('historical analysis opens the original receipt and never creates a write capability', async ({page}) => {
  const fixture=await mockApi(page,workflow());await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Граф · детали исполнения',exact:true}).click();
  await page.getByRole('button',{name:'Анализ задачи: Завершен',exact:true}).click();
  await expect(page.getByText(/Сохраненный анализ из предыдущей версии/)).toBeVisible();
  const request=page.waitForRequest(request=>request.url().includes('/api/runs/run-analysis/receipts/'));
  await page.getByRole('button',{name:/Отчет 1/}).click();await request;
  expect(fixture.calls.filter(call=>['run','gate'].includes(call.action))).toHaveLength(0);
});

test('plan feedback survives reading reports and historical selection survives refresh', async ({page}) => {
  const fixture=await mockApi(page,workflow());await page.goto(`/#session=${token}`);
  await page.getByLabel('Что дополнить или исправить?').fill('Сохранить введенные значения после ошибки');
  await page.getByRole('button',{name:'Граф · детали исполнения',exact:true}).click();
  await page.getByRole('button',{name:'Анализ задачи: Завершен',exact:true}).click();
  const reads=fixture.snapshotReads();fixture.current().revision+=1;
  await expect.poll(()=>fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(page.getByText(/Сохраненный анализ из предыдущей версии/)).toBeVisible();
  await page.getByRole('button',{name:'Задача',exact:true}).click();
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

test('internal storage limits use Russian copy and reveal code only in technical details', async ({page}) => {
  const state = workflow();
  state.status = 'failed';
  state.gates = [];
  state.failureReason = 'STORE_LIMIT_EXCEEDED: state.initialFingerprint.files превышает array limit';
  state.nodes = state.nodes.map(node => ({ ...node, status: node.id === 'analyze' ? 'failed' : 'pending', capabilities: allDenied }));
  await mockApi(page, state);
  await page.goto(`/#session=${token}`);
  await expect(page.getByRole('heading', { name: 'Не удалось подготовить задачу', exact: true })).toBeVisible();
  await expect(page.locator('.workflow-summary')).toContainText('Задача не была передана AI');
  await expect(page.locator('.workflow-problem')).toContainText('Что делать дальше');
  const technical = page.locator('.workflow-panel .technical-details');
  await expect(technical).not.toHaveAttribute('open', '');
  await expect(technical.getByText(/STORE_LIMIT_EXCEEDED/)).not.toBeVisible();
  await technical.locator('summary').click();
  await expect(technical).toContainText('STORE_LIMIT_EXCEEDED');
  await expect(technical).toContainText('state.initialFingerprint.files превышает array limit');
});

test('shows only runtime-authorized recovery controls after autonomous failure', async ({page}) => {
  const state=workflow();state.status='stale';state.failureReason='Нужна проверка результата';state.gates=[];
  state.nodes=[
    {...state.nodes[0],status:'passed',capabilities:allDenied},
    {...state.nodes[1],id:'review',title:'Проверка изменений',status:'stale',capabilities:{...allDenied,retry:allowed,recover:allowed,requestReplan:allowed}},
  ];
  state.activeNodeId='review';state.capabilities={...allDenied,requestReplan:allowed};
  const fixture=await mockApi(page,state);await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Граф · детали исполнения',exact:true}).click();
  const details=page.locator('.node-details');
  await expect(details.getByRole('heading',{name:'Проверка изменений'})).toBeVisible();
  await expect(details.getByRole('button',{name:'Повторить',exact:true})).toBeVisible();
  await expect(details.getByRole('button',{name:'Восстановить',exact:true})).toBeVisible();
  await expect(details.getByRole('button',{name:'Новая версия плана',exact:true})).toBeVisible();
  await expect(details.getByRole('button',{name:'Запустить',exact:true})).toHaveCount(0);
  await details.getByRole('button',{name:'Восстановить',exact:true}).click();
  await expect.poll(()=>fixture.calls.filter(call=>call.action==='recover').length).toBe(1);
  expect(fixture.calls.find(call=>call.action==='recover').body.nodeId).toBe('review');
});

test('hides the MiniMap for a compact ten-node workflow', async ({page}) => {
  const state=workflow();
  state.workflowProgress=[];
  state.nodes=Array.from({length:10},(_,index)=>({...state.nodes[1],id:`step-${index}`,needs:index?[`step-${index-1}`]:[],capabilities:allDenied}));
  state.edges=state.nodes.slice(1).map((node,index)=>({id:`edge-${index}`,source:`step-${index}`,target:node.id}));
  await mockApi(page,state);await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Граф · детали исполнения',exact:true}).click();
  await expect(page.locator('.graph-node')).toHaveCount(10);
  await expect(page.getByLabel('Мини-карта графа')).toHaveCount(0);
});
