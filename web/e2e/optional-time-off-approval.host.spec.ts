import { type Browser, expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { workspaceKey } from './accounts';

// Whether time off needs approval is the workspace's, and other tests rely on
// it being needed, so this runs in a host organization of its own.

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

test('time off that needs no approval has no status, and a manager may still approve it', async ({ browser }) => {
  const org = workspaceKey('optional');
  const admin = await as(browser, 'admin@host.test', org);
  const ada = await as(browser, 'ada@host.test', org);
  const boss = await as(browser, 'boss@host.test', org);
  const bossPerson = (await api(boss, 'get', '/me')).person;
  const me = (await api(ada, 'get', '/me')).person;
  await api(admin, 'put', `/people/${me.id}`, {
    timezone: me.timezone,
    managerId: bossPerson.id,
    overtimeExempt: false,
    payrollId: '',
    active: true,
  });
  const { settings } = await api(admin, 'get', '/me');
  await api(admin, 'put', '/settings', { ...settings, approveTimeOff: false });
  const monday = DateTime.now().setZone(settings.timezone).startOf('week').plus({ weeks: 1 });
  const day = (n: number) => monday.plus({ days: n }).toISODate() as string;

  // Recorded, it counts at once and says nothing about approval.
  await ada.goto('/timeclock/time-off');
  await ada.getByLabel('First day').fill(day(0));
  await ada.getByLabel('Last day').fill(day(1));
  await ada.getByRole('button', { name: 'Record time off' }).click();
  await expect(ada.getByRole('main')).toContainText('2 days (16 h) recorded. No approval is needed.');
  const upcoming = ada.locator('section', { has: ada.getByRole('heading', { name: 'Upcoming' }) });
  await expect(upcoming.getByRole('listitem').first()).toContainText('Vacation');
  await expect(upcoming).not.toContainText(/Approved|Pending/);
  expect(await api(ada, 'get', `/timesheet?day=${day(0)}`)).toMatchObject({ vacation: 16, pendingTimeOff: 0 });

  // Her manager finds it on Team, to approve only: nothing waits on it.
  await boss.goto('/timeclock/team');
  await expect(boss.getByRole('heading', { name: 'Waiting for you' })).toHaveCount(0);
  const recorded = boss.locator('section', { has: boss.getByRole('heading', { name: 'Recorded without approval' }) });
  await expect(recorded.getByRole('button', { name: /^Reject/ })).toHaveCount(0);
  await recorded.getByRole('button', { name: /^Approve ada’s Vacation on / }).click();
  const confirm = boss.getByRole('dialog', { name: 'Approve ada’s time off?' });
  await expect(confirm).toContainText('It needed no approval and already counts');
  await confirm.getByRole('button', { name: 'Approve all 2 days' }).click();
  await expect(recorded).toContainText('Nothing recorded in the last month or coming up that you haven’t approved.');

  // Approved, it names who approved it, and pay is as it was.
  await ada.reload();
  await expect(upcoming.getByRole('listitem').first()).toContainText('Approved by boss');
  expect(await api(ada, 'get', `/timesheet?day=${day(0)}`)).toMatchObject({ vacation: 16, pendingTimeOff: 0 });
  // It can't be rejected now it has counted.
  const [first] = (await api(ada, 'get', `/time-off?from=${day(0)}&to=${day(0)}`)).timeOff;
  const refused = await boss.request.post(`/timeclock/api/v1/time-off/${first.id}/decision`, {
    data: { approve: false, note: 'no' },
  });
  expect(refused.status()).toBe(409);
});
