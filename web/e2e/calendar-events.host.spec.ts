import { type Browser, expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { workspaceKey } from './accounts';

// The host reads its people's Google Calendars (examples/host, against the
// fake in e2e/google.mjs), so each person's week shows their meetings beside
// their time, to add from.

async function as(browser: Browser, email: string, org: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'X-Example-User': email, 'X-Example-Org': org },
    colorScheme: 'light',
  });
  return context.newPage();
}

const api = async (page: Page, method: 'get' | 'post', path: string, data?: unknown) => {
  const res = await page.request[method](`/timeclock/api/v1${path}`, data === undefined ? undefined : { data });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
};

test('calendar events sit beside the week’s time, and add it or start the clock', async ({ browser }) => {
  const org = workspaceKey('calendar');
  const admin = await as(browser, 'admin@host.test', org);
  await api(admin, 'post', '/projects', { name: 'Fieldwork', billable: false });
  const ada = await as(browser, 'ada@host.test', org);
  const { settings } = await api(ada, 'get', '/me');
  // Last week, so every meeting has passed and can be added.
  const monday = DateTime.now().setZone(settings.timezone).minus({ weeks: 1 }).startOf('week');
  await ada.goto(`/timeclock/?day=${monday.toISODate()}`);

  const event = (name: string) => ada.getByRole('button', { name: new RegExp(`^${name}, .*, on your calendar$`) });
  await expect(event('Customer call')).toHaveAccessibleName('Customer call, 9:30 AM – 10:00 AM, on your calendar');
  await expect(event('Daily standup')).toHaveCount(5);
  // Neither an all-day event nor one Ada declined is time she worked.
  await expect(event('Team offsite')).toHaveCount(0);
  await expect(event('Declined sync')).toHaveCount(0);

  await event('Sprint planning').click();
  const popover = ada.getByRole('dialog', { name: 'Calendar event' });
  await expect(popover.getByRole('heading', { name: 'Sprint planning' })).toBeVisible();
  await expect(popover.getByText('ada@host.test (Google Calendar)')).toBeVisible();
  await expect(popover.getByRole('link', { name: 'Open in Google Calendar' })).toHaveAttribute(
    'href',
    /^https:\/\/calendar\.google\.com\//,
  );

  // Adding opens the entry, filled in from the event.
  await popover.getByRole('button', { name: 'Add as time' }).click();
  const entry = ada.getByRole('dialog', { name: 'Add time' });
  await expect(entry.getByRole('textbox', { name: 'Note' })).toHaveValue('Sprint planning');
  await expect(entry.getByLabel('Start', { exact: true })).toHaveValue('13:00');
  await expect(entry.getByLabel('End', { exact: true })).toHaveValue('14:00');
  await entry.getByRole('button', { name: /^Project/ }).click();
  await ada.getByRole('option', { name: 'Fieldwork' }).click();
  await entry.getByRole('button', { name: 'Save' }).click();
  await expect(entry).toBeHidden();
  const { entries } = await api(
    ada,
    'get',
    `/entries?from=${monday.toISODate()}&to=${monday.plus({ days: 6 }).toISODate()}`,
  );
  expect(entries.map((e: { note: string; startedAt: string }) => [e.note, Date.parse(e.startedAt)])).toEqual([
    ['Sprint planning', monday.set({ hour: 13 }).toMillis()],
  ]);

  // Starting the clock on an event takes its title.
  await event('Design review').click();
  await popover.getByRole('button', { name: 'Start the clock on this' }).click();
  await expect(ada.getByRole('form', { name: 'Clock' }).getByRole('timer')).toBeVisible();
  await expect(ada.getByRole('textbox', { name: 'What you are working on' })).toHaveValue('Design review');
});

test('a week someone else opens shows none of their calendar', async ({ browser }) => {
  const org = workspaceKey('calendar-others');
  const admin = await as(browser, 'admin@host.test', org);
  const ada = await as(browser, 'ada@host.test', org);
  const me = await api(ada, 'get', '/me');
  const monday = DateTime.now().setZone(me.settings.timezone).minus({ weeks: 1 }).startOf('week');
  await admin.goto(`/timeclock/?day=${monday.toISODate()}`);
  await expect(admin.getByRole('button', { name: /^Customer call, / })).toBeVisible();
  await admin.goto(`/timeclock/?day=${monday.toISODate()}&person=${me.person.id}`);
  await expect(admin.getByRole('heading', { name: /ada/ })).toBeVisible();
  await expect(admin.getByRole('button', { name: /on your calendar$/ })).toHaveCount(0);
});
