import type { Locator, Page } from '@playwright/test';
import { DateTime } from 'luxon';
import { ZONE } from '../playwright.config';
import { expect, test } from './fixtures';

/** How many quiet weeks this worker has handed out. */
let taken = 0;

/**
 * A week no other test touches. Holidays are the whole workspace's, and the
 * end-to-end tests share one per run, so each test takes its own week long
 * ago: six weeks apart, more than any pay period, and apart per worker.
 */
function quietWeek(worker: number) {
  const slot = (worker % 32) + 32 * taken++;
  const monday = DateTime.fromISO('1950-01-02', { zone: ZONE }).plus({ weeks: 6 * slot });
  return {
    day: (weekday: number) => monday.plus({ days: weekday }).toISODate() as string,
    at: (weekday: number, time: string) => {
      const [hour = 0, minute = 0] = time.split(':').map(Number);
      return monday.plus({ days: weekday }).set({ hour, minute }).toUTC().toISO() as string;
    },
  };
}

/** A timesheet's row for one day, and its Holiday hours. */
function dayRow(page: Page, day: string) {
  const row = page.locator('tr', { has: page.locator(`button[aria-controls="day-${day}"]`) });
  return { row, holiday: row.getByRole('cell').nth(4) };
}

/** Opens a People row's menu and chooses an item; a scroll closes the menu, so it retries. */
async function choose(page: Page, row: Locator, item: string) {
  await row.scrollIntoViewIfNeeded();
  await expect(async () => {
    await row.getByRole('cell').first().click({ button: 'right' });
    await page.getByRole('menu').getByRole('button', { name: item, exact: true }).click({ timeout: 1000 });
  }).toPass();
}

for (const mobile of [false, true]) {
  const device = mobile ? 'mobile' : 'desktop';
  test(`an admin adds a company holiday over several days, and it is paid without overtime on ${device}`, async ({
    admin,
    adminPerson,
    me,
  }, testInfo) => {
    const { page } = await adminPerson();
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await me.page.setViewportSize({ width: 390, height: 844 });
    }
    const week = quietWeek(testInfo.parallelIndex);
    const name = `Founders Day ${Math.random().toString(36).slice(2, 8)}`;
    // Ten hours a day Tuesday to Friday is 40 worked hours: no overtime,
    // whatever the holiday adds.
    for (const d of [1, 2, 3, 4]) await me.api.entry('Acme / Platform', week.at(d, '07:00'), week.at(d, '17:00'));

    // Monday pays the default 8 hours; Tuesday, a half day, pays 4.
    await page.goto('/settings');
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Company holidays' }) });
    await panel.getByRole('button', { name: 'Add holiday' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a holiday' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Day 1', { exact: true }).fill(week.day(0));
    await dialog.getByRole('button', { name: 'Add a day' }).click();
    await dialog.getByLabel('Day 2', { exact: true }).fill(week.day(1));
    await dialog.getByLabel('Hours on day 2').fill('4');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    const item = panel.getByRole('listitem').filter({ hasText: name });
    await expect(item).toContainText('(4 h)');
    await item.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/timeclock-holidays-settings-${device}.png` });
    await testInfo.attach(`Holidays settings ${device}`, {
      path: `/tmp/timeclock-holidays-settings-${device}.png`,
      contentType: 'image/png',
    });

    // The person's timesheet shows the holiday on its days, as paid hours that
    // never push their worked time into overtime.
    await me.page.goto(`/timesheet?day=${week.day(0)}`);
    const monday = dayRow(me.page, week.day(0));
    await expect(monday.row).toContainText(name);
    await expect(monday.holiday).toHaveText('8.00');
    await expect(dayRow(me.page, week.day(1)).holiday).toHaveText('4.00');
    const sheet = await me.api.get(`/timesheet?day=${week.day(0)}`);
    expect(sheet).toMatchObject({ holiday: 12, regular: 40, overtime: 0 });
    await me.page.screenshot({ path: `/tmp/timeclock-holidays-timesheet-${device}.png` });
    await testInfo.attach(`Timesheet with a holiday ${device}`, {
      path: `/tmp/timeclock-holidays-timesheet-${device}.png`,
      contentType: 'image/png',
    });

    // Holiday pay is set per person in People: not paid, the day is still named.
    await page.goto('/settings?tab=people');
    const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${me.name}` }) });
    await choose(page, row, 'Edit…');
    const edit = page.getByRole('dialog', { name: `Edit ${me.name}` });
    await edit.getByRole('combobox', { name: 'Holiday pay' }).selectOption({ label: 'Not paid' });
    await page.screenshot({ path: `/tmp/timeclock-holidays-people-${device}.png` });
    await testInfo.attach(`People holiday pay ${device}`, {
      path: `/tmp/timeclock-holidays-people-${device}.png`,
      contentType: 'image/png',
    });
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toHaveCount(0);
    if (!mobile) {
      // The column is one the Display menu shows.
      // Other tests change the shared list under the open menu, so open and choose in one retried step.
      await expect(async () => {
        if (!(await page.getByRole('menu').isVisible()))
          await page.getByRole('button', { name: 'Display options' }).click();
        await page.getByRole('menu').getByRole('button', { name: 'Holiday pay' }).click({ timeout: 1000 });
      }).toPass();
      await page.keyboard.press('Escape');
      await expect(row).toContainText('Not paid');
    }
    const saved = (await admin.get('/people')).people.find((p: { id: string }) => p.id === me.id);
    expect(saved).toMatchObject({ holidayPay: false, holidayPayOverride: false });
    expect((await me.api.get(`/timesheet?day=${week.day(0)}`)).holiday).toBe(0);
    await me.page.reload();
    await expect(dayRow(me.page, week.day(0)).row).toContainText(name);
    await expect(dayRow(me.page, week.day(0)).holiday).toHaveText('0.00');

    // Deleting the holiday leaves the workspace as it was.
    await page.goto('/settings');
    await item.getByRole('button', { name: `Delete ${name}` }).click();
    await page
      .getByRole('dialog', { name: `Delete ${name}?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(item).toHaveCount(0);
  });
}

test('a holiday day in a submitted timesheet holds until it is sent back', async ({ admin, me }, testInfo) => {
  const week = quietWeek(testInfo.parallelIndex);
  const name = `Locked Day ${Math.random().toString(36).slice(2, 8)}`;
  await me.api.entry('Acme / Platform', week.at(2, '09:00'), week.at(2, '17:00'));
  await me.api.post('/timesheet/submit', { day: week.day(2) });

  const refused = await admin.try('post', '/holidays', { name, days: [{ day: week.day(0) }] });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe('period_locked');

  // Sent back, the day can become a holiday, and is paid once resubmitted.
  const sheet = await me.api.get(`/timesheet?day=${week.day(2)}`);
  await admin.post(`/timesheets/${sheet.timesheet.id}/reopen`, { note: 'Adding a holiday' });
  const holiday = await admin.post('/holidays', { name, days: [{ day: week.day(0) }] });
  expect((await me.api.get(`/timesheet?day=${week.day(0)}`)).holiday).toBe(8);
  await admin.delete(`/holidays/${holiday.id}`);
});
