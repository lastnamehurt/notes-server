import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../src/app.html',import.meta.url),'utf8');
const baseTask = {note:'inbox/tasks.md',line:1,revision:'snapshot',priority:'plan',schedule:'2026-10-15',repeating:false};
const stamp = day => Date.parse(day+'T16:00:00Z'); // 9am Pacific

test.beforeEach(async ({page})=>{
  await page.clock.install({time:new Date('2026-10-12T18:00:00Z')});
  let tasks = [
    {...baseTask,title:'Book dentist',text:'Book dentist @2026-10-15',occurrences:[{at:stamp('2026-10-15')}]},
    {...baseTask,line:2,priority:'do',title:'Overdue bill',occurrences:[{at:stamp('2026-09-01')}]},
    {...baseTask,line:3,priority:'someday',title:'Read a book',schedule:'',occurrences:[]},
  ];
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if (url.pathname==='/app') return route.fulfill({contentType:'text/html',body:html});
    if (url.pathname==='/app/api/config') return route.fulfill({json:{configured:true,timeZone:'America/Los_Angeles',categories:[],push:true}});
    if (url.pathname==='/app/api/calendar') return route.fulfill({json:{tasks,timeZone:'America/Los_Angeles'}});
    if (url.pathname==='/app/api/calendar/task') {
      const body=route.request().postDataJSON();
      if (body.done) tasks=tasks.filter(t=>t.line!==body.line);
      if (body.schedule!==undefined) tasks=tasks.map(t=>t.line===body.line ? {...t,schedule:body.schedule,priority:body.priority,occurrences:body.schedule ? [{at:stamp(body.schedule.slice(0,10))}] : []} : t);
      return route.fulfill({json:{name:body.name}});
    }
    if (url.pathname==='/app/api/task') return route.fulfill({json:{name:'inbox/tasks.md'}});
    return route.fulfill({json:{}});
  });
  await page.goto('/app#reminders');
  await expect(page.getByRole('heading',{name:'Tasks',exact:true})).toBeVisible();
});

test('agenda shows overdue and unscheduled tasks; filters apply across all sections',async({page})=>{
  await expect(page.getByRole('button',{name:'Agenda',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByText('Book dentist',{exact:true})).toBeVisible();
  await expect(page.getByText('Overdue bill',{exact:true})).toBeVisible();
  await expect(page.getByText('Read a book',{exact:true})).toBeVisible();
  await page.locator('#task-filter').selectOption('do');
  await expect(page.getByText('Overdue bill',{exact:true})).toBeVisible();
  await expect(page.locator('main').getByText('Book dentist',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('month selection, navigation and add task prefill work with keyboard',async({page})=>{
  await page.getByRole('button',{name:'Month',exact:true}).click();
  const day=page.locator('[data-day="2026-10-15"]');
  await expect(day).toHaveAttribute('aria-label',/1 task/);
  await day.focus(); await page.keyboard.press('Enter');
  await expect(day).toHaveAttribute('aria-pressed','true');
  await expect(page.getByText('Book dentist',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'+ Add for this day',exact:true}).click();
  await expect(page.locator('#t-date')).toHaveValue('2026-10-15');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Next month',exact:true}).click();
  await expect(page.getByRole('heading',{name:'November 2026',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Today',exact:true}).click();
  await expect(page.locator('[data-day="2026-10-12"]')).toHaveAttribute('aria-current','date');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('edit clears a date and changes priority; completion removes the task',async({page})=>{
  await page.getByRole('button',{name:'Edit Book dentist',exact:true}).click();
  await page.getByRole('button',{name:'Remove date',exact:true}).click();
  await page.locator('#edit-priority').selectOption('do');
  const editRequest=page.waitForRequest(r=>r.url().endsWith('/calendar/task'));
  await page.getByRole('button',{name:'Save task',exact:true}).click();
  expect((await editRequest).postDataJSON()).toMatchObject({revision:'snapshot',schedule:'',priority:'do'});
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.step').filter({has:page.getByRole('heading',{name:/Unscheduled/})}).getByText('Book dentist')).toBeVisible();
  await page.getByRole('button',{name:'Mark done: Book dentist',exact:true}).click();
  await expect(page.locator('main').getByText('Book dentist',{exact:true})).toHaveCount(0);
});
