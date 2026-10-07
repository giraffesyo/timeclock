import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// On a phone, a list's columns without a priority stack under the first instead
// of running off the side (the UI package's list view). Team's is covered in team-list.

const overflow = (page: Page) =>
  page
    .getByRole('table')
    .first()
    .evaluate((t) => (t.parentElement?.scrollWidth ?? 0) - (t.parentElement?.clientWidth ?? 0));

test('People on a phone shows each manager under the name, labelled', async ({ someone, manages, adminPerson }) => {
  const ada = await someone('ada');
  const { page } = await adminPerson();
  const boss = await someone('boss');
  await manages(boss, ada);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/people');
  const row = page.getByRole('row').filter({ hasText: ada.name });
  const stacked = row.locator('[data-stacked]');
  await expect(stacked).toBeVisible();
  await expect(stacked).toContainText('Manager');
  await expect(stacked.getByRole('button', { name: boss.name, exact: true })).toBeVisible();
  // The Manager column itself gives way.
  await expect(page.getByRole('columnheader', { name: 'Manager' })).toBeHidden();
  expect(await overflow(page)).toBe(0);
  // Wide, it is a column again, without the label.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('columnheader', { name: 'Manager' })).toBeVisible();
  await expect(row.locator('[data-stacked]')).toBeHidden();
});

test('Projects on a phone marks an archived project under its name', async ({ adminPerson, admin }) => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const customer = await admin.post('/customers', { name: `Phone ${suffix}` });
  const old = `Old site ${suffix}`;
  const project = await admin.post('/projects', { name: old, customerId: customer.id, billable: true });
  await admin.put(`/projects/${project.id}`, { name: old, customerId: customer.id, billable: true, archived: true });
  const { page } = await adminPerson();
  // The archived filter is set where the menu has room, and stays as the window narrows.
  await page.setViewportSize({ width: 1280, height: 800 });
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
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.getByRole('row').filter({ hasText: old });
  const chip = row.locator('[data-stacked]').getByRole('button', { name: 'Archived', exact: true });
  await expect(chip).toBeVisible();
  // Under the name, lined up with it.
  // Under the name, lined up with its text (project names are indented under their customer).
  const name = await row.getByText(old, { exact: true }).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y };
  });
  const chipBox = await chip.boundingBox();
  expect((chipBox?.y ?? 0) > name.y).toBe(true);
  expect(Math.abs((chipBox?.x ?? 0) - name.x)).toBeLessThan(2);
  expect(await overflow(page)).toBe(0);
});
