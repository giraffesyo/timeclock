import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const ground = (page: Page) => page.locator('.shell').evaluate((el) => getComputedStyle(el).backgroundColor);
const sheet = (page: Page) => page.locator('.shell-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);
const style = (page: Page, selector: string, property: 'color' | 'backgroundColor') =>
  page
    .locator(selector)
    .first()
    .evaluate((el, p) => getComputedStyle(el)[p], property);
// The current section, in the sidebar or, on a phone, the strip of sections.
const here = (side: '.shell-side' | '.shell-top') => `${side} nav a[aria-current="page"]`;
/** The color of the current section's icon: the sidebar's accent. */
const marked = (page: Page, side: '.shell-side' | '.shell-top' = '.shell-side') =>
  style(page, `${here(side)} svg`, 'color');
/** The wash behind the current section: a share of the sidebar's accent. */
const washed = (page: Page, side: '.shell-side' | '.shell-top' = '.shell-side') =>
  style(page, here(side), 'backgroundColor');
const sidebarText = (page: Page) => style(page, '.shell-side', 'color');

// The workspace's theme is one thing everyone shares, so its tests take turns.
test.describe.configure({ mode: 'serial' });

for (const mobile of [false, true]) {
  test(`a person chooses their theme in Settings${mobile ? ' on mobile' : ''}`, async ({ me }) => {
    const { page } = me;
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /: user menu$/ }).click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const html = page.locator('html');
    const preference = page.getByRole('group', { name: 'Color theme' });
    await expect(page.getByRole('heading', { name: 'Workspace colors' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link')).toHaveCount(1);
    await preference.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(html).toHaveClass(/dark/);
    expect(await sheet(page)).toBe('rgb(23, 24, 29)');

    await page.reload();
    await expect(html).toHaveClass(/dark/);
    await expect(preference.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await preference.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(html).not.toHaveClass(/dark/);
    expect(await sheet(page)).toBe('rgb(255, 255, 255)');
    await expect(preference.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({
      path: `/tmp/timeclock-appearance-${mobile ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
      animations: 'disabled',
    });

    await preference.getByRole('button', { name: 'System', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).not.toHaveClass(/dark/);
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Timer' }).click();
    await page.reload();
    await expect(html).not.toHaveClass(/dark/);

    // Personal preferences do not grant access to workspace administration.
    await page.goto('/people');
    await expect(page.getByText('An admin manages payroll settings, projects and people.')).toBeVisible();
  });
}

test('an admin can change their theme without losing a workspace draft', async ({ adminPerson }) => {
  const { page } = await adminPerson();
  await page.goto('/settings?tab=appearance');
  const preference = page.getByRole('group', { name: 'Color theme' });
  const html = page.locator('html');
  await preference.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await preference.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Navy' }).click();
  await expect(page.getByRole('textbox', { name: 'Accent', exact: true })).toHaveValue(/^#06354f$/i);
  await preference.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(html).not.toHaveClass(/dark/);
  await expect(page.getByRole('textbox', { name: 'Accent', exact: true })).toHaveValue(/^#06354f$/i);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.screenshot({ path: '/tmp/timeclock-appearance-admin.png', fullPage: true, animations: 'disabled' });
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
    await expect(page.getByRole('textbox', { name: 'Accent', exact: true })).toHaveValue(/^#06354f$/i);

    // A background that can't be read on is refused before it is saved.
    const background = page.getByRole('textbox', { name: 'Background', exact: true });
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
  const accent = page.getByRole('textbox', { name: 'Accent', exact: true });
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

test('the sidebar has colors of its own, and the current section wears its accent', async ({ me, adminPerson }) => {
  const admin = await adminPerson();
  const { page } = admin;
  await page.emulateMedia({ colorScheme: 'light' });
  await me.page.emulateMedia({ colorScheme: 'light' });
  try {
    await page.goto('/settings?tab=appearance');
    // Timeclock's own: an indigo accent on a cool gray sidebar.
    await expect.poll(() => marked(page)).toBe('rgb(75, 80, 217)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => marked(page)).toBe('rgb(124, 131, 247)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => marked(page)).toBe('rgb(75, 80, 217)');
    await expect.poll(() => washed(page)).toMatch(/^color\(srgb 0\.29\d* 0\.31\d* 0\.85\d* \/ 0\.14\)$/);
    expect(await ground(page)).toBe('rgb(243, 244, 247)');

    const sidebar = page.getByRole('switch', { name: 'Its own sidebar colors' });
    await expect(sidebar).toBeChecked();
    // The sidebar's fields are named apart from the page's.
    await expect(page.getByRole('textbox', { name: 'Accent', exact: true })).toHaveCount(1);
    const accent = page.getByRole('textbox', { name: 'Sidebar accent', exact: true });
    const background = page.getByRole('textbox', { name: 'Sidebar background', exact: true });
    const contrast = page.getByRole('slider', { name: 'Sidebar contrast' });

    // Each of the sidebar's values shows as it changes, and only on the sidebar.
    await accent.fill('#0f766e');
    await expect.poll(() => marked(page)).toBe('rgb(15, 118, 110)');
    await expect.poll(() => washed(page)).toMatch(/^color\(srgb 0\.05\d* 0\.46\d* 0\.43\d* \/ 0\.14\)$/);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCSS(
      'background-color',
      'rgb(75, 80, 217)',
    );
    await background.fill('#e6f4f1');
    await expect.poll(() => ground(page)).toBe('rgb(230, 244, 241)');
    expect(await sheet(page)).toBe('rgb(255, 255, 255)');
    expect(await sidebarText(page)).toBe('rgb(0, 0, 0)');
    await contrast.fill('60');
    await expect.poll(() => sidebarText(page)).not.toBe('rgb(0, 0, 0)');
    await contrast.fill('100');
    await expect.poll(() => sidebarText(page)).toBe('rgb(0, 0, 0)');

    // An accent that would vanish into the sidebar is deepened until it shows.
    await accent.fill('#dcefea');
    await expect.poll(() => marked(page)).not.toBe('rgb(15, 118, 110)');
    expect(await marked(page)).not.toBe('rgb(220, 239, 234)');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await accent.fill('#0f766e');
    await expect.poll(() => marked(page)).toBe('rgb(15, 118, 110)');

    // Without colors of its own, the sidebar is the page's background a
    // little deeper, with the page's accent; turned back on, it is as it was.
    await sidebar.click();
    await expect(sidebar).not.toBeChecked();
    await expect(accent).toHaveCount(0);
    await expect.poll(() => ground(page)).toBe('rgb(244, 244, 244)');
    await expect.poll(() => marked(page)).toBe('rgb(75, 80, 217)');
    await sidebar.click();
    await expect(accent).toHaveValue(/^#0f766e$/i);
    await expect(background).toHaveValue(/^#e6f4f1$/i);
    await expect.poll(() => ground(page)).toBe('rgb(230, 244, 241)');

    // In dark, the sidebar goes without colors of its own; light keeps its.
    await page.getByRole('group', { name: 'Which mode to edit' }).getByRole('button', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(sidebar).toBeChecked();
    await sidebar.click();
    await expect.poll(() => ground(page)).toBe('rgb(14, 14, 17)');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('The workspace’s look is saved.')).toBeVisible();
    expect((await admin.api.get('/me')).info.workspaceTheme).toEqual({
      light: {
        interface: { accent: '#4b50d9', background: '#ffffff' },
        sidebar: { accent: '#0f766e', background: '#e6f4f1', contrast: 1 },
      },
      dark: { interface: { accent: '#7c83f7', background: '#17181d' } },
    });

    // The admin's own page, after the editor is gone.
    await page.reload();
    await expect(accent).toHaveValue(/^#0f766e$/i);
    await expect.poll(() => ground(page)).toBe('rgb(230, 244, 241)');
    await expect.poll(() => marked(page)).toBe('rgb(15, 118, 110)');

    // Someone else, in light and in dark, on a computer and on a phone.
    await me.page.goto('/');
    await expect.poll(() => ground(me.page)).toBe('rgb(230, 244, 241)');
    await expect.poll(() => marked(me.page)).toBe('rgb(15, 118, 110)');
    await me.page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => ground(me.page)).toBe('rgb(14, 14, 17)');
    await expect.poll(() => marked(me.page)).toBe('rgb(124, 131, 247)');
    await me.page.emulateMedia({ colorScheme: 'light' });
    await me.page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => marked(me.page, '.shell-top')).toBe('rgb(15, 118, 110)');
    await expect.poll(() => washed(me.page, '.shell-top')).toMatch(/ \/ 0\.14\)$/);
    await me.page.screenshot({ path: '/tmp/timeclock-sidebar-mobile.png', animations: 'disabled' });
    await page.screenshot({ path: '/tmp/timeclock-sidebar-desktop.png', fullPage: true, animations: 'disabled' });
  } finally {
    await admin.api.put('/theme', {});
  }
});

test('the sidebar’s muted text is its own text toward its background, not the page’s', async ({ me, adminPerson }) => {
  const admin = await adminPerson();
  await admin.api.put('/theme', {
    dark: {
      interface: { accent: '#7c83f7', background: '#17181d', contrast: 0.9 },
      sidebar: { accent: '#ffffff', background: '#223daa', contrast: 0.9 },
    },
  });
  try {
    const { page } = me;
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect.poll(() => ground(page)).toBe('rgb(34, 61, 170)');
    // Near white, two thirds of the way from the blue: AA on it, where the
    // page's gray was not. The sections and the group labels alike, and on a
    // phone, the strip of sections.
    const muted = /^color\(srgb 0\.67\d* 0\.71\d* 0\.87\d*\)$/;
    expect(await style(page, '.shell-side nav a:not([aria-current])', 'color')).toMatch(muted);
    expect(await style(page, '.shell-side nav > div > div:first-child', 'color')).toMatch(muted);
    await page.screenshot({ path: '/tmp/timeclock-sidebar-muted.png', animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await style(page, '.shell-top nav a:not([aria-current])', 'color')).toMatch(muted);
    await page.screenshot({ path: '/tmp/timeclock-sidebar-muted-mobile.png', animations: 'disabled' });
  } finally {
    await admin.api.put('/theme', {});
  }
});

test('choosing light or dark from the menu ends a preview of the workspace’s colors', async ({ adminPerson }) => {
  const admin = await adminPerson();
  const { page } = admin;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/settings?tab=appearance');
  const html = page.locator('html');
  const menu = async () => {
    await page.getByRole('button', { name: /: user menu$/ }).click();
    return page.getByRole('group', { name: 'Light or dark' });
  };
  await (await menu()).getByRole('button', { name: 'Light', exact: true }).click();
  await page.keyboard.press('Escape');

  // The draft shows in the mode being edited.
  await page.getByRole('button', { name: 'Navy' }).click();
  await expect.poll(() => ground(page)).toBe('rgb(6, 53, 79)');
  await page.getByRole('group', { name: 'Which mode to edit' }).getByRole('button', { name: 'Dark' }).click();
  await expect(html).toHaveClass(/dark/);

  // The person's choice wins, even of what was already chosen.
  await (await menu()).getByRole('button', { name: 'Light', exact: true }).click();
  await expect(html).not.toHaveClass(/dark/);
  await expect.poll(() => ground(page)).toBe('rgb(243, 244, 247)');
  await page.keyboard.press('Escape');

  // Editing again shows the draft again, and Dark from the menu leaves it.
  await page.getByRole('button', { name: 'Navy' }).click();
  await expect.poll(() => ground(page)).toBe('rgb(6, 53, 79)');
  await (await menu()).getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(html).toHaveClass(/dark/);
  await expect.poll(() => ground(page)).toBe('rgb(14, 15, 19)');
  await page.keyboard.press('Escape');
  // The draft is still there to save.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Discard changes' }).click();
});
