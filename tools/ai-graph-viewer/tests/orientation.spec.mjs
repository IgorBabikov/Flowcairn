import { test, expect } from '@playwright/test';
import { snapshot, graphNode, implementationNode, allDenied, allowed, mockApi, token } from './fixtures.mjs';

function running() {
  const state = snapshot();
  state.workflow = 'autonomous'; state.phase = 'execution'; state.status = 'running';
  state.task.title = state.task.goal = 'Добавить форму регистрации компании';
  state.gates = []; state.activeNodeId = 'implement'; state.capabilities = {...allDenied, stop:allowed};
  state.nodes = [graphNode({status:'passed',capabilities:allDenied}), {...implementationNode,status:'running'}];
  state.execution = {state:'running'};
  return state;
}

for (const width of [1366, 390]) {
  test(`navigation and project context stay visible at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:844}); await mockApi(page,running()); await page.goto(`/#session=${token}`);
    const nav=page.getByRole('navigation',{name:'Представление задачи'});
    await page.evaluate(()=>document.fonts.ready);
    const before=await nav.boundingBox();
    await expect(page.getByRole('button',{name:'Состояние проекта',exact:true})).toContainText('Тестовый проект');
    await nav.getByRole('button',{name:'Граф',exact:true}).click();
    await expect(page.locator('.detail-panel')).toHaveCount(0);
    expect((await nav.boundingBox()).y).toBe(before.y);
    await nav.getByRole('button',{name:'Задача',exact:true}).click();
    await expect(page.getByRole('article',{name:'Обзор задачи'})).toBeVisible();
    expect((await nav.boundingBox()).y).toBe(before.y);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test('closing inspector survives newer snapshot revisions; modal tabs fit and Escape restores focus', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const fixture=await mockApi(page,running()); await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Граф',exact:true}).click();
  const opener=page.getByRole('button',{name:'Детали исполнения',exact:true}); await opener.click();
  const dialog=page.getByRole('dialog',{name:'Детали исполнения',exact:true});
  await expect(dialog).toBeVisible(); expect(await dialog.evaluate(el=>el.matches(':modal'))).toBe(true);
  const tabs=await dialog.getByRole('tab').all();
  for (const tab of tabs) {
    const box=await tab.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThan(0); expect(box.y+box.height).toBeLessThan(844);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x+box.width).toBeLessThanOrEqual(390);
  }
  await expect(dialog.getByRole('tab',{name:'План',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  const reads=fixture.snapshotReads(); fixture.current().revision+=1;
  await expect.poll(()=>fixture.snapshotReads()).toBeGreaterThan(reads);
  await expect(dialog).toHaveCount(0);
  await opener.click();
  await dialog.getByRole('tab',{name:'Обзор',exact:true}).press('ArrowRight');
  await expect(dialog.getByRole('tab',{name:'Результаты',exact:true})).toBeFocused();
  await expect(dialog.getByRole('tabpanel')).toHaveAttribute('aria-labelledby','inspector-tab-evidence');
});

test('mobile user can start a second task from runs and return to the opener', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await mockApi(page,running()); await page.goto(`/#session=${token}`);
  const opener=page.getByRole('button',{name:'Показать запуски',exact:true}); await opener.click();
  await page.getByRole('dialog',{name:'Запуски',exact:true}).getByRole('button',{name:'Новая задача',exact:true}).click();
  await expect(page.getByLabel('Заголовок задачи')).toBeFocused();
  await expect(page.getByRole('dialog',{name:'Запуски',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Отмена',exact:true}).click(); await expect(opener).toBeFocused();
});

test('unavailable snapshot never displays old health as current', async ({page}) => {
  await mockApi(page,running(),{failClosedSnapshotAfterFirst:true}); await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Обновить',exact:true}).click();
  await expect(page.getByRole('button',{name:'Состояние проекта',exact:true})).toContainText('Нужна проверка');
  await page.getByRole('button',{name:'Состояние проекта',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Состояние проекта'})).not.toContainText('Подтверждена');
});

test('uncertain task exposes only executor-authorized recovery', async ({page}) => {
  const state=running(); state.status='uncertain'; state.execution={state:'stop-uncertain'};
  state.capabilities=allDenied; state.nodes[1]={...state.nodes[1],status:'uncertain',capabilities:{...allDenied,recover:allowed}};
  const fixture=await mockApi(page,state); await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Проверить остановку',exact:true}).click();
  const request=fixture.calls.find(c=>c.action==='recover'); expect(request.body.nodeId).toBe('implement');
  expect(request.body.expectedRevision).toBe(3); expect(request.body.planHash).toBe(state.planHash);
});

test('denied recovery offers reports without inventing a permission', async ({page}) => {
  const state=running(); state.status='uncertain'; state.execution={state:'stop-uncertain'}; state.capabilities=allDenied;
  const fixture=await mockApi(page,state); await page.goto(`/#session=${token}`);
  await expect(page.getByRole('button',{name:'Проверить остановку',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Открыть этап и отчеты',exact:true}).click();
  await expect(page.locator('.detail-panel')).toBeVisible(); expect(fixture.calls).toHaveLength(0);
});

for (const width of [1366,390]) {
  test(`approval stays in the first viewport and keeps its gate contract at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:768}); const state=snapshot();state.workflow='autonomous';state.phase='execution';
    state.task.title=state.task.goal='Добавить форму регистрации компании';
    const fixture=await mockApi(page,state);await page.goto(`/#session=${token}`);
    const approve=page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true});
    await expect(approve).toBeEnabled();const box=await approve.boundingBox();
    expect(box.y).toBeGreaterThan(0);expect(box.y+box.height).toBeLessThan(768);
    await approve.click();const call=fixture.calls.find(c=>c.action==='gate');
    expect(call.body.challenge).toBe('challenge-fixture');expect(call.body.permissions).toEqual(['workspace.source.write']);
    expect(call.body.planHash).toBe(state.planHash);expect(call.body.expectedRevision).toBe(3);
  });
}

test('lost snapshot does not keep reassuring running copy on screen',async({page})=>{
  await mockApi(page,running());await page.goto(`/#session=${token}`);
  await expect(page.getByRole('heading',{name:'Что происходит сейчас',exact:true})).toBeVisible();
  await page.route('**/api/runs/run-demo/snapshot',route=>route.abort('connectionreset'));
  await page.getByRole('button',{name:'Обновить',exact:true}).click();
  await expect(page.getByTestId('task-proof-status')).toBeVisible();
  await expect(page.getByTestId('task-proof-status')).toHaveText('Состояние недоступно');
  await expect(page.getByText('Flowcairn выполняет текущий этап',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Что происходит сейчас',exact:true})).toHaveCount(0);
});

test('desktop inspector returns keyboard focus after closing the sidebar',async({page})=>{
  await page.setViewportSize({width:1366,height:768});await mockApi(page,running());await page.goto(`/#session=${token}`);
  await page.getByRole('button',{name:'Граф',exact:true}).click();
  const opener=page.getByRole('button',{name:'Детали исполнения',exact:true});await opener.click();
  await page.getByRole('button',{name:'Закрыть детали',exact:true}).click();
  await expect(page.locator('.detail-panel')).toHaveCount(0);await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.locator('.detail-panel')).toBeVisible();
});

for (const width of [768,1024]) {
  test(`tablet header keeps project name readable beside stopping controls at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:768});const state=running();state.execution={state:'stopping'};
    await mockApi(page,state);await page.goto(`/#session=${token}`);
    await expect(page.getByRole('button',{name:'Останавливаем…',exact:true})).toBeVisible();
    const geometry=await page.locator('.project-status-trigger').evaluate(el=>{
      const name=el.querySelector('.project-name');const actions=document.querySelector('.topbar-actions');
      return {nameFits:name.scrollWidth<=name.clientWidth,projectBottom:el.getBoundingClientRect().bottom,actionsTop:actions.getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    expect(geometry.nameFits).toBe(true);expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.projectBottom);
    expect(geometry.overflow).toBe(false);
  });
}
