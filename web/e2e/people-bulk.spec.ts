import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The row menu closes on any scroll, as the page moves under it, and other
// tests' people keep this shared list moving. Open it and choose in one
// step, and do both again if a scroll closed it in between.
async function choose(page: Page, target: Locator, item: string, how: 'right' | 'click' = 'right') {
  await target.scrollIntoViewIfNeeded();
  await expect(async () => {
    await target.click(how === 'right' ? { button: 'right' } : {});
    await page.getByRole('menu').getByRole('button', { name: item, exact: true }).click({ timeout: 1000 });
  }).toPass();
  await confirm(page, item);
}

/** Confirms the action named in the dialog that asks first. */
async function confirm(page: Page, item: string) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: item.replace(/…$/, ''), exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** The menu's items for a row, by name. */
async function menuItems(page: Page, target: Locator, how: 'right' | 'click' = 'right') {
  await target.scrollIntoViewIfNeeded();
  let items: string[] = [];
  await expect(async () => {
    await target.click(how === 'right' ? { button: 'right' } : {});
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1000 });
    items = await page.getByRole('menu').getByRole('button').allTextContents();
    expect(items.length).toBeGreaterThan(0);
  }).toPass();
  await page.keyboard.press('Escape');
  return items;
}

test('an admin changes several people at once from the selection or a right click', async ({
  adminPerson,
  someone,
}) => {
  const { page, api } = await adminPerson();
  const bea = await someone('bea');
  const cal = await someone('cal');
  const exempt = async (p: { id: string }) =>
    ((await api.get('/people')).people as { id: string; overtimeExempt: boolean }[]).find((x) => x.id === p.id)
      ?.overtimeExempt;

  await page.goto('/settings?tab=people');
  await page.getByRole('checkbox', { name: `Select ${bea.name}`, exact: true }).check();
  await page.getByRole('checkbox', { name: `Select ${cal.name}`, exact: true }).check();
  await expect(page.getByRole('status').filter({ hasText: '2 people selected' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark overtime exempt' }).click();
  await expect(page.getByRole('dialog')).toContainText('Mark 2 people overtime exempt?');
  await confirm(page, 'Mark overtime exempt');
  await expect(page.getByText('2 people are now overtime exempt.')).toBeVisible();
  await expect.poll(() => exempt(bea)).toBe(true);
  await expect.poll(() => exempt(cal)).toBe(true);
  await page.getByRole('button', { name: 'Clear selection' }).click();

  // A right click on a row outside the selection changes that person alone.
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${cal.name}` }) });
  // One item per setting, saying what it would do for who is selected.
  const items = await menuItems(page, row.getByRole('cell').first());
  expect(items).toContain('Mark not overtime exempt');
  expect(items).not.toContain('Mark overtime exempt');
  await choose(page, row.getByRole('cell').first(), 'Mark not overtime exempt');
  const menu = page.getByRole('menu');
  await expect(menu).toBeHidden();
  await expect.poll(() => exempt(cal)).toBe(false);
  expect(await exempt(bea)).toBe(true);

  // The keyboard's menu key opens it too, and Escape closes it.
  await expect(async () => {
    await row.getByRole('checkbox', { name: `Select ${cal.name}` }).focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('someone set to reports only has no timesheet to submit and is left out of payroll', async ({
  adminPerson,
  someone,
}) => {
  const { page, api } = await adminPerson();
  const dee = await someone('dee');
  await page.goto('/settings?tab=people');
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${dee.name}` }) });
  await expect(row).toContainText('Submits');
  await choose(page, row.getByRole('cell').first(), 'Reports only, not in payroll');
  await expect(row).toContainText('Reports only');

  // Their own timesheet says so, and offers nothing to submit.
  await dee.page.goto('/timesheet');
  await expect(dee.page.getByText('Your time is for reports only')).toBeVisible();
  await expect(dee.page.getByRole('button', { name: 'Submit timesheet' })).toHaveCount(0);
  const refused = await dee.page.request.post('/api/v1/timesheet/submit', {
    data: { day: (await dee.api.get('/me')).today },
  });
  expect(refused.status()).toBe(409);
  const { rows } = await api.get('/reports/payroll');
  expect((rows as { person: { id: string } }[]).some((r) => r.person.id === dee.id)).toBe(false);

  // Back to the workspace default: they submit again.
  await choose(page, row.getByRole('cell').first(), 'Use the workspace default for timesheets');
  await expect(row).toContainText('Submits · default');
});

test('an admin makes someone an admin from the row menu, and only grants made here can be taken back', async ({
  adminPerson,
  someone,
}) => {
  const { page } = await adminPerson();
  const fay = await someone('fay');
  await page.goto('/settings?tab=people');
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${fay.name}` }) });
  await expect(row.getByText('Admin', { exact: true })).toHaveCount(0);

  // The ⋮ button opens the same menu as a right click.
  await choose(page, row.getByRole('button', { name: 'More actions' }), 'Make admin', 'click');
  await expect(row.getByText('Admin', { exact: true })).toBeVisible();
  // Fay is an admin on her own next request.
  await expect.poll(async () => (await fay.api.get('/me')).admin).toBe(true);

  await choose(page, row.getByRole('cell').first(), 'Remove admin');
  await expect(row.getByText('Admin', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await fay.api.get('/me')).admin).toBe(false);

  // The workspace's own admin comes from the server, so it can't be removed here.
  const own = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select admin', exact: true }) });
  await expect(own.getByText('Admin', { exact: true })).toBeVisible();
  await own.getByRole('button', { name: 'More actions' }).scrollIntoViewIfNeeded();
  await expect(async () => {
    await own.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menu').getByRole('button', { name: 'Remove admin' })).toHaveAttribute(
      'aria-disabled',
      'true',
      { timeout: 1000 },
    );
  }).toPass();
});
