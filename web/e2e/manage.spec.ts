import { expect, test } from './fixtures';

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
  // History is looked at now and then: a Reports tab, not a sidebar link.
  await expect(sections(page).getByRole('link', { name: 'History', exact: true })).toHaveCount(0);
  await sections(page).getByRole('link', { name: 'Reports', exact: true }).click();
  const reports = page.getByRole('navigation', { name: 'Reports', exact: true }).getByRole('link');
  await expect(reports).toHaveText(['Payroll', 'Exceptions', 'Projects', 'History']);
  await reports.filter({ hasText: 'History' }).click();
  await expect(page).toHaveURL(/[?&]tab=history/);
  await expect(page.getByText('Changes to payroll data')).toBeVisible();
});

test('old Settings links land on the pages they moved to', async ({ adminPerson }) => {
  const { page } = await adminPerson();
  for (const [tab, path, heading] of [
    ['people', '/people', 'People'],
    ['projects', '/projects', 'Projects'],
    ['integrations', '/integrations', 'Integrations'],
  ]) {
    await page.goto(`/settings?tab=${tab}`);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  }
  // History moved twice, to a page and then to a Reports tab: both old links land there.
  for (const old of ['/settings?tab=history', '/history']) {
    await page.goto(old);
    await expect(page).toHaveURL(/\/reports\?tab=history$/);
    await expect(page.getByText('Changes to payroll data')).toBeVisible();
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
