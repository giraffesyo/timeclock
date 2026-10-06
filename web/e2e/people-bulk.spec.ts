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
  const menu = page.getByRole('menu');
  // One item per setting, saying what it would do for who is selected.
  await expect(menu.getByRole('button', { name: 'Mark overtime exempt' })).toHaveCount(0);
  await menu.getByRole('button', { name: 'Mark not overtime exempt' }).click();
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

test('someone set to reports only has no timesheet to submit and is left out of payroll', async ({
  adminPerson,
  someone,
}) => {
  const { page, api } = await adminPerson();
  const dee = await someone('dee');
  await page.goto('/settings?tab=people');
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${dee.name}` }) });
  await expect(row).toContainText('Submits');
  await row.getByText(dee.email).click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: 'Reports only, not in payroll' }).click();
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
  await row.getByText(dee.email).click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: 'Use the workspace default for timesheets' }).click();
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
  await row.getByRole('button', { name: `Actions for ${fay.name}` }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Make admin' }).click();
  const confirm = page.getByRole('dialog', { name: `Make ${fay.name} an admin?` });
  await confirm.getByRole('button', { name: 'Make admin' }).click();
  await expect(row.getByText('Admin', { exact: true })).toBeVisible();
  // Fay is an admin on her own next request.
  await expect.poll(async () => (await fay.api.get('/me')).admin).toBe(true);

  await row.getByText(fay.email).click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: 'Remove admin' }).click();
  await expect(row.getByText('Admin', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await fay.api.get('/me')).admin).toBe(false);

  // The workspace's own admin comes from the server, so it can't be removed here.
  const own = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select admin', exact: true }) });
  await expect(own.getByText('Admin', { exact: true })).toBeVisible();
  await own.getByRole('button', { name: 'Actions for admin' }).click();
  await expect(page.getByRole('menu').getByRole('button', { name: 'Remove admin' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});
