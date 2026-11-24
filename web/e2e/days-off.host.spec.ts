import { type Browser, expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { workspaceKey } from './accounts';

// Holidays and time off types are the workspace's, so this runs in a host
// organization of its own.

async function as(browser: Browser, email: string, org: string, mobile = false): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'X-Example-User': email, 'X-Example-Org': org },
    colorScheme: 'light',
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
  });
  return context.newPage();
}

const api = async (page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown) => {
  const res = await page.request[method](`/timeclock/api/v1${path}`, data === undefined ? undefined : { data });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
};

test('holidays and time off show on the week, with their hours under the date, and a day away is hatched', async ({
  browser,
}) => {
  const org = workspaceKey('days-off');
  const admin = await as(browser, 'admin@host.test', org);
  const ada = await as(browser, 'ada@host.test', org);
  const { settings } = await api(ada, 'get', '/me');
  const monday = DateTime.now().setZone(settings.timezone).startOf('week').minus({ weeks: 1 });
  const day = (n: number) => monday.plus({ days: n }).toISODate() as string;
  const dayList = (page: Page, n: number) =>
    page.getByRole('list', { name: `Days off on ${monday.plus({ days: n }).toFormat('cccc, LLLL d')}` });
  const head = (page: Page, n: number) =>
    page.getByRole('group', { name: new RegExp(`^${monday.plus({ days: n }).toFormat('cccc')}, `) });
  const approve = async (body: Record<string, unknown>) => {
    for (const t of (await api(ada, 'post', '/time-off', body)).timeOff) {
      await api(admin, 'post', `/time-off/${t.id}/decision`, { approve: true });
    }
  };

  // Tuesday a whole Health day, approved; Wednesday three hours worked and half a day sick;
  // Thursday half a day of vacation, waiting; Friday a holiday.
  const health = await api(admin, 'post', '/time-off-types', { name: 'Health day', paysAs: 'sick' });
  await approve({ typeId: health.id, from: day(1), to: day(1), hours: 8 });
  const project = await api(admin, 'post', '/projects', { name: 'Platform', billable: false });
  const wednesday = monday.plus({ days: 2 });
  await api(ada, 'post', '/entries', {
    projectId: project.id,
    startedAt: wednesday.set({ hour: 9 }).toUTC().toISO(),
    endedAt: wednesday.set({ hour: 12 }).toUTC().toISO(),
  });
  await approve({ kind: 'sick', from: day(2), to: day(2), hours: 4 });
  await api(ada, 'post', '/time-off', { kind: 'vacation', from: day(3), to: day(3), hours: 4 });
  await api(admin, 'post', '/holidays', { name: 'Founders Day', days: [{ day: day(4) }] });

  // Each is in the row under the days, by its type's name, with where it stands.
  await ada.goto(`/timeclock/?day=${day(1)}`);
  await expect(dayList(ada, 1).getByRole('listitem')).toHaveText(/Health day\s*8 h\s*Approved by admin/);
  await expect(dayList(ada, 3).getByRole('listitem')).toHaveText(/Vacation\s*4 h · Pending/);
  await expect(dayList(ada, 4).getByRole('listitem')).toHaveText(/Founders Day\s*Company holiday/);
  await expect(dayList(ada, 0).getByRole('listitem')).toHaveCount(0);
  // Under each date, hours off that count, apart from time worked: in place of it when none
  // was worked, below it when some was. Time off still waiting doesn't count yet.
  await expect(head(ada, 1)).toContainText('8h off');
  await expect(head(ada, 1)).not.toContainText('0h 0m');
  await expect(head(ada, 2)).toContainText('3h 0m');
  await expect(head(ada, 2)).toContainText('+4h off');
  await expect(head(ada, 3)).toContainText('0h 0m');
  await expect(head(ada, 3)).not.toContainText('off');
  await expect(head(ada, 4).locator('.wk-off-total-holiday')).toHaveText('8h off');
  // The day heads say so to a screen reader.
  await expect(head(ada, 1)).toHaveAccessibleName(/^Tuesday, .*: 0h 0m\. 8h off: Health day$/);
  await expect(head(ada, 3)).toHaveAccessibleName(/^Thursday, .*\. Off: Vacation$/);

  // A whole day away is hatched across its hours; half a day, or one still waiting, isn't.
  await expect(ada.locator('.wk-out')).toHaveCount(2);
  await expect(ada.locator('.wk-out-holiday')).toHaveCount(1);

  // A week with nothing off has no row.
  await ada.goto(`/timeclock/?day=${monday.minus({ weeks: 2 }).toISODate()}`);
  await expect(ada.getByText('Days off', { exact: true })).toHaveCount(0);

  // The list puts each beside its day, even with no time recorded on it.
  await ada.goto(`/timeclock/?day=${day(1)}&view=list`);
  const friday = ada.locator('section').filter({ hasText: 'Founders Day' });
  await expect(friday).toContainText(monday.plus({ days: 4 }).toFormat('cccc, LLL d'));
  await expect(ada.getByRole('list', { name: 'Days off' })).toHaveCount(4);

  // On a phone, one day at a time, with a mark on each day that has something off.
  const phone = await as(browser, 'ada@host.test', org, true);
  await phone.goto(`/timeclock/?day=${day(1)}`);
  await expect(phone.locator('.wk-off-mark-on')).toHaveCount(4);
  const tuesday = phone.getByRole('button', { name: /^Tuesday, .*8h off: Health day/ });
  await expect(tuesday).toContainText('8h off');
  await tuesday.click();
  await expect(dayList(phone, 1)).toContainText('Health day');
  await phone.getByRole('button', { name: /^Monday, / }).click();
  await expect(phone.getByText('Days off', { exact: true })).toHaveCount(0);
});
