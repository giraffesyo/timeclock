import type { Locator, Page } from '@playwright/test';
import { expect, lastWeek, test } from './fixtures';

const tooltip = (page: Page) => page.locator('#global-tooltip');

test('badges explain themselves on hover and on keyboard focus', async ({ someone, adminPerson, admin }) => {
  const week = lastWeek();
  const ada = await someone('ada');
  await ada.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '17:00'));
  // Pending time off: an exception to settle before payroll.
  await ada.api.post('/time-off', { from: week.day(3), to: week.day(3), hours: 8, kind: 'vacation' });
  const { page } = await adminPerson();

  // One tooltip serves every badge: let the last one close before showing the next,
  // or a check can read a tooltip that is still on its way out.
  const shows = async (target: Locator, text: string | RegExp, how: 'hover' | 'focus' = 'hover') => {
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(tooltip(page)).toBeHidden();
    await (how === 'hover' ? target.hover() : target.focus());
    await expect(tooltip(page)).toContainText(text);
  };

  // Payroll: why someone isn't in the export yet.
  await page.goto(`/reports?day=${week.day(0)}`);
  const row = page.getByRole('row').filter({ hasText: ada.name });
  const notReady = row.getByRole('button', { name: 'Not ready', exact: true });
  await shows(notReady, 'Left out of the export until their timesheet is approved');
  // From the keyboard: focusing a badge shows the same.
  await shows(notReady, 'Left out of the export', 'focus');
  // Screen readers get the explanation with the badge, as its description.
  await expect(notReady).toHaveAccessibleName('Not ready');
  await expect(notReady).toHaveAccessibleDescription(/^Left out of the export/);
  // The status inside the timesheet link explains itself on hover, and is read as part of the link.
  const sheet = row.getByRole('link', { name: /^Open the timesheet of/ });
  await shows(sheet, 'Not submitted yet for this pay period');
  await expect(sheet).toContainText(/Not submitted\.\s*Not submitted yet for this pay period/);

  // People: what Admin means.
  await page.goto('/people');
  const adminBadge = page.getByRole('button', { name: 'Admin', exact: true }).first();
  await expect(adminBadge).toHaveAccessibleDescription(/^Runs payroll/);
  await shows(adminBadge, 'Runs payroll');

  // Projects: billable, and archived.
  const customer = await admin.post('/customers', {
    name: `Badges ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  });
  const old = `Old work ${customer.id.slice(0, 8)}`;
  const project = await admin.post('/projects', { name: old, customerId: customer.id, billable: true });
  await admin.put(`/projects/${project.id}`, {
    name: old,
    customerId: customer.id,
    billable: true,
    archived: true,
  });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Filter' }).click();
  await page
    .getByRole('menu')
    .getByRole('button', { name: /^Archived/ })
    .click();
  await page
    .getByRole('menu')
    .getByRole('button', { name: /^Show archived/ })
    .click();
  await page.keyboard.press('Escape');
  const archivedRow = page.getByRole('row').filter({ hasText: old });
  const archived = archivedRow.getByRole('button', { name: 'Archived', exact: true }).first();
  const billable = archivedRow.getByRole('button', { name: 'Billable', exact: true }).first();
  await expect(archived).toHaveAccessibleDescription(/^No new time can be recorded/);
  await expect(billable).toHaveAccessibleDescription(/can be billed to the customer/);
  await shows(archived, 'No new time can be recorded');
  await shows(billable, 'can be billed to the customer');

  // Exceptions: what the severity means.
  await page.goto(`/reports?tab=exceptions&day=${week.day(0)}`);
  const group = page.locator('section').filter({ has: page.getByRole('button', { name: ada.name }) });
  const severity = group.getByRole('button', { name: 'Settle before payroll' }).first();
  await expect(severity).toHaveAccessibleDescription(/^Payroll would be wrong or incomplete/);
  await shows(severity, 'Payroll would be wrong or incomplete');
});

test('Not ready follows whether timesheets need approval', async ({ someone, adminPerson }) => {
  const week = lastWeek();
  const ada = await someone('ada');
  await ada.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '17:00'));
  const { page } = await adminPerson();
  // Approvals off for this page only: the workspace is shared with other tests.
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, settings: { ...body.settings, approveTimesheets: false } } });
  });
  await page.goto(`/reports?day=${week.day(0)}`);
  const row = page.getByRole('row').filter({ hasText: ada.name });
  await row.getByRole('button', { name: /^Not ready/ }).hover();
  await expect(tooltip(page)).toContainText('until they submit their timesheet');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
