import { expect, test } from './fixtures';

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
  await expect(page.getByText('2 people are now overtime exempt.')).toBeVisible();
  await expect.poll(() => exempt(bea)).toBe(true);
  await expect.poll(() => exempt(cal)).toBe(true);
  await page.getByRole('button', { name: 'Clear selection' }).click();

  // A right click on a row outside the selection changes that person alone.
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${cal.name}` }) });
  await row.getByText(cal.email).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Change 1 person' });
  await expect(menu.getByRole('menuitem', { name: 'Mark overtime exempt' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Mark not overtime exempt' }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => exempt(cal)).toBe(false);
  expect(await exempt(bea)).toBe(true);

  // The keyboard's menu key opens it too, and Escape closes it.
  await row.getByRole('checkbox', { name: `Select ${cal.name}` }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});
