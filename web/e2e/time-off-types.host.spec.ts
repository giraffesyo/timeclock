import { type Browser, expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { workspaceKey } from './accounts';

// Time off types are the workspace's, and other tests rely on the ones every
// workspace starts with, so this runs in a host organization of its own.

async function as(browser: Browser, email: string, org: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'X-Example-User': email, 'X-Example-Org': org },
    colorScheme: 'light',
  });
  return context.newPage();
}

const api = async (page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown) => {
  const res = await page.request[method](`/timeclock/api/v1${path}`, data === undefined ? undefined : { data });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
};

test('an admin adds a Health day paid as sick time, people record it, and archiving it keeps its name', async ({
  browser,
}) => {
  const org = workspaceKey('types');
  const admin = await as(browser, 'admin@host.test', org);
  const ada = await as(browser, 'ada@host.test', org);
  const { settings } = await api(ada, 'get', '/me');
  const monday = DateTime.now().setZone(settings.timezone).startOf('week').minus({ weeks: 1 });
  const day = (n: number) => monday.plus({ days: n }).toISODate() as string;

  // A workspace starts with Vacation, paid as PTO, and Sick. The admin adds one paid as sick time.
  await admin.goto('/timeclock/settings');
  const panel = admin.locator('section', { has: admin.getByRole('heading', { name: 'Time off types' }) });
  await expect(panel.getByRole('listitem')).toHaveText([/^Vacation\s*Paid as PTO/, /^Sick\s*Paid as Sick/]);
  await panel.getByRole('button', { name: 'Add type' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Add a time off type' });
  await dialog.getByLabel('Name').fill('Health day');
  await dialog.getByRole('group', { name: 'Paid as' }).getByRole('button', { name: 'Sick' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Health day' })).toContainText('Paid as Sick');

  // Ada chooses it from the three the workspace offers.
  await ada.goto('/timeclock/time-off');
  await ada.getByLabel('Type').selectOption({ label: 'Health day' });
  await ada.getByLabel('First day').fill(day(1));
  await ada.getByLabel('Last day').fill(day(1));
  await ada.getByRole('button', { name: 'Request time off' }).click();
  await expect(ada.getByRole('main')).toContainText('1 day (8 h) requested');
  const [health] = (await api(ada, 'get', `/time-off?from=${day(1)}&to=${day(1)}`)).timeOff;
  expect(health).toMatchObject({ typeName: 'Health day', kind: 'sick', status: 'pending' });

  // Approved, payroll pays it as sick time.
  await api(admin, 'post', `/time-off/${health.id}/decision`, { approve: true });
  expect(await api(ada, 'get', `/timesheet?day=${day(1)}`)).toMatchObject({ sick: 8, vacation: 0 });

  // Once used, a type keeps how it's paid.
  await admin.reload();
  await panel.getByRole('button', { name: 'Edit Health day' }).click();
  const edit = admin.getByRole('dialog', { name: 'Edit Health day' });
  await expect(edit).toContainText('Time off of this type is recorded, so this can’t change.');
  await expect(edit.getByRole('group', { name: 'Paid as' })).toHaveCount(0);
  await edit.getByRole('button', { name: 'Cancel' }).click();

  // Archived, it isn't offered for new time off, and what was recorded keeps its name.
  await panel.getByRole('button', { name: 'Archive Health day' }).click();
  await expect(panel.getByRole('listitem').filter({ hasText: 'Health day' })).toContainText('Archived');
  await ada.reload();
  await expect(ada.getByRole('group', { name: 'Type' }).getByRole('button')).toHaveText(['Vacation', 'Sick']);
  const [kept] = (await api(ada, 'get', `/time-off?from=${day(1)}&to=${day(1)}`)).timeOff;
  expect(kept).toMatchObject({ typeName: 'Health day', kind: 'sick' });
});
