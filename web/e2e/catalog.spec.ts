import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** The row whose name cell says this, exactly. */
const rowNamed = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });

// The row menu closes on any scroll, and bringing a row into view may scroll:
// open it and read or choose in one retried step.
async function menuItems(page: Page, target: Locator, button?: 'right') {
  await target.scrollIntoViewIfNeeded();
  let items: string[] = [];
  await expect(async () => {
    await target.click(button ? { button } : {});
    await expect(page.getByRole('menu').getByRole('button').first()).toBeVisible({ timeout: 1000 });
    items = await page.getByRole('menu').getByRole('button').allTextContents();
  }).toPass();
  return items;
}
async function choose(page: Page, target: Locator, item: string) {
  await target.scrollIntoViewIfNeeded();
  await expect(async () => {
    await target.click({ button: 'right' });
    await page.getByRole('menu').getByRole('button', { name: item, exact: true }).click({ timeout: 1000 });
  }).toPass();
}

for (const mobile of [false, true]) {
  const device = mobile ? 'mobile' : 'desktop';
  test(`customers and projects are changed from the row menu on ${device}`, async ({ adminPerson }, testInfo) => {
    const { page } = await adminPerson();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const key = `${device}-${Date.now().toString(36)}`;
    const customer = `Globex ${key}`;
    const project = `Design ${key}`;
    await page.goto('/projects');

    await page.getByRole('button', { name: 'Add customer' }).click();
    const add = page.getByRole('dialog', { name: 'Add customer' });
    await add.getByLabel('Name').fill(customer);
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(add).toBeHidden();

    // ⋯ and a right click open the same menu: adding comes first, deleting last.
    const row = rowNamed(page, customer);
    const fromButton = await menuItems(page, row.getByRole('button', { name: 'More actions' }));
    expect(fromButton).toEqual(['Add project…', 'Rename…', 'Archive…', 'Delete…']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await menuItems(page, row.getByRole('cell').first(), 'right')).toEqual(fromButton);
    await page.screenshot({ path: `/tmp/timeclock-catalog-menu-${device}.png` });
    await testInfo.attach(`Catalog menu ${device}`, {
      path: `/tmp/timeclock-catalog-menu-${device}.png`,
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');

    await choose(page, row.getByRole('cell').first(), 'Add project…');
    const addProject = page.getByRole('dialog', { name: 'Add project' });
    await addProject.getByLabel('Name', { exact: true }).fill(project);
    await addProject.getByLabel('Code').fill('D-100');
    await addProject.getByRole('button', { name: 'Save' }).click();
    await expect(addProject).toBeHidden();
    const projectRow = rowNamed(page, project);
    await expect(projectRow).toBeVisible();

    // A click on a project opens it.
    await projectRow.getByRole('cell').first().click();
    const edit = page.getByRole('dialog', { name: 'Edit project' });
    await expect(edit.getByLabel('Name', { exact: true })).toHaveValue(project);
    await page.screenshot({ path: `/tmp/timeclock-catalog-edit-${device}.png` });
    await testInfo.attach(`Catalog edit ${device}`, {
      path: `/tmp/timeclock-catalog-edit-${device}.png`,
      contentType: 'image/png',
    });
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toBeHidden();

    // The filter's flyout opens to the left of its panel, off a phone's screen:
    // archiving and the filter are covered on desktop.
    if (!mobile) {
      // Archived projects are hidden until the filter shows them.
      expect(await menuItems(page, projectRow.getByRole('cell').first(), 'right')).toEqual([
        'Edit…',
        'Archive…',
        'Delete…',
      ]);
      await page.keyboard.press('Escape');
      await choose(page, projectRow.getByRole('cell').first(), 'Archive…');
      await page
        .getByRole('dialog', { name: `Archive ${project}?` })
        .getByRole('button', { name: 'Archive' })
        .click();
      await expect(projectRow).toHaveCount(0);
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
      await expect(projectRow).toBeVisible();
      await expect(projectRow.getByText('Archived')).toBeVisible();
      await page.screenshot({ path: `/tmp/timeclock-catalog-archived-${device}.png` });
      await testInfo.attach(`Catalog archived ${device}`, {
        path: `/tmp/timeclock-catalog-archived-${device}.png`,
        contentType: 'image/png',
      });

      // The menu keys open it too, beside the focused row.
      await expect(async () => {
        await projectRow.getByRole('button', { name: 'More actions' }).focus();
        await page.keyboard.press('Shift+F10');
        await expect(page.getByRole('menu').getByRole('button', { name: 'Unarchive' })).toBeVisible({ timeout: 1000 });
      }).toPass();
      await page.getByRole('menu').getByRole('button', { name: 'Unarchive' }).click();
      await expect(projectRow.getByText('Archived')).toHaveCount(0);
    }

    // Never used, so both can be deleted.
    await choose(page, projectRow.getByRole('cell').first(), 'Delete…');
    await page
      .getByRole('dialog', { name: `Delete ${project}?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(projectRow).toHaveCount(0);
    await choose(page, row.getByRole('cell').first(), 'Delete…');
    await page
      .getByRole('dialog', { name: `Delete ${customer}?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(row).toHaveCount(0);
  });
}
