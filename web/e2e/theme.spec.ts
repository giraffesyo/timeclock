import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const ground = (page: Page) => page.locator('.shell').evaluate((el) => getComputedStyle(el).backgroundColor);
const sheet = (page: Page) => page.locator('.shell-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);

// The workspace's theme is one thing everyone shares, so its tests take turns.
test.describe.configure({ mode: 'serial' });

test('a person chooses light or dark, and it stays', async ({ me }) => {
  const { page } = me;
  await page.goto('/');
  const html = page.locator('html');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(html).toHaveClass(/dark/);
  expect(await sheet(page)).toBe('rgb(23, 24, 29)');

  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(html).not.toHaveClass(/dark/);
  expect(await sheet(page)).toBe('rgb(255, 255, 255)');
});

test('an admin sets the workspace’s look from a few values, and everyone gets it', async ({ me, adminPerson }) => {
  const admin = await adminPerson();
  const { page } = admin;
  await page.emulateMedia({ colorScheme: 'light' });
  await me.page.emulateMedia({ colorScheme: 'light' });
  try {
    await page.goto('/settings?tab=appearance');
    await expect(page.getByText('This workspace uses Timeclock’s own look.')).toBeVisible();
    expect(await ground(page)).toBe('rgb(243, 244, 247)');

    // The page wears the draft as it changes.
    await page.getByRole('button', { name: 'Navy' }).click();
    await expect.poll(() => ground(page)).toBe('rgb(6, 53, 79)');
    await expect(page.getByRole('textbox', { name: 'Accent' }).first()).toHaveValue(/^#06354f$/i);

    // A background that can't be read on is refused before it is saved.
    const background = page.getByRole('textbox', { name: 'Background' }).first();
    await background.fill('#101010');
    await expect(page.getByRole('alert')).toContainText('background is a dark color');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await background.fill('#f3f4f6');
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The workspace’s look is saved.')).toBeVisible();
    await expect(page.getByText('This workspace has its own look.')).toBeVisible();

    // Someone else, on their next visit.
    await me.page.goto('/');
    await expect.poll(() => ground(me.page)).toBe('rgb(6, 53, 79)');
    await expect(
      me.page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Timer' }),
    ).toBeVisible();
  } finally {
    await admin.api.put('/theme', {});
  }
  await page.reload();
  await expect.poll(() => ground(page)).toBe('rgb(243, 244, 247)');
});

test('only an admin changes the look', async ({ me }) => {
  const refused = await me.api.try('put', '/theme', {
    light: { interface: { accent: '#aa0000', background: '#ffffff' } },
  });
  expect(refused.status()).toBe(403);
});

test('a look is copied and pasted as a few values', async ({ adminPerson }) => {
  const { page } = await adminPerson();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/settings?tab=appearance');
  const accent = page.getByRole('textbox', { name: 'Accent' }).first();
  const plain = await accent.inputValue();

  await page.getByRole('button', { name: 'Navy' }).click();
  await expect.poll(() => ground(page)).toBe('rgb(6, 53, 79)');
  await page.getByRole('button', { name: 'Copy theme' }).click();
  await expect(page.getByText('Theme copied.')).toBeVisible();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.light.interface.accent).toMatch(/^#06354f$/i);

  // Back to what was saved, then the copy brings the draft back.
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(accent).toHaveValue(plain);
  await expect.poll(() => ground(page)).toBe('rgb(243, 244, 247)');
  await page.getByRole('button', { name: 'Paste theme' }).click();
  await expect(accent).toHaveValue(/^#06354f$/i);
  await expect.poll(() => ground(page)).toBe('rgb(6, 53, 79)');

  // Something that isn't a theme changes nothing.
  await page.evaluate(() => navigator.clipboard.writeText('not a theme'));
  await page.getByRole('button', { name: 'Paste theme' }).click();
  await expect(page.getByText('There is no theme on the clipboard.')).toBeVisible();
  await expect(accent).toHaveValue(/^#06354f$/i);
  await page.getByRole('button', { name: 'Discard' }).click();
});
