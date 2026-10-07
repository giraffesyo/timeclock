import { type Browser, expect, type Page, test } from '@playwright/test';
import { workspaceKey } from './accounts';

// Timeclock inside another application (examples/host): mounted under
// /timeclock, with the host's people, organizations and colors. The host
// says who a request is from; here that is a header the tests set.

/** Someone the host has signed in, in one of its organizations. */
async function as(browser: Browser, email: string, org?: string): Promise<Page> {
  const headers: Record<string, string> = { 'X-Example-User': email };
  if (org) headers['X-Example-Org'] = org;
  const context = await browser.newContext({ extraHTTPHeaders: headers, colorScheme: 'light' });
  return context.newPage();
}

const api = async (page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown) => {
  const res = await page.request[method](`/timeclock/api/v1${path}`, data === undefined ? undefined : { data });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
};

const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' });
const ground = (page: Page) => page.locator('.shell').evaluate((el) => getComputedStyle(el).backgroundColor);
const sheet = (page: Page) => page.locator('.shell-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);

test('someone the host hasn’t signed in is sent to the host’s sign-in', async ({ page, request }) => {
  await page.goto('/timeclock/timesheet');
  await expect(page).toHaveURL(/\/\?signin=1&next=.*timeclock.*timesheet/);
  await expect(page.getByRole('heading', { name: 'Example Portal' })).toBeVisible();
  expect((await request.get('/timeclock/api/v1/me')).status()).toBe(401);
});

test('it runs under the host’s path, as the host’s person', async ({ browser }) => {
  const org = workspaceKey('org');
  const admin = await as(browser, 'admin@host.test', org);
  await api(admin, 'post', '/projects', { name: 'Fieldwork', billable: false });

  const page = await as(browser, 'ada@host.test', org);
  await page.goto('/timeclock/');
  await expect(sections(page).getByRole('link', { name: 'Timer' })).toHaveAttribute('href', '/timeclock/');
  await expect(page.getByRole('complementary').getByText('ada', { exact: true })).toBeVisible();
  // The host keeps the accounts: there is a way back to it, and nothing about signing in.
  await expect(page.getByRole('link', { name: 'Back to Example Portal' }).first()).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Account and sign-in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await page.getByRole('button', { name: /: user menu$/ }).click();
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

  // The clock works, against the API under the same path.
  await page.getByRole('textbox', { name: 'What you are working on' }).fill('Site visit');
  await page
    .getByRole('form', { name: 'Clock' })
    .getByRole('button', { name: /^Project: / })
    .click();
  await page.getByRole('option', { name: 'Fieldwork' }).click();
  await page.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Clock' }).getByRole('timer')).toBeVisible();
  expect((await api(page, 'get', '/me')).person.email).toBe('ada@host.test');

  // A page deep in the app loads from its own address.
  await sections(page).getByRole('link', { name: 'Timesheet' }).click();
  await expect(page).toHaveURL(/\/timeclock\/timesheet/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Timesheet' })).toBeVisible();
  // The clock bar stays on the Timer page, where the clock is still running.
  await expect(page.getByRole('form', { name: 'Clock' })).toHaveCount(0);
  await sections(page).getByRole('link', { name: 'Timer' }).click();
  await expect(page.getByRole('form', { name: 'Clock' }).getByRole('timer')).toBeVisible();
  await page.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();

  // The host's admin runs payroll here; sign-in settings point back at the host.
  await admin.goto('/timeclock/settings?tab=signin');
  await expect(admin.getByText('Sign-in is handled by the application Timeclock runs in.')).toBeVisible();

  // Embedded, an admin is the host's to grant, and the badge names it.
  await admin.goto('/timeclock/people');
  await admin.getByRole('button', { name: 'Admin', exact: true }).first().hover();
  await expect(admin.locator('#global-tooltip')).toContainText(
    'An admin in Example Portal: only Example Portal can change that.',
  );
});

test('each of the host’s organizations is a workspace of its own', async ({ browser }) => {
  const north = await as(browser, 'admin@host.test', workspaceKey('north'));
  const south = await as(browser, 'admin@host.test', workspaceKey('south'));
  await api(north, 'post', '/projects', { name: 'Northern only', billable: false });

  await north.goto('/timeclock/projects');
  await expect(north.getByText('Northern only')).toBeVisible();
  await south.goto('/timeclock/projects');
  await expect(south.getByRole('cell', { name: 'Internal', exact: true })).toBeVisible();
  await expect(south.getByText('Northern only')).toHaveCount(0);
  expect((await api(south, 'get', '/projects')).projects).toEqual([]);
});

test('it wears the host’s colors, until the workspace chooses its own', async ({ browser }) => {
  const page = await as(browser, 'admin@host.test', workspaceKey('look'));
  await page.goto('/timeclock/');
  // The host's sidebar and page backgrounds, in light and in dark.
  await expect.poll(() => ground(page)).toBe('rgb(243, 239, 228)');
  expect(await sheet(page)).toBe('rgb(255, 253, 248)');
  // The current section wears the host's sidebar accent.
  expect(
    await page.locator('.shell-side nav a[aria-current="page"] svg').evaluate((el) => getComputedStyle(el).color),
  ).toBe('rgb(15, 118, 110)');
  await page.goto('/timeclock/settings?tab=appearance');
  const preference = page.getByRole('group', { name: 'Color theme' });
  await preference.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect.poll(() => sheet(page)).toBe('rgb(16, 32, 29)');
  await preference.getByRole('button', { name: 'Light', exact: true }).click();

  await page.goto('/timeclock/settings?tab=appearance');
  await page.getByRole('button', { name: 'Navy' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('The workspace’s look is saved.')).toBeVisible();
  await page.reload();
  await expect.poll(() => ground(page)).toBe('rgb(6, 53, 79)');

  // Another organization still has the host's.
  const other = await as(browser, 'ada@host.test', workspaceKey('plain'));
  await other.goto('/timeclock/');
  await expect.poll(() => ground(other)).toBe('rgb(243, 239, 228)');
});
