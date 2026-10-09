import { expect, test } from '@playwright/test';
import { book, newQuest, openDiagnostics, selectStep, stepDetails, stepPicker, visitResult } from './ui-paths.mjs';
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
  await visitResult(page);
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
    await visitResult(page);
    await expect(page.getByRole('heading', { name: 'Исполнитель пока не готов', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Начать анализ', exact: true })).toHaveCount(0);
    await expect(page.locator('.workflow-summary')).toContainText('не смог безопасно проверить инструменты');
    await page.getByRole('button', {name:'Настройки проекта',exact:true}).click();
    const health = page.getByRole('dialog',{name:'Настройки проекта'}).locator('.fact-list');
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
    await page.keyboard.press('Escape');
  }
});

test('known startup failure explains what happened and offers a new plan', async ({ page }) => {
  const state = workflow();
  state.contextClarification = true;
  state.phase = 'planning'; state.status = 'failed'; state.gates = [];
  state.nodes = [{ ...state.nodes[0], status: 'failed', reason: 'RUNNER_READY_TIMEOUT', capabilities: { ...allDenied, requestReplan: allowed } }];
  state.capabilities = { ...allDenied, requestReplan: allowed };
  const fixture = await mockApi(page, state);
  await visitResult(page);
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
  await visitResult(page);
  await expect(page.getByTestId('task-proof-status')).toHaveText('Остановлено пользователем');
  await expect(page.locator('.execution-status')).toContainText('Остановлено пользователем');
  await page.getByRole('button', { name: 'Подготовить новый план', exact: true }).click();
  expect(fixture.calls.filter(call => call.action === 'replan')).toHaveLength(1);
});
test('one approval binds the displayed plan without a manual run', async ({page}) => {
  const fixture = await mockApi(page, workflow());
  await visitResult(page);
  await expect(page.getByRole('heading',{name:'План работы',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Выполняем задачу'})).toBeVisible();
  expect(fixture.calls.filter(call=>call.action==='gate')).toHaveLength(1);
  const body=fixture.calls.find(call=>call.action==='gate').body;
  expect(body.challenge).toBe('challenge-fixture'); expect(body.expectedRevision).toBe(3);
  expect(body.permissions).toEqual(['workspace.source.write']);
  expect(fixture.calls.filter(call=>call.action==='run')).toHaveLength(0);
  await expect(page.locator('dialog[open]:not(.game-overlay)')).toHaveCount(0);
});
test('feedback blocks approval and creates a new reviewable version', async ({page}) => {
  const fixture = await mockApi(page, workflow());
  await visitResult(page);
  await page.getByText('Предложить изменения плана', {exact:true}).click();
  await page.getByLabel('Что дополнить или исправить?').fill('Добавить валидацию телефона');
  await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Обновить план',exact:true}).click();
  await expect(page.getByLabel('Что дополнить или исправить?')).toHaveValue('');
  await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeEnabled();
  expect(fixture.calls.find(call=>call.action==='revise-plan').body.feedback).toBe('Добавить валидацию телефона');
  await page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true}).click();
  expect(fixture.calls.find(call=>call.action==='gate').body.challenge).toBe('revised-challenge');
});
test('mismatched plan is never approved', async ({page}) => {
  const current=workflow();current.planHash='d'.repeat(64);current.gates[0].planHash=current.planHash;
  await mockApi(page,current);await visitResult(page);
  await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeDisabled();
  await expect(page.getByText('Проверяем сохраненный план…')).toBeVisible();
});

test('runtime update exposes permitted plan revision without approving stale work', async ({ page }) => {
  const state = workflow();
  state.integrity = { valid: false, reason: 'RUNTIME_DRIFT: Runtime изменился' };
  state.status = 'stale'; state.capabilities = { ...allDenied, revisePlan: allowed };
  state.gates = []; state.nodes = state.nodes.map(node => ({ ...node, capabilities: allDenied }));
  const fixture = await mockApi(page, state);
  await visitResult(page);
  await expect(page.getByTestId('task-proof-status')).toHaveText('План требует обновления');
  await expect(page.getByRole('button', { name: 'Согласовать и начать выполнение', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Обновить план', exact: true }).click();
  expect(fixture.calls.filter(call => call.action === 'revise-plan')).toHaveLength(1);
  expect(fixture.calls.filter(call => ['gate', 'run'].includes(call.action))).toHaveLength(0);
});
test('completion requires explicit ready-for-review evidence', async ({page}) => {
  const current=workflow();current.status='passed';current.completion='ready-for-review';current.gates=[];current.delivery={workspacePath:'.ai-orchestrator/worktrees/form-12-1'};
  current.nodes=current.nodes.map(node=>({...node,status:'passed',capabilities:allDenied}));current.capabilities=allDenied;
  await mockApi(page,current);await visitResult(page);
  await expect(page.getByRole('heading',{name:'Готово к вашему ревью'})).toBeVisible();
  await expect(page.getByText('.ai-orchestrator/worktrees/form-12-1',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Согласовать и начать выполнение|Принять результат|коммит|PR/})).toHaveCount(0);
});
test('settings stay outside three-field task form', async ({page}) => {
  await mockApi(page,workflow(),{emptyUntilIntake:true});
  await page.goto(`/#session=${token}`);
  await page.getByRole('navigation', { name: 'Игровое меню' }).getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('dialog', { name: 'Служебные записи', exact: true }).getByRole('button', { name: 'Настройки проекта', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки проекта', exact: true });
  await expect(settings).toContainText('Ручной');
  await expect(settings).toContainText('Claude Code: Поддержан.');
  await expect(settings).toContainText('Cursor: Поддержан.');
  await expect(settings.getByText('npx flowcairn setup',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await newQuest(page);
  await expect(page.locator('#quest-intake').locator('input,textarea,select')).toHaveCount(3);
});

test('autonomous plan renders on desktop and mobile with reduced motion', async ({page},testInfo) => {
  await mockApi(page,workflow());await page.emulateMedia({reducedMotion:'reduce'});
  for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844]]) {
    await page.setViewportSize({width,height});await visitResult(page);
    await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await openDiagnostics(page, 'nodes');
    await selectStep(page, 'approve-plan');
    await expect(stepDetails(page)).toContainText('Нужно решение');
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    // This approval state has no spinner; the running reduced-motion regression lives in viewer.spec.
    const nodesTab = book(page).getByRole('tab', { name: 'Этапы', exact: true });
    await nodesTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(book(page).getByRole('tab', { name: 'Отчеты', exact: true })).toBeFocused();
    await expect(book(page).locator('#diagnostic-tab-evidence')).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({path:testInfo.outputPath(`workflow-${name}.png`),fullPage:true});
  }
});

test('task heading keeps one collapsible copy of a long description', async ({ page }) => {
  const state = workflow();
  state.task.description = 'Подробное описание задачи с требованиями к интерфейсу, проверкам и безопасному результату. '.repeat(24).trim();
  await mockApi(page, state);
  await visitResult(page);

  await expect(book(page).locator('.diagnostic-heading p')).toHaveText(state.task.title);
  await expect(book(page).locator('.task-heading h2')).toHaveCount(1);
  const description = page.locator('.task-description .collapsible-text > div');
  await expect(description).toHaveCount(1);
  expect((await description.locator('.readable-text p').allTextContents()).join(' ').replace(/\s+/g, ' ').trim()).toBe(state.task.description);
  await expect(description).toHaveClass(/clamped/);
  await page.getByText('Описание задачи',{exact:true}).click();
  await expect(page.getByRole('button', { name: 'Показать полностью' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать полностью' }).click();
  await expect(description).not.toHaveClass(/clamped/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('historical analysis opens the original receipt and never creates a write capability', async ({page}) => {
  const fixture=await mockApi(page,workflow());await visitResult(page);
  await openDiagnostics(page, 'nodes');
  await selectStep(page, 'history-run-analysis-analyze');
  await expect(book(page).locator('#diagnostic-tab-evidence')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/Сохраненный анализ из предыдущей версии/)).toBeVisible();
  await expect(book(page).locator('.diagnostic-node-identity')).toContainText('run-analysis');
  await openDiagnostics(page, 'nodes');
  for (const name of ['Запустить', 'Повторить', 'Восстановить', 'Новая версия плана', 'Подтвердить план'])
    await expect(stepDetails(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  await openDiagnostics(page, 'evidence');
  const request=page.waitForRequest(request=>request.url().includes('/api/runs/run-analysis/receipts/'));
  await page.getByRole('button',{name:/Отчет 1/}).click();await request;
  expect(fixture.calls.filter(call=>['run','gate'].includes(call.action))).toHaveLength(0);
});

test('plan feedback survives reading reports and historical selection survives refresh', async ({page}) => {
  const fixture=await mockApi(page,workflow());await visitResult(page);
  await page.getByText('Предложить изменения плана', {exact:true}).click();
  await page.getByLabel('Что дополнить или исправить?').fill('Сохранить введенные значения после ошибки');
  await openDiagnostics(page, 'nodes');
  await selectStep(page, 'history-run-analysis-analyze');
  await expect(book(page).locator('#diagnostic-tab-evidence')).toHaveAttribute('aria-selected', 'true');
  const reads=fixture.snapshotReads();fixture.current().revision+=1;
  await expect.poll(()=>fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(page.getByText(/Сохраненный анализ из предыдущей версии/)).toBeVisible();
  await expect(stepPicker(page)).toHaveValue('history-run-analysis-analyze');
  await openDiagnostics(page, 'result');
  await expect(page.getByLabel('Что дополнить или исправить?')).toHaveValue('Сохранить введенные значения после ошибки');
  await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeDisabled();
});

test('scheduler failure is visible even without a failed node', async ({page}) => {
  const state=workflow();state.status='ready';state.activeNodeId=null;state.gates=[];
  state.failureReason='Автономный запуск остановлен: истек лимит времени';
  state.nodes=state.nodes.map(node=>({...node,status:'pending',capabilities:allDenied}));
  await mockApi(page,state);await visitResult(page);
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
  await visitResult(page);
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
  const fixture=await mockApi(page,state);await visitResult(page);
  await openDiagnostics(page, 'nodes');
  await selectStep(page, 'review');
  const details=stepDetails(page);
  await expect(details.getByRole('heading',{name:'Проверка изменений'})).toBeVisible();
  await expect(details.getByRole('button',{name:'Повторить',exact:true})).toBeVisible();
  await expect(details.getByRole('button',{name:'Восстановить',exact:true})).toBeVisible();
  await expect(details.getByRole('button',{name:'Новая версия плана',exact:true})).toBeVisible();
  await expect(details.getByRole('button',{name:'Запустить',exact:true})).toHaveCount(0);
  await details.getByRole('button',{name:'Восстановить',exact:true}).click();
  await expect.poll(()=>fixture.calls.filter(call=>call.action==='recover').length).toBe(1);
  expect(fixture.calls.find(call=>call.action==='recover').body.nodeId).toBe('review');
});

test('all ten workflow steps remain directly selectable without a graph', async ({page}) => {
  const state=workflow();
  state.workflowProgress=[];
  state.nodes=Array.from({length:10},(_,index)=>({...state.nodes[1],id:`step-${index}`,needs:index?[`step-${index-1}`]:[],capabilities:allDenied}));
  state.edges=state.nodes.slice(1).map((node,index)=>({id:`edge-${index}`,source:`step-${index}`,target:node.id}));
  const fixture = await mockApi(page,state);await visitResult(page);
  await openDiagnostics(page, 'nodes');
  await expect(stepPicker(page).locator('option[value]:not([value=""])')).toHaveCount(10);
  for (const node of state.nodes) {
    await selectStep(page, node.id);
    await expect(stepDetails(page)).toHaveAttribute('data-node-id', node.id);
    if (node.needs.length) await expect(stepDetails(page)).toContainText(node.needs[0]);
  }
  expect(fixture.calls).toEqual([]);
});
