import type { Page } from '@playwright/test';
import { column, drag, expect, hourPoint, instant, lastWeek, test } from './fixtures';

// The calendar shows 7 AM to 7 PM unless something lies outside it.
const FROM = 7;
const TO = 19;
const at = (page: Page, weekday: number, hour: number, across = 0.5) =>
  hourPoint(page, weekday, hour, FROM, TO, across);
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const dayTotal = (page: Page, date: RegExp) => page.getByRole('group', { name: date });

test('dragging an empty stretch adds time there', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await page.goto(`/?day=${week.day(2)}`);
  await expect(column(page, 2)).toBeVisible();

  await drag(page, await at(page, 2, 9), await at(page, 2, 11.5));
  const add = dialog(page, 'Add time');
  await expect(add.locator('input[type=date]')).toHaveValue(week.day(2));
  await expect(add.locator('input[type=time]').first()).toHaveValue('09:00');
  await expect(add.locator('input[type=time]').last()).toHaveValue('11:30');

  await add.getByRole('button', { name: /^Project: / }).click();
  await page.getByRole('option', { name: 'Platform' }).click();
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(add).toBeHidden();

  await expect(column(page, 2).locator('[data-entry]')).toHaveCount(1);
  await expect(dayTotal(page, /^Wednesday/)).toContainText('2h 30m');
  const { entries } = await api.get(`/entries?from=${week.day(2)}&to=${week.day(2)}`);
  expect(instant(entries[0].startedAt)).toBe(instant(week.at(2, '09:00')));
});

test('dragging an edge changes when an entry ends, on five-minute marks', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '12:00'), 'Build');
  await page.goto(`/?day=${week.day(1)}`);
  const block = column(page, 1).locator('[data-entry]');
  await expect(block).toBeVisible();

  const end = await at(page, 1, 12);
  // Not on a mark: it lands on the nearest one.
  await drag(page, { x: end.x, y: end.y - 2 }, await at(page, 1, 14.03));
  await expect
    .poll(async () => instant((await api.get(`/entries?from=${week.day(1)}&to=${week.day(1)}`)).entries[0].endedAt))
    .toBe(instant(week.at(1, '14:00')));
  await expect(dayTotal(page, /^Tuesday/)).toContainText('5h 0m');
});

test('dragging a block moves it and keeps its length', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'));
  await page.goto(`/?day=${week.day(0)}`);
  await expect(column(page, 0).locator('[data-entry]')).toBeVisible();

  await drag(page, await at(page, 0, 9.5), await at(page, 0, 13.5));
  await expect
    .poll(async () => {
      const e = (await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`)).entries[0];
      return [instant(e.startedAt), instant(e.endedAt)];
    })
    .toEqual([instant(week.at(0, '13:00')), instant(week.at(0, '14:00'))]);
});

test('an edge moves with the arrow keys, and saves once the keys rest', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(3, '09:00'), week.at(3, '10:00'), 'Build');
  await page.goto(`/?day=${week.day(3)}`);

  const start = page.getByRole('slider', { name: 'Start of Build' });
  await start.focus();
  await expect(start).toHaveAttribute('aria-valuetext', '9:00 AM');
  await start.press('ArrowUp');
  await start.press('ArrowUp');
  await start.press('PageUp');
  await expect(start).toHaveAttribute('aria-valuetext', '8:20 AM');
  await expect
    .poll(async () => instant((await api.get(`/entries?from=${week.day(3)}&to=${week.day(3)}`)).entries[0].startedAt))
    .toBe(instant(week.at(3, '08:20')));
});

test('a block opens its entry to edit', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(4, '09:00'), week.at(4, '10:00'), 'Build');
  await page.goto(`/?day=${week.day(4)}`);

  await page.getByRole('button', { name: /^Edit Build, Acme \/ Platform, 9:00 AM – 10:00 AM, 1h 0m$/ }).press('Enter');
  const edit = dialog(page, 'Edit time');
  await edit.getByRole('textbox', { name: 'Note' }).fill('Build and test');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(column(page, 4)).toContainText('Build and test');
  expect((await api.get(`/entries?from=${week.day(4)}&to=${week.day(4)}`)).entries[0].note).toBe('Build and test');
});

test('a click on a block opens it too', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(4, '09:00'), week.at(4, '11:00'), 'Build');
  await page.goto(`/?day=${week.day(4)}`);
  const p = await at(page, 4, 10);
  await page.mouse.click(p.x, p.y);
  await expect(dialog(page, 'Edit time')).toBeVisible();
});

test('overlapping entries sit side by side and count once', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '17:00'), 'Long build');
  await api.entry('Meetings', week.at(0, '10:00'), week.at(0, '11:00'), 'Review triage');
  await page.goto(`/?day=${week.day(0)}`);

  const blocks = column(page, 0).locator('[data-entry]');
  await expect(blocks).toHaveCount(2);
  const [long, meeting] = await Promise.all([blocks.nth(0).boundingBox(), blocks.nth(1).boundingBox()]);
  if (!long || !meeting) throw new Error('blocks are not laid out');
  expect(long.x + long.width).toBeLessThanOrEqual(meeting.x + 1);

  // Eight hours passed, so eight were worked, though nine were recorded.
  await expect(dayTotal(page, /^Monday/)).toContainText('8h 0m');
  await expect(page.getByText('Week total').locator('..')).toContainText('8h 0m');
  const sheet = await api.get(`/timesheet?day=${week.day(0)}`);
  expect(sheet.regular).toBe(8);
});

test('a day ahead takes no time', async ({ me }) => {
  const { page } = me;
  await page.goto('/');
  await expect(column(page, 0)).toBeVisible();
  const ahead = page.locator('.wk-future .tl-track');
  test.skip((await ahead.count()) === 0, 'today is the last day of the week');
  const box = await ahead.last().boundingBox();
  if (!box) throw new Error('no column');
  await drag(page, { x: box.x + 20, y: box.y + 60 }, { x: box.x + 20, y: box.y + 160 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the list shows the week a day at a time', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '12:00'), 'Build');
  await api.entry('Acme / Support', week.at(2, '13:00'), week.at(2, '14:30'), 'Ticket');
  await page.goto(`/?day=${week.day(0)}`);
  await page.getByRole('button', { name: 'List' }).click();
  await expect(page).toHaveURL(/view=list/);
  const days = page.getByRole('main').locator('section h3');
  await expect(days).toHaveCount(2);
  await expect(days.first()).toContainText('Wednesday');
  await expect(page.getByRole('listitem').filter({ hasText: 'Ticket' })).toContainText('1h 30m');
});
