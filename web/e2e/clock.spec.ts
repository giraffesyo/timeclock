import { DateTime } from 'luxon';
import { ZONE } from '../playwright.config';
import { expect, lastWeek, RECENT, test } from './fixtures';

const note = (page: import('@playwright/test').Page) => page.getByRole('combobox', { name: 'What you are working on' });
const picker = (page: import('@playwright/test').Page, label = 'Project') =>
  page.getByRole('form', { name: 'Clock' }).getByRole('button', { name: new RegExp(`^${label}: `) });
const pick = async (page: import('@playwright/test').Page, project: string) => {
  await page.getByRole('combobox', { name: 'Search projects' }).fill(project);
  await page.getByRole('option', { name: project }).click();
};

test('the clock starts with a note and a project, and stops', async ({ me }) => {
  const { page, api } = me;
  await page.goto('/?view=list');
  await note(page).fill('Fix the scheduler');
  await picker(page).click();
  await pick(page, 'Platform');
  await page.getByRole('button', { name: 'Start the clock', exact: true }).click();

  await expect(page.getByRole('form', { name: 'Clock' }).getByRole('timer')).toHaveText(/^0:00:0\d$/);
  await expect(page.getByRole('listitem').filter({ hasText: 'Fix the scheduler' })).toContainText('Acme / Platform');

  await page.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
  const { entries } = await api.get(RECENT());
  expect(entries).toHaveLength(1);
  expect(entries[0].endedAt).toBeTruthy();
});

test('a project is required to stop, but not to start, the clock', async ({ me }) => {
  const { page, api } = me;
  await page.goto('/');
  await page.getByRole('button', { name: 'Start the clock', exact: true }).click();
  const bar = page.getByRole('form', { name: 'Clock' });
  await expect(bar.getByRole('timer')).toBeVisible();
  const started = (await api.get('/me')).running;
  await page.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(bar.getByRole('alert')).toHaveText('Choose a project to stop the clock and save this time entry.');
  await expect(bar.getByRole('timer')).toBeVisible();
  expect((await api.get('/me')).running.id).toBe(started.id);
  await note(page).fill('Unplanned work');
  await picker(page, 'Project the clock is running on').click();
  await pick(page, 'Platform');
  await expect(bar.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(bar.getByRole('timer')).toHaveCount(0);
  const { entries } = await api.get(RECENT());
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ id: started.id, startedAt: started.startedAt, note: 'Unplanned work' });
  expect(entries[0].endedAt).toBeTruthy();
});

test('choosing another project moves the running clock without stopping it', async ({ me }) => {
  const { page, api } = me;
  await api.clockInAgo('Acme / Platform', 30, 'Build');
  await page.goto('/?view=list');

  await picker(page, 'Project the clock is running on').click();
  await pick(page, 'Support');
  await expect(page.getByText(/^Now on Acme \/ Support, from /)).toBeVisible();

  const { entries } = await api.get(RECENT());
  expect(entries).toHaveLength(2);
  const [before, after] = entries;
  // The first stretch ends exactly where the next starts: no gap, no overlap.
  expect(Date.parse(before.endedAt)).toBe(Date.parse(after.startedAt));
  expect(before.note).toBe('Build');
  expect(after.endedAt).toBeUndefined();
  expect(after.projectId).toBe(await api.project('Acme / Support'));
  await expect(page.getByRole('form', { name: 'Clock' }).getByRole('timer')).toHaveText(/^0:00:\d\d$/);
});

test('changing project seconds after starting corrects the clock in place', async ({ me }) => {
  const { page, api } = me;
  await page.goto('/');
  await picker(page).click();
  await pick(page, 'Platform');
  await page.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await picker(page, 'Project the clock is running on').click();
  await pick(page, 'Support');
  await expect(picker(page, 'Project the clock is running on')).toContainText('Acme / Support');

  const { entries } = await api.get(RECENT());
  expect(entries).toHaveLength(1);
  expect(entries[0].projectId).toBe(await api.project('Acme / Support'));
});

test('a note typed before choosing a project goes with the new stretch', async ({ me }) => {
  const { page, api } = me;
  await api.clockInAgo('Acme / Platform', 30, 'Build');
  await page.goto('/');
  await note(page).fill('Customer call');
  await picker(page, 'Project the clock is running on').click();
  await pick(page, 'Support');
  await expect(page.getByText(/^Now on Acme \/ Support/)).toBeVisible();

  const { entries } = await api.get(RECENT());
  expect(entries.map((e: { note: string }) => e.note)).toEqual(['Build', 'Customer call']);
});

test('the running note saves when it is left', async ({ me }) => {
  const { page, api } = me;
  await api.clockInAgo('Acme / Platform', 5);
  await page.goto('/');
  await note(page).fill('Reviewing');
  await note(page).press('Enter');
  await expect.poll(async () => (await api.get('/me')).running.note).toBe('Reviewing');
});

test('an earlier entry starts the clock on the same work again', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Support', week.at(1, '09:00'), week.at(1, '10:00'), 'Ticket 42');
  await page.goto(`/?view=list&day=${week.day(1)}`);
  await page.getByRole('button', { name: 'Start the clock on this again' }).click();

  await expect(note(page)).toHaveValue('Ticket 42');
  await expect(picker(page, 'Project the clock is running on')).toContainText('Acme / Support');
  expect((await api.get('/me')).running.note).toBe('Ticket 42');
});

test('typing a note suggests earlier work, and taking one fills in its project', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Support', week.at(1, '09:00'), week.at(1, '10:00'), 'Ticket 42');
  await api.entry('Acme / Platform', week.at(2, '09:00'), week.at(2, '10:00'), 'Code review');
  await api.entry('Acme / Support', week.at(3, '09:00'), week.at(3, '10:00'), 'Code review');
  await page.goto('/');

  // Choosing the empty note offers the latest work first.
  await note(page).click();
  const list = page.getByRole('listbox', { name: 'Previously tracked' });
  await expect(list.getByRole('option')).toHaveText([/^Code review.*Support/, /^Code review.*Platform/, /^Ticket 42/]);

  // Typing narrows it, and the arrow keys and Enter take one.
  await note(page).fill('revi');
  await expect(list.getByRole('option')).toHaveCount(2);
  await note(page).press('ArrowDown');
  await note(page).press('ArrowDown');
  await note(page).press('Enter');
  await expect(list).toHaveCount(0);
  await expect(note(page)).toHaveValue('Code review');
  await expect(picker(page)).toContainText('Acme / Platform');
  expect((await api.get('/me')).running).toBeUndefined();

  await page.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await expect
    .poll(async () => (await api.get('/me')).running)
    .toMatchObject({ note: 'Code review', projectId: await api.project('Acme / Platform') });
});

test('taking a suggestion while the clock runs changes the running entry in place', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Support', week.at(1, '09:00'), week.at(1, '10:00'), 'Ticket 42');
  const started = await api.clockInAgo('Acme / Platform', 20);
  await page.goto('/');

  await note(page).fill('ticket');
  await page.getByRole('option', { name: /Ticket 42/ }).click();
  await expect(note(page)).toBeFocused();
  await expect(picker(page, 'Project the clock is running on')).toContainText('Acme / Support');
  await expect
    .poll(async () => (await api.get('/me')).running)
    .toMatchObject({ id: started.id, note: 'Ticket 42', projectId: await api.project('Acme / Support') });
});

test('a note still unsaved when the clock stops is kept', async ({ me }) => {
  const { page, api } = me;
  await api.clockInAgo('Acme / Platform', 10);
  await page.goto('/');
  await note(page).fill('Wrapping up');
  await page.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();
  const { entries } = await api.get(RECENT());
  expect(entries).toHaveLength(1);
  expect(entries[0].note).toBe('Wrapping up');
});

test('the clock bar is on the Timer page only, and the clock keeps running elsewhere', async ({ me }) => {
  const { page, api } = me;
  await api.clockInAgo('Acme / Platform', 12, 'Build');
  for (const path of ['/overview', '/timesheet', '/time-off', '/reports']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Clock' })).toHaveCount(0);
  }
  await page.getByRole('link', { name: 'Timer', exact: true }).click();
  const bar = page.getByRole('form', { name: 'Clock' });
  await expect(bar.getByRole('timer')).toHaveText(/^0:1\d:\d\d$/);
  await expect(note(page)).toHaveValue('Build');
  await page.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();
  expect((await api.get('/me')).running).toBeUndefined();
});

test('a submitted pay period turns the clock off', async ({ me }) => {
  const { page, api } = me;
  await api.post('/timesheet/submit', { day: new Date().toISOString().slice(0, 10) });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeDisabled();
  await expect(note(page)).toBeDisabled();
  await expect(note(page)).toHaveAttribute('placeholder', /timesheet is submitted/);
});

test('the running time opens a panel that moves the start to another day', async ({ me }) => {
  const { page, api } = me;
  const started = await api.clockInAgo('Acme / Platform', 30, 'Build');
  await page.goto('/');
  const bar = page.getByRole('form', { name: 'Clock' });
  await bar.getByRole('button', { name: 'Change the start or stop time' }).click();
  const panel = page.getByRole('dialog', { name: 'Start and stop' });
  const start = DateTime.fromISO(started.startedAt).setZone(ZONE);
  await expect(panel.getByLabel('Start', { exact: true })).toHaveValue(start.toFormat('HH:mm'));
  await expect(panel).toContainText('Today');

  // Escape leaves it as it was.
  await panel.getByLabel('Start', { exact: true }).fill('00:00');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect((await api.get('/me')).running.startedAt).toBe(started.startedAt);

  await bar.getByRole('button', { name: 'Change the start or stop time' }).click();
  const yesterday = start.minus({ days: 1 });
  await panel.getByRole('button', { name: yesterday.setLocale('en-US').toLocaleString(DateTime.DATE_HUGE) }).click();
  await panel.getByLabel('Start', { exact: true }).press('Enter');
  await expect(panel).toBeHidden();
  await expect
    .poll(async () => Date.parse((await api.get('/me')).running.startedAt))
    .toBe(yesterday.startOf('minute').toMillis());
  await expect(bar.getByRole('timer')).toHaveText(/^2[345]:\d\d:\d\d$/);
});

test('changing the stop time stops the clock then', async ({ me }) => {
  const { page, api } = me;
  const started = await api.clockInAgo('Acme / Platform', 120, 'Build');
  await page.goto('/');
  const bar = page.getByRole('form', { name: 'Clock' });
  await bar.getByRole('button', { name: 'Change the start or stop time' }).click();
  const panel = page.getByRole('dialog', { name: 'Start and stop' });
  const stop = DateTime.now().setZone(ZONE).minus({ minutes: 60 });
  await panel.getByLabel('Stop', { exact: true }).fill(stop.toFormat('HH:mm'));
  await panel.getByLabel('Stop', { exact: true }).press('Enter');
  await expect(bar.getByRole('timer')).toHaveCount(0);
  const { entries } = await api.get(RECENT());
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ id: started.id, startedAt: started.startedAt, note: 'Build' });
  expect(Date.parse(entries[0].endedAt)).toBe(stop.startOf('minute').toMillis());
});
