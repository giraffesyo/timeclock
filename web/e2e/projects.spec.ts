import { expect, RECENT, test } from './fixtures';

test('an admin adds an internal project, and people record time on it', async ({ me, adminPerson }) => {
  const admin = await adminPerson();
  const name = `Holiday ${Date.now().toString(36)}`;
  await admin.page.goto('/settings?tab=projects');
  const catalog = admin.page.getByRole('table');
  await catalog.getByRole('button', { name: 'Add a project to Internal' }).click();
  const dialog = admin.page.getByRole('dialog', { name: 'Add project' });
  await dialog.getByLabel('Name').fill(name);
  await expect(dialog.getByLabel('Customer')).toHaveValue('');
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
