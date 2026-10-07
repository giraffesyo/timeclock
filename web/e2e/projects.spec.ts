import { expect, RECENT, test } from './fixtures';

test('an admin adds an internal project, and people record time on it', async ({ me, adminPerson }) => {
  const admin = await adminPerson();
  const name = `Holiday ${Date.now().toString(36)}`;
  await admin.page.goto('/projects');
  const catalog = admin.page.getByRole('table');
  await catalog.getByRole('button', { name: 'Add a project to Internal' }).click();
  const dialog = admin.page.getByRole('dialog', { name: 'Add project' });
  await dialog.getByLabel('Name').fill(name);
  await expect(dialog.getByRole('combobox', { name: 'Customer' })).toHaveValue('No customer (internal work)');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(catalog).toContainText(name);

  const { page, api } = me;
  await page.goto('/');
  await page
    .getByRole('form', { name: 'Clock' })
    .getByRole('button', { name: /^Project: / })
    .click();
  await page.getByRole('combobox', { name: 'Search projects' }).fill('holiday');
  await page.getByRole('option', { name }).click();
  await page.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Clock' }).getByRole('timer')).toBeVisible();
  // It goes by its own name, with no customer in front.
  await expect(
    page.getByRole('form', { name: 'Clock' }).getByRole('button', { name: `Project the clock is running on: ${name}` }),
  ).toBeVisible();
  expect((await api.get(RECENT())).entries).toHaveLength(1);
});

test('the project picker works from the keyboard', async ({ me }) => {
  const { page } = me;
  await page.goto('/');
  const trigger = page.getByRole('form', { name: 'Clock' }).getByRole('button', { name: /^Project: / });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const search = page.getByRole('combobox', { name: 'Search projects' });
  await expect(search).toBeFocused();
  await search.pressSequentially('acme sup');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAccessibleName('Project: Acme / Support');
  await expect(trigger).toBeFocused();

  // Escape closes the list and leaves the choice alone.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName('Project: Acme / Support');
});

test('a project’s customer is found by typing part of its name', async ({ adminPerson, admin }) => {
  const { page } = await adminPerson();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const customer = await admin.post('/customers', { name: `Northwind Traders ${suffix}` });
  const name = `Search pick ${suffix}`;
  await page.goto('/projects');
  // From Internal, so no customer is chosen yet.
  await page.getByRole('table').getByRole('button', { name: 'Add a project to Internal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project' });
  await dialog.getByLabel('Name').fill(name);
  const pick = dialog.getByRole('combobox', { name: 'Customer' });
  await pick.fill(`traders ${suffix}`);
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: `Northwind Traders ${suffix}` }).click();
  await expect(pick).toHaveValue(`Northwind Traders ${suffix}`);
  await pick.fill('no such customer');
  await expect(page.getByText('Nothing matches “no such customer”.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(pick).toHaveValue(`Northwind Traders ${suffix}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const { projects } = await admin.get('/projects');
  expect(projects.find((p: { name: string }) => p.name === name)?.customerId).toBe(customer.id);
});
