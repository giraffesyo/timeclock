import { expect, test } from './fixtures';

for (const mobile of [false, true]) {
  const device = mobile ? 'mobile' : 'desktop';
  test(`user menu opens with a left click and works from the keyboard on ${device}`, async ({
    adminPerson,
  }, testInfo) => {
    const { page } = await adminPerson();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: /: user menu$/ });
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeHidden();
    await trigger.click({ button: 'left' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Light or dark' })).toBeVisible();
    await page.screenshot({ path: `/tmp/timeclock-user-menu-${device}.png` });
    await testInfo.attach(`User menu ${device}`, {
      path: `/tmp/timeclock-user-menu-${device}.png`,
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.press('Enter');
    await page.getByRole('button', { name: /Change your time zone$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Your time zone' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await trigger.click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test(`people and managers have Foundation profiles and start read-only on ${device}`, async ({
    adminPerson,
    me,
    someone,
  }, testInfo) => {
    const { page } = await adminPerson();
    const manager = await someone('manager');
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const employee = (await me.api.get('/me')).person;
    const boss = (await manager.api.get('/me')).person;
    await page.route('**/profile-avatar.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#06354f"/><circle cx="16" cy="12" r="6" fill="#f0d4b4"/><path d="M4 32a12 12 0 0 1 24 0" fill="#82a9bb"/></svg>',
      }),
    );
    await page.route('**/api/v1/people', (route) =>
      route.fulfill({
        json: {
          people: [
            {
              ...employee,
              name: 'Ada Lovelace',
              avatarUrl: '/profile-avatar.svg',
              managerId: boss.id,
              directoryManagerId: boss.id,
              managerOverrideId: '',
            },
            { ...boss, name: 'Grace Hopper', avatarUrl: '/profile-avatar.svg' },
          ],
        },
      }),
    );
    await page.goto('/settings?tab=people');
    await page.bringToFront();
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Ada Lovelace', exact: true }) });
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(row.getByRole('textbox')).toHaveCount(0);
    await expect(row.locator('img')).toHaveCount(2);
    await expect(row.getByRole('button', { name: 'Grace Hopper', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Ada Lovelace', exact: true }).hover();
    await expect(page.getByText('Manager: Grace Hopper')).toBeVisible();
    // The manager is shown as a person, with their photo.
    const managerPhoto = page.getByText('Manager: Grace Hopper').getByRole('img', { name: 'Grace Hopper' });
    await expect(managerPhoto).toBeVisible();
    // Sized to the row's text, not the 24px default.
    expect((await managerPhoto.boundingBox())?.height).toBeLessThan(20);
    await page.screenshot({ path: `/tmp/timeclock-people-${device}.png` });
    await testInfo.attach(`People ${device}`, {
      path: `/tmp/timeclock-people-${device}.png`,
      contentType: 'image/png',
    });
    await row.getByRole('button', { name: 'Grace Hopper', exact: true }).focus();
    await expect(page.getByText('Manager: Admin approves')).toBeVisible();
    await row.getByRole('button', { name: 'Grace Hopper', exact: true }).blur();
    await expect(page.getByText('Manager: Admin approves')).toHaveCount(0);
    // The ⋯ button and a right click open the same menu, with Edit… first.
    const menu = page.getByRole('menu');
    // The menu closes on any scroll, and bringing the row into view may scroll: retry.
    const open = async (target: typeof row, button?: 'right') => {
      await target.scrollIntoViewIfNeeded();
      let items: string[] = [];
      await expect(async () => {
        await target.click(button ? { button } : {});
        await expect(menu.getByRole('button').first()).toBeVisible({ timeout: 1000 });
        items = await menu.getByRole('button').allTextContents();
      }).toPass();
      return items;
    };
    const fromButton = await open(row.getByRole('button', { name: 'More actions' }));
    expect(fromButton[0]).toBe('Edit…');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await open(row.getByRole('cell').first(), 'right')).toEqual(fromButton);
    await page.screenshot({ path: `/tmp/timeclock-people-menu-${device}.png` });
    await testInfo.attach(`People menu ${device}`, {
      path: `/tmp/timeclock-people-menu-${device}.png`,
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(async () => {
      await row.getByRole('cell').first().click({ button: 'right' });
      await menu.getByRole('button', { name: 'Edit…' }).click({ timeout: 1000 });
    }).toPass();
    const dialog = page.getByRole('dialog', { name: 'Edit Ada Lovelace' });
    await expect(dialog.getByRole('combobox', { name: 'Manager' })).toHaveValue('');
    await expect(dialog.getByRole('option', { name: 'From directory: Grace Hopper' })).toHaveCount(1);
    // Editing happens in the dialog, so the table keeps its width.
    await expect(row.getByRole('combobox')).toHaveCount(0);
    if (!mobile) {
      const table = page.getByRole('table').locator('..');
      expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: `/tmp/timeclock-people-edit-${device}.png` });
    await testInfo.attach(`People edit ${device}`, {
      path: `/tmp/timeclock-people-edit-${device}.png`,
      contentType: 'image/png',
    });
    const saved = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith(`/people/${me.id}`),
    );
    await dialog.getByRole('textbox', { name: 'Payroll ID' }).fill('PAY-123');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const body = (await saved).postDataJSON();
    expect(body.managerId).toBe('');
    expect(body.payrollId).toBe('PAY-123');
    await expect(dialog).toHaveCount(0);

    // The Display menu chooses the columns.
    if (!mobile) {
      await page.getByRole('button', { name: 'Display options' }).click();
      const display = page.getByRole('menu');
      await expect(display).toBeVisible();
      await page.screenshot({ path: `/tmp/timeclock-people-display-${device}.png` });
      await testInfo.attach(`People display ${device}`, {
        path: `/tmp/timeclock-people-display-${device}.png`,
        contentType: 'image/png',
      });
      await expect(page.getByRole('columnheader', { name: 'Email' })).toHaveCount(1);
      await display.getByRole('button', { name: 'Email' }).click();
      await expect(page.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
      await expect(row.getByText(employee.email)).toHaveCount(0);
    }
  });
}
