import {test,expect} from '@playwright/test';
import {mockApi,token,objectHash} from './fixtures.mjs';
import {widePlanFixture,wideProofFixture} from './wide-fixtures.mjs';

async function mount(page,fixture,extra={}) {
  const api=await mockApi(page,fixture.state,{planResponses:{[fixture.state.runId]:{plan:fixture.plan}},...extra});
  await page.goto(`/#session=${token}`);return api;
}
async function fit(page) {
  return page.evaluate(()=>({width:innerWidth,height:innerHeight,documentFits:document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight,
    main:document.querySelector('.main-content').getBoundingClientRect().toJSON(),rail:document.querySelector('.run-rail').getBoundingClientRect().toJSON(),
    context:document.querySelector('.wide-task-context')?.getBoundingClientRect().toJSON(),header:document.querySelector('.topbar').getBoundingClientRect().toJSON()}));
}
for(const width of [1920,2560,3440,3840]) {
  test(`wide layout uses all available width and linked contract at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:1080});await mount(page,widePlanFixture());
    await expect(page.locator('.wide-work-row')).toHaveCount(4);
    await expect(page.locator('.wide-criteria-list > li')).toHaveCount(3);
    const state=await fit(page);expect(state.documentFits).toBe(true);expect(state.rail.x).toBe(0);
    expect(state.header.right).toBe(width);expect(state.main.x).toBe(state.rail.right);expect(state.context.right).toBe(width);
    await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Шаг 1: Создать форму регистрации',exact:true}).click();
    const context=page.getByRole('complementary',{name:'Контекст задачи'});
    await expect(context).toContainText('Email и пароль валидируются');
    await context.getByRole('button',{name:'Открыть отчеты этапа',exact:true}).click();
    await expect(page.locator('.node-details h2')).toHaveText('Создать форму регистрации');
    expect((await fit(page)).documentFits).toBe(true);
    await page.getByRole('button',{name:'Закрыть детали',exact:true}).click();
    await page.getByRole('button',{name:'Задача',exact:true}).click();
    await expect(page.locator('.wide-work-row')).toHaveCount(4);
  });
}

test('wide plan approval uses unchanged challenge, hash, permissions and revision',async({page})=>{
  await page.setViewportSize({width:1920,height:1080});const f=widePlanFixture();const api=await mount(page,f);
  await page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true}).click();
  const call=api.calls.find(item=>item.action==='gate');expect(call.body.challenge).toBe(f.state.gates[0].challenge);
  expect(call.body.planHash).toBe(f.state.planHash);expect(call.body.expectedRevision).toBe(f.state.revision);
  expect(call.body.permissions).toEqual(f.state.gates[0].requiredPermissions);
});

test('feedback survives resizing and keeps approval disabled until a revised plan exists',async({page})=>{
  await page.setViewportSize({width:1366,height:768});const api=await mount(page,widePlanFixture());
  await page.getByText('Предложить изменения плана',{exact:true}).click();
  const field=page.getByLabel('Что дополнить или исправить?');await field.fill('Добавить проверку ИНН');
  await page.setViewportSize({width:1920,height:1080});await expect(field).toHaveValue('Добавить проверку ИНН');
  await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeDisabled();
  await page.getByText('Предложить изменения плана',{exact:true}).click();
  await page.getByRole('button',{name:'Предложить изменения',exact:true}).click();
  await expect(field).toBeVisible();await expect(field).toBeFocused();
  await page.setViewportSize({width:390,height:844});await expect(field).toHaveValue('Добавить проверку ИНН');expect(api.calls).toHaveLength(0);
});

test('closed task context stays closed across live revisions and returns focus',async({page})=>{
  await page.setViewportSize({width:1920,height:1080});const api=await mount(page,widePlanFixture('running'));
  await page.getByRole('button',{name:'Закрыть контекст',exact:true}).click();
  await expect(page.getByRole('button',{name:'Критерии и границы',exact:true})).toBeFocused();
  const reads=api.snapshotReads();api.current().revision+=1;await expect.poll(()=>api.snapshotReads()).toBeGreaterThan(reads);
  await expect(page.locator('.wide-task-context')).toHaveCount(0);
});

test('wide unavailable and malformed proof state remains fail-closed',async({page})=>{
  await page.setViewportSize({width:1920,height:1080});const f=wideProofFixture();f.state.integrity={valid:false,reason:'Целостность не подтверждена'};
  await mount(page,f);await expect(page.getByTestId('task-proof-status')).toHaveText('Состояние недоступно');
  await expect(page.locator('.completion-certificate')).toHaveCount(0);await expect(page.getByTestId('requirement-coverage')).toHaveCount(0);
});

test('proof selection, stale evidence and human-acceptance input survive wide resize',async({page})=>{
  await page.setViewportSize({width:1366,height:768});const f=wideProofFixture(true);const proof=f.state.proof;
  proof.requirements[1].verification.method='human';proof.requirements[1].status='unproven';proof.acceptance={allowed:true,reason:null,challenge:'human-wide-challenge'};
  await mount(page,f);
  await page.getByRole('button',{name:/Для компании показаны название и ИНН Нужна проверка/}).click();
  const reason=page.getByLabel('Что вы проверили и чем подтверждается результат?');await reason.fill('Проверены обязательные поля формы');
  await page.setViewportSize({width:1920,height:1080});await expect(reason).toHaveValue('Проверены обязательные поля формы');
  await expect(page.getByRole('region',{name:'Доказательство требования'}).getByRole('heading',{name:'Для компании показаны название и ИНН',exact:true})).toBeVisible();
  await expect(page.getByTestId('task-proof-status')).toHaveText('Нужна повторная проверка');
  await expect(page.locator('.completion-certificate')).toHaveCount(0);
});

test('wide gate remains actionable when its contract already has unproven proof',async({page})=>{
  await page.setViewportSize({width:1920,height:1080});const f=widePlanFixture();const p=wideProofFixture(true).state.proof;
  p.status='UNPROVEN';p.contract=f.plan.taskContract;f.state.proof=p;
  await mount(page,f);await expect(page.locator('.wide-criteria-list > li')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'Согласовать и начать выполнение',exact:true})).toBeEnabled();
  await expect(page.getByTestId('task-proof-status')).toHaveText('План ожидает согласования');
});

test('missing contract does not invent verification methods',async({page})=>{
  await page.setViewportSize({width:1920,height:1080});const f=widePlanFixture();delete f.plan.taskContract;f.state.planHash=objectHash(f.plan);f.state.gates[0].planHash=f.state.planHash;
  await mount(page,f);await expect(page.locator('.wide-work-verification').first()).toHaveText('Способ проверки не указан');
  await expect(page.getByRole('complementary',{name:'Контекст задачи'})).toContainText('Исходные критерии задачи');
});

test('new task and loading fit a wide frame, smaller sizes keep the existing UI',async({page})=>{
  await page.setViewportSize({width:3440,height:1440});const f=widePlanFixture();await mount(page,f,{emptyUntilIntake:true,projectDelayMs:1000,listDelayMs:1000});
  await expect(page.locator('.shell-skeleton')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Новая задача',exact:true})).toBeVisible();expect((await fit(page)).documentFits).toBe(true);
  for(const width of [1799,1366,1024,390]){
    await page.setViewportSize({width,height:844});await expect(page.locator('.wide-workspace')).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'Новая задача',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight)).toBe(true);
  }
});
