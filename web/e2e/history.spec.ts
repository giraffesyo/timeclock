import { DateTime } from 'luxon';
import { expect, lastWeek, test } from './fixtures';

/** A weekday as History names it, such as "Sep 29". */
const label = (iso: string) => DateTime.fromISO(iso).toFormat('LLL d');

test('the auditor pages back through History, and starts it from a day', async ({ me, auditorPerson }) => {
  const week = lastWeek();
  for (const day of [0, 1, 2, 3, 4]) {
    await me.api.entry('Acme / Platform', week.at(day, '09:00'), week.at(day, '10:00'), `Day ${day}`);
  }
  const { page } = await auditorPerson();
  // Two to a page, so five changes take three.
  await page.route('**/api/v1/audit?**', (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '2');
    return route.continue({ url: url.toString() });
  });
  await page.goto('/reports?tab=history');
  await page.getByRole('button', { name: 'Show changes to one person’s time' }).click();
  await page.getByRole('option', { name: me.name }).click();

  const rows = page.locator('tbody tr');
  const older = page.getByRole('button', { name: 'Older', exact: true });
  const newer = page.getByRole('button', { name: 'Newer', exact: true });
  await expect(rows).toHaveCount(2);
  await expect(page.getByText(/^Page 1: 2 changes/)).toBeVisible();
  await expect(newer).toBeDisabled();
  // Newest first: the last day's time leads.
  await expect(rows.first()).toContainText(label(week.day(4)));

  await older.click();
  await expect(page.getByText(/^Page 2: 2 changes/)).toBeVisible();
  await older.click();
  await expect(page.getByText(/^Page 3: 1 change/)).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(older).toBeDisabled();
  await expect(rows.first()).toContainText(label(week.day(0)));
  await page.screenshot({ path: '/tmp/timeclock-history-pages.png' });

  await newer.click();
  await expect(page.getByText(/^Page 2: 2 changes/)).toBeVisible();
  await page.getByRole('button', { name: 'Newest', exact: true }).click();
  await expect(page.getByText(/^Page 1: 2 changes/)).toBeVisible();

  // From the end of a day before any of it: nothing yet.
  await page.getByLabel('Changes up to the end of this day').fill('2001-01-01');
  await expect(page.getByText('No changes up to the end of Jan 1, 2001.')).toBeVisible();
});
