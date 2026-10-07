import { type Browser, expect, type Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { SERVICES_URL } from '../playwright.config';
import { workspaceKey } from './accounts';

// The host reads the calendars of its own domain's people (examples/host);
// anyone else connects their own Google Calendar, through the fake Google in
// e2e/google.mjs, whose consent screen allows at once.

async function as(browser: Browser, email: string, org: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'X-Example-User': email, 'X-Example-Org': org },
    colorScheme: 'light',
  });
  return context.newPage();
}

const lastWeek = async (page: Page) => {
  const res = await page.request.get('/timeclock/api/v1/me');
  const { settings } = await res.json();
  return DateTime.now().setZone(settings.timezone).minus({ weeks: 1 }).startOf('week').toISODate();
};

const event = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}, .*, on your calendar$`) });

test('someone connects their own calendar from their week, sees it in settings, and disconnects it', async ({
  browser,
}) => {
  const org = workspaceKey('connect');
  const bea = await as(browser, 'bea@elsewhere.test', org);
  const monday = await lastWeek(bea);
  await bea.goto(`/timeclock/?day=${monday}`);

  // Not connected: no strip, and an offer to connect.
  await expect(bea.getByText('See your meetings beside your time')).toBeVisible();
  await expect(event(bea, 'Customer call')).toHaveCount(0);
  await bea.getByRole('link', { name: 'Connect Google Calendar' }).click();

  // Back on the same week, with the meetings beside it.
  await expect(bea).toHaveURL(new RegExp(`/timeclock/\\?day=${monday}$`));
  await expect(event(bea, 'Customer call')).toBeVisible();
  await expect(bea.getByText('See your meetings beside your time')).toHaveCount(0);

  await bea.getByRole('button', { name: /: user menu$/ }).click();
  await bea.getByRole('link', { name: 'Settings', exact: true }).click();
  await bea.getByRole('link', { name: 'Calendar' }).click();
  await expect(bea.getByText('Connected to bea@elsewhere.test.')).toBeVisible();
  await bea.getByRole('button', { name: 'Disconnect' }).click();
  await expect(bea.getByRole('link', { name: 'Connect Google Calendar' })).toBeVisible();
  // Timeclock gave its access back at Google too.
  const revoked = await (await bea.request.get(`${SERVICES_URL}/google/revoked?email=bea@elsewhere.test`)).json();
  expect(revoked.revoked).toBe(true);

  // Connecting again from settings comes back to settings.
  await bea.getByRole('link', { name: 'Connect Google Calendar' }).click();
  await expect(bea).toHaveURL(/\/timeclock\/settings\?tab=calendar$/);
  await expect(bea.getByText('Connected to bea@elsewhere.test.')).toBeVisible();
});

test('a calendar revoked at Google goes back to being offered', async ({ browser }) => {
  const org = workspaceKey('revoke');
  const cy = await as(browser, 'cy@elsewhere.test', org);
  const monday = await lastWeek(cy);
  await cy.goto(`/timeclock/?day=${monday}`);
  await cy.getByRole('link', { name: 'Connect Google Calendar' }).click();
  await expect(event(cy, 'Customer call')).toBeVisible();

  await cy.request.post(`${SERVICES_URL}/google/revoke`, { form: { token: 'refresh:cy@elsewhere.test' } });
  await cy.reload();
  await expect(cy.getByText('See your meetings beside your time')).toBeVisible();
  await expect(event(cy, 'Customer call')).toHaveCount(0);
});

test('refusing at Google says so in the calendar settings', async ({ browser }) => {
  const org = workspaceKey('deny');
  const page = await as(browser, 'deny@elsewhere.test', org);
  await page.goto('/timeclock/settings?tab=calendar');
  await page.getByRole('link', { name: 'Connect Google Calendar' }).click();
  await expect(page).toHaveURL(/\/timeclock\/settings\?tab=calendar&calendar=denied$/);
  await expect(page.getByRole('alert')).toHaveText('Your calendar wasn’t connected: Google wasn’t given access.');
});

test('someone whose calendar the host reads has nothing to connect', async ({ browser }) => {
  const org = workspaceKey('managed');
  const ada = await as(browser, 'ada@host.test', org);
  await ada.goto(`/timeclock/?day=${await lastWeek(ada)}`);
  await expect(event(ada, 'Customer call')).toBeVisible();
  await expect(ada.getByRole('link', { name: 'Connect Google Calendar' })).toHaveCount(0);
  await ada.goto('/timeclock/settings?tab=calendar');
  await expect(ada.getByText('Your organization connects your Google Calendar for you')).toBeVisible();
});
