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
    await page.screenshot({ path: `/tmp/timeclock-people-${device}.png` });
    await testInfo.attach(`People ${device}`, {
      path: `/tmp/timeclock-people-${device}.png`,
      contentType: 'image/png',
    });
    await row.getByRole('button', { name: 'Grace Hopper', exact: true }).focus();
    await expect(page.getByText('Manager: Admin approves')).toBeVisible();
    await row.getByRole('button', { name: 'Edit Ada Lovelace', exact: true }).click();
    await expect(row.getByRole('combobox', { name: 'Manager of Ada Lovelace' })).toHaveValue('');
    await expect(row.getByRole('option', { name: 'From directory: Grace Hopper' })).toHaveCount(1);
    const saved = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith(`/people/${me.id}`),
    );
    await row.getByRole('textbox', { name: 'Payroll ID of Ada Lovelace' }).fill('PAY-123');
    await row.getByRole('textbox', { name: 'Payroll ID of Ada Lovelace' }).press('Tab');
    expect((await saved).postDataJSON().managerId).toBe('');
    await expect(row.getByRole('button', { name: 'Done editing Ada Lovelace' })).toBeEnabled();
    await row.getByRole('button', { name: 'Done editing Ada Lovelace' }).click();
    await expect(row.getByRole('combobox')).toHaveCount(0);
  });
}
