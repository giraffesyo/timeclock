import type { Locator, Page } from '@playwright/test';
import { column, expect, lastWeek, test } from './fixtures';

/** Opens a row's menu and picks an item. The menu closes on any scroll, so both happen in one retried step. */
async function choose(page: Page, target: Locator, item: string, button?: 'right') {
  await target.scrollIntoViewIfNeeded();
  await expect(async () => {
    await target.click(button ? { button } : {});
    await page.getByRole('menu').getByRole('button', { name: item, exact: true }).click({ timeout: 1000 });
  }).toPass();
}

for (const mobile of [false, true]) {
  const device = mobile ? 'mobile' : 'desktop';
  test(`a manager opens an employee's timer from Team, in both views, on ${device}`, async ({
    me,
    someone,
    manages,
  }, testInfo) => {
    const boss = await someone('boss');
    await manages(boss, me);
    const week = lastWeek();
    await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '12:00'), 'Build the export');
    const page = boss.page;
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });

    await page.goto(`/team?day=${week.day(1)}`);
    const row = page.getByRole('row').filter({ hasText: me.name });
    await choose(page, row.getByRole('button', { name: 'More actions' }), 'Open timer');
    await expect(page).toHaveURL(new RegExp(`[?&]person=${me.id}`));
    await expect(page.getByRole('heading', { name: `Timer · ${me.name}` })).toBeVisible();
    // The clock above stays the manager's own, and says so.
    await expect(
      page.getByText(`${me.name}’s week. Time you add here is theirs; the clock above is yours.`),
    ).toBeVisible();
    await expect(page.getByText('3h 0m').first()).toBeVisible();
    await page.screenshot({ path: `/tmp/timeclock-employee-timer-calendar-${device}.png` });
    await testInfo.attach(`Employee timer calendar ${device}`, {
      path: `/tmp/timeclock-employee-timer-calendar-${device}.png`,
      contentType: 'image/png',
    });

    // The list shows their entries, and doesn't offer to start the manager's clock from them.
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.getByText('Build the export')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Start the clock on this again' })).toHaveCount(0);
    await page.screenshot({ path: `/tmp/timeclock-employee-timer-list-${device}.png` });
    await testInfo.attach(`Employee timer list ${device}`, {
      path: `/tmp/timeclock-employee-timer-list-${device}.png`,
      contentType: 'image/png',
    });

    // To their timesheet and back.
    await page.getByRole('link', { name: 'Open timesheet' }).click();
    await expect(page).toHaveURL(new RegExp(`/timesheet\\?.*person=${me.id}`));
    await expect(page.getByRole('heading', { name: `Timesheet · ${me.name}` })).toBeVisible();
    await page.getByRole('link', { name: 'Open timer' }).click();
    await expect(page.getByRole('heading', { name: `Timer · ${me.name}` })).toBeVisible();

    // And back to the manager's own week.
    await page.getByRole('link', { name: 'Back to your week' }).click();
    await expect(page).not.toHaveURL(/person=/);
    await expect(page.getByText('Build the export')).toHaveCount(0);
  });
}

test("an admin opens someone's timer from People", async ({ me, adminPerson }) => {
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(2, '13:00'), week.at(2, '15:00'), 'Review the plan');
  const admin = await adminPerson();
  await admin.page.goto('/people');
  const row = admin.page
    .getByRole('row')
    .filter({ has: admin.page.getByRole('checkbox', { name: `Select ${me.name}` }) });
  await choose(admin.page, row.getByRole('cell').first(), 'Open timer', 'right');
  await expect(admin.page.getByRole('heading', { name: `Timer · ${me.name}` })).toBeVisible();
  await admin.page.goto(`/?person=${me.id}&day=${week.day(2)}&view=list`);
  await expect(admin.page.getByText('Review the plan')).toBeVisible();
});

test('a submitted week stays read-only for the manager, and others are refused', async ({ me, someone, manages }) => {
  const boss = await someone('boss');
  const stranger = await someone('cal');
  await manages(boss, me);
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '17:00'), 'Locked work');
  await me.api.post('/timesheet/submit', { day: week.day(1) });

  await boss.page.goto(`/?person=${me.id}&day=${week.day(1)}`);
  await expect(boss.page.getByRole('heading', { name: `Timer · ${me.name}` })).toBeVisible();
  await expect(column(boss.page, 1).getByRole('img', { name: /in a submitted timesheet$/ })).toBeVisible();
  await expect(column(boss.page, 1).getByRole('slider')).toHaveCount(0);

  // Someone who isn't their manager sees an error, not their own week in its place.
  await stranger.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '10:00'), 'Stranger time');
  await stranger.page.goto(`/?person=${me.id}&day=${week.day(1)}&view=list`);
  await expect(stranger.page.getByText('Couldn’t load this week’s time.')).toBeVisible();
  await expect(stranger.page.getByText('Locked work')).toHaveCount(0);
  await expect(stranger.page.getByText('Stranger time')).toHaveCount(0);
});
