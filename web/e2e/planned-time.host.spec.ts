import { type Browser, expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { workspaceKey } from './accounts';

// Planned time is a workspace setting, and every other test relies on the
// future being closed, so this runs in a host organization of its own.

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

test('planned time is closed until an admin allows it, then shows as planned and counts once it passes', async ({
  browser,
}) => {
  const org = workspaceKey('planned');
  const admin = await as(browser, 'admin@host.test', org);
  const project = await api(admin, 'post', '/projects', { name: 'Fieldwork', billable: false });
  const ada = await as(browser, 'ada@host.test', org);
  const { settings } = await api(ada, 'get', '/me');
  const zone: string = settings.timezone;
  // A shift next week: wholly ahead, whatever the time now.
  const shift = DateTime.now().setZone(zone).plus({ days: 7 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const entry = (start: DateTime, end: DateTime) => ({
    projectId: project.id,
    note: 'Planned shift',
    startedAt: start.toUTC().toISO(),
    endedAt: end.toUTC().toISO(),
  });

  // Off: the server refuses it, and the week ahead stays closed.
  const refused = await ada.request.post('/timeclock/api/v1/entries', { data: entry(shift, shift.plus({ hours: 2 })) });
  expect(refused.status()).toBe(422);
  await ada.goto('/timeclock/');
  await expect(ada.getByRole('button', { name: 'Next week' })).toBeDisabled();

  // An admin allows it in Settings.
  await admin.goto('/timeclock/settings');
  const toggle = admin.getByRole('switch', { name: 'Allow planned time' });
  await expect(admin.getByText('Off: time can be recorded up to now, not ahead.')).toBeVisible();
  await toggle.click();
  await expect(admin.getByText(/counts toward hours, overtime and payroll only as it passes/)).toBeVisible();
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await api(admin, 'get', '/me')).settings.allowPlannedTime).toBe(true);

  // Now it's accepted, up to a year out and no further.
  await api(ada, 'post', '/entries', entry(shift, shift.plus({ hours: 2 })));
  const far = DateTime.now().setZone(zone).plus({ days: 400 });
  const tooFar = await ada.request.post('/timeclock/api/v1/entries', { data: entry(far, far.plus({ hours: 1 })) });
  expect(tooFar.status()).toBe(422);

  // The week ahead opens, and the shift shows as planned, not as worked.
  await ada.goto('/timeclock/');
  await ada.getByRole('button', { name: 'Next week' }).click();
  await expect(ada).toHaveURL(/day=/);
  const block = ada.locator('.tl-planned');
  await expect(block).toHaveCount(1);
  await expect(block.getByRole('button')).toHaveAccessibleName(/^Edit Planned: Planned shift, Fieldwork/);
  await expect(ada.locator('.wk-future')).toHaveCount(0);
  await expect(ada.getByRole('group', { name: /, and 2h 0m planned$/ })).toBeVisible();
  await expect(ada.getByText('+2h 0m planned')).toBeVisible();
  // Worked time doesn't include it.
  await expect(ada.getByText('Week total').locator('..')).toContainText('0h 0m');

  // The list says so, and why.
  await ada.getByRole('button', { name: 'List' }).click();
  const badge = ada.getByRole('button', { name: 'Planned', exact: true });
  await expect(badge).toHaveAccessibleDescription(/^Hasn’t happened yet/);
  // One tooltip serves the page: let any other close before hovering the badge.
  await ada.mouse.move(0, 0);
  await expect(ada.locator('#global-tooltip')).toBeHidden();
  await badge.hover();
  await expect(ada.locator('#global-tooltip')).toContainText('Hasn’t happened yet');

  // The timesheet can look ahead too, where the shift's period is.
  await ada.goto('/timeclock/timesheet');
  await expect(ada.getByRole('button', { name: 'Next pay period' })).toBeEnabled();
});
