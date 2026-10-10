import type { Locator, Page } from '@playwright/test';
import { expect, lastWeek, test } from './fixtures';

/** The menu a right click on the target opens. It closes on any scroll, so open it again if that moved the page. */
async function rightClickMenu(page: Page, target: Locator) {
  const menu = page.getByRole('menu');
  let items: string[] = [];
  await target.scrollIntoViewIfNeeded();
  await expect(async () => {
    await target.click({ button: 'right' });
    await expect(menu.getByRole('button').first()).toBeVisible({ timeout: 1000 });
    // The menu's own items: a submenu the pointer happens to open lists its items inside.
    items = (await menu.locator(':scope > button, :scope > [role=none] > button').allTextContents()).map((s) =>
      s.trim(),
    );
    // Read while one menu replaces another, it can come back empty: read again.
    expect(items.length).toBeGreaterThan(0);
  }).toPass();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return items;
}

test('a person has the same right-click menu wherever they appear', async ({
  me,
  someone,
  manages,
  adminPerson,
}, testInfo) => {
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '17:00'));
  const { page } = await adminPerson();
  const everywhere = ['Open timesheet', 'Open timer', 'Edit settings…'];

  // A name in a report, outside any list of people.
  await page.goto(`/reports?day=${week.day(1)}`);
  const name = page.getByRole('row').filter({ hasText: me.name }).first().getByRole('button', { name: me.name });
  expect(await rightClickMenu(page, name)).toEqual([...everywhere, 'Copy']);

  // A row in Team and in People leads with the same items, then its own.
  await page.goto(`/team?day=${week.day(1)}`);
  const teamRow = page.getByRole('row').filter({ hasText: me.name }).getByRole('cell').last();
  expect((await rightClickMenu(page, teamRow)).slice(0, 3)).toEqual(everywhere);
  await page.goto('/people');
  const peopleRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: `Select ${me.name}` }) })
    .getByRole('cell')
    .first();
  expect((await rightClickMenu(page, peopleRow)).slice(0, 3)).toEqual(everywhere);

  // Edit settings… opens the same dialog from any page.
  await page.goto(`/reports?day=${week.day(1)}`);
  await expect(async () => {
    await name.click({ button: 'right' });
    await page.screenshot({ path: '/tmp/timeclock-person-menu-report.png' });
    await page.getByRole('menu').getByRole('button', { name: 'Edit settings…' }).click({ timeout: 1000 });
  }).toPass();
  await expect(page.getByRole('dialog', { name: `Edit ${me.name}` })).toBeVisible();
  await testInfo.attach('Person menu in a report', {
    path: '/tmp/timeclock-person-menu-report.png',
    contentType: 'image/png',
  });
  await page.keyboard.press('Escape');

  // A manager sees their report's pages, but settings are an admin's.
  const boss = await someone('boss');
  await manages(boss, me);
  await boss.page.goto(`/team?day=${week.day(1)}`);
  const bossName = boss.page.getByRole('row').filter({ hasText: me.name }).getByRole('cell').last();
  expect(await rightClickMenu(boss.page, bossName)).toEqual(['Open timesheet', 'Open timer', 'Copy']);
});
