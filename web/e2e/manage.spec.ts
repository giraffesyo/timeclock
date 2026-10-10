import { expect, lastWeek, test } from './fixtures';

const sections = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Sections' });

test('an admin manages people, projects, integrations and settings from the sidebar', async ({ adminPerson }) => {
  const { page } = await adminPerson();
  await page.goto('/');
  const manage = ['People', 'Projects', 'Integrations', 'Settings'];
  for (const name of manage) {
    await sections(page).getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(sections(page).getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  // Settings keeps only what is set once.
  const tabs = page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link');
  await expect(tabs).toHaveText(['Payroll', 'Sign-in', 'Appearance', 'Calendar']);
  // The page is People; its table doesn't repeat that.
  await sections(page).getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Everyone', exact: true })).toBeVisible();
  // History is the host's auditors' alone: an admin isn't one for being an admin.
  await expect(sections(page).getByRole('link', { name: 'History', exact: true })).toHaveCount(0);
  await sections(page).getByRole('link', { name: 'Reports', exact: true }).click();
  const reports = page.getByRole('navigation', { name: 'Reports', exact: true }).getByRole('link');
  await expect(reports).toHaveText(['Payroll', 'Exceptions', 'Projects']);
  expect((await page.request.get('/api/v1/audit')).status()).toBe(403);
});

test('the host’s auditor reads History, as a Reports tab, without being an admin', async ({ me, auditorPerson }) => {
  // A change for History to name, by someone the auditor doesn't manage.
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '12:00'));
  const { page } = await auditorPerson();
  await page.goto('/');
  await expect(sections(page).getByRole('link', { name: 'History', exact: true })).toHaveCount(0);
  await sections(page).getByRole('link', { name: 'Reports', exact: true }).click();
  const reports = page.getByRole('navigation', { name: 'Reports', exact: true }).getByRole('link');
  await expect(reports).toHaveText(['Projects', 'History']);
  await reports.filter({ hasText: 'History' }).click();
  await expect(page).toHaveURL(/[?&]tab=history/);
  await expect(page.getByText('Changes to payroll data')).toBeVisible();
  // Not an admin, who sees everyone, yet the log names who did what.
  await expect(page.getByRole('row').filter({ hasText: me.name }).first()).toBeVisible();
  for (const name of ['People', 'Projects', 'Integrations']) {
    await expect(sections(page).getByRole('link', { name, exact: true })).toHaveCount(0);
  }
});

test('someone who isn’t an admin has no Manage group or History', async ({ me }) => {
  await me.page.goto('/');
  for (const name of ['People', 'Projects', 'Integrations', 'History', 'Settings']) {
    await expect(sections(me.page).getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  await me.page.goto('/reports?tab=history');
  await expect(me.page.getByRole('link', { name: 'History', exact: true })).toHaveCount(0);
  await expect(me.page.getByText('Changes to payroll data')).toHaveCount(0);
  await me.page.goto('/people');
  await expect(me.page.getByText('An admin manages payroll settings, projects and people.')).toBeVisible();
});

test('the pay period preview reads as text, not as a control', async ({ adminPerson }) => {
  const { page } = await adminPerson();
  await page.goto('/settings');
  await expect(page.getByLabel('First day of a period')).toBeVisible();
  const preview = page.locator('dl').filter({ hasText: 'Current period' });
  await expect(preview).toContainText(/Current period\s*\w{3} \d+ – /);
  await expect(preview).toContainText('Next period');
  // No filled surface or pointer, so nothing about it suggests a click.
  expect(await preview.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await preview.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('pointer');
});
