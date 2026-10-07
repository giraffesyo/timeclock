import type { Locator, Page } from '@playwright/test';
import { expect, lastWeek, test } from './fixtures';

/** The row menu's items. It closes on any scroll, so open it again if bringing the row into view moved the page. */
async function menuItems(page: Page, target: Locator, button?: 'right') {
  const menu = page.getByRole('menu');
  let items: string[] = [];
  await target.scrollIntoViewIfNeeded();
  await expect(async () => {
    await target.click(button ? { button } : {});
    await expect(menu.getByRole('button').first()).toBeVisible({ timeout: 1000 });
    items = (await menu.getByRole('button').allTextContents()).map((s) => s.trim());
  }).toPass();
  return items;
}

for (const mobile of [false, true]) {
  const device = mobile ? 'mobile' : 'desktop';
  test(`the team list opens timesheets, decides from its menu, and sorts and filters on ${device}`, async ({
    me,
    someone,
    manages,
  }, testInfo) => {
    const boss = await someone('boss');
    const other = await someone('ben');
    await manages(boss, me, other);
    const week = lastWeek();
    await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '17:00'));
    await me.api.post('/timesheet/submit', { day: week.day(1) });
    await other.api.entry('Acme / Platform', week.at(2, '09:00'), week.at(2, '13:00'));

    const page = boss.page;
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/team?day=${week.day(1)}`);
    const row = (p: { name: string }) => page.getByRole('row').filter({ hasText: p.name });
    // A cell away from the name, whose profile card would cover the menus.
    const away = (p: { name: string }) => row(p).getByRole('cell').filter({ hasNotText: p.name }).first();
    await expect(row(me)).toContainText('Waiting for approval');
    await expect(row(other)).toContainText('Not submitted');

    // Names are the same profiles as on People: a card with the email on hover.
    const name = row(other).getByRole('button', { name: other.name, exact: true });
    await name.hover();
    await expect(page.getByText(other.email).first()).toBeVisible();
    await page.screenshot({ path: `/tmp/timeclock-team-profiles-card-${device}.png` });
    await testInfo.attach(`Team profile card ${device}`, {
      path: `/tmp/timeclock-team-profiles-card-${device}.png`,
      contentType: 'image/png',
    });
    await page.mouse.move(0, 0);
    await expect(page.getByText(other.email)).toHaveCount(0);

    // Sorted by name, and the Display menu turns the order around.
    const names = async () => {
      const text = await page.getByRole('table').locator('tbody tr').allTextContents();
      return [me, other].map((p) => text.findIndex((t) => t.includes(p.name)));
    };
    const before = async () => {
      const [a, b] = await names();
      return a < b;
    };
    expect(await before()).toBe(true);
    await page.getByRole('button', { name: 'Display options' }).click();
    await page.getByRole('menu').getByRole('button', { name: 'Ascending' }).click();
    await page.keyboard.press('Escape');
    await expect.poll(before).toBe(false);

    // A waiting timesheet's menu decides it, from ⋯ or a right click alike; the other only opens.
    const fromButton = await menuItems(page, row(me).getByRole('button', { name: 'More actions' }));
    expect(fromButton).toEqual([`Open ${me.name}’s timesheet`, `Open ${me.name}’s timer`, 'Approve', 'Send back']);
    await page.keyboard.press('Escape');
    expect(await menuItems(page, away(me), 'right')).toEqual(fromButton);
    await page.screenshot({ path: `/tmp/timeclock-team-menu-${device}.png` });
    await testInfo.attach(`Team menu ${device}`, {
      path: `/tmp/timeclock-team-menu-${device}.png`,
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    expect(await menuItems(page, away(other), 'right')).toEqual([
      `Open ${other.name}’s timesheet`,
      `Open ${other.name}’s timer`,
    ]);
    await page.keyboard.press('Escape');

    // The keyboard's menu key opens it too.
    await expect(async () => {
      await row(me).getByRole('button', { name: me.name, exact: true }).focus();
      await page.keyboard.press('Shift+F10');
      await expect(page.getByRole('menu')).toBeVisible({ timeout: 1000 });
    }).toPass();
    await page.keyboard.press('Escape');
    await row(me).getByRole('button', { name: me.name, exact: true }).blur();

    // Approve is pinned on the row (from 44rem up) and in the menu, and still asks first.
    if (!mobile) {
      await row(me).hover();
      await expect(row(me).getByRole('button', { name: 'Approve' })).toBeVisible();
      await page.screenshot({ path: `/tmp/timeclock-team-pinned-${device}.png` });
      await testInfo.attach(`Team pinned ${device}`, {
        path: `/tmp/timeclock-team-pinned-${device}.png`,
        contentType: 'image/png',
      });
      await row(me).getByRole('button', { name: 'Approve' }).click();
    } else {
      await expect(async () => {
        await away(me).click({ button: 'right' });
        await page.getByRole('menu').getByRole('button', { name: 'Approve' }).click({ timeout: 1000 });
      }).toPass();
    }
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(row(me)).toContainText('Approved');
    expect(await menuItems(page, away(me), 'right')).toEqual([
      `Open ${me.name}’s timesheet`,
      `Open ${me.name}’s timer`,
    ]);
    await page.keyboard.press('Escape');

    // The status filter. Away from the names first: a focused or hovered name keeps its profile card open.
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByRole('menu').getByRole('button', { name: 'Timesheet' }).click();
    await page.getByRole('menu').getByRole('button', { name: 'Not submitted', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(row(other)).toBeVisible();
    await expect(row(me)).toHaveCount(0);
    await page.screenshot({ path: `/tmp/timeclock-team-filter-${device}.png` });
    await testInfo.attach(`Team filter ${device}`, {
      path: `/tmp/timeclock-team-filter-${device}.png`,
      contentType: 'image/png',
    });

    // A click on the row opens the person's timesheet: anywhere but its controls, like the status badge.
    await row(other)
      .getByRole('cell')
      .filter({ hasNot: page.getByRole('button') })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/timesheet\\?.*person=${other.id}`));
  });
}
