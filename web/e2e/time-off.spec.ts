import { DateTime } from 'luxon';
import { ZONE } from '../playwright.config';
import { expect, test } from './fixtures';

test('past time off is shown a calendar year at a time, with its hours by kind', async ({ me }) => {
  const now = DateTime.now().setZone(ZONE);
  test.skip(now.ordinal < 10, 'this year needs some days behind it');
  const year = now.year;
  const off = (from: string, to: string, kind: 'vacation' | 'sick', hours = 8) =>
    me.api.post('/time-off', { from, to, hours, kind, weekends: true });
  await off(`${year - 1}-03-02`, `${year - 1}-03-02`, 'sick');
  await off(`${year - 1}-12-22`, `${year - 1}-12-23`, 'vacation');
  await off(`${year}-01-05`, `${year}-01-07`, 'vacation');
  await off(`${year}-01-08`, `${year}-01-08`, 'sick', 4);
  const ahead = now.plus({ days: 20 }).toISODate() as string;
  await off(ahead, ahead, 'vacation');

  await me.page.goto('/time-off');
  const main = me.page.getByRole('main');
  const upcoming = main.locator('section', { has: me.page.getByRole('heading', { name: 'Upcoming' }) });
  const past = main.locator('section', { has: me.page.getByRole('heading', { name: `${year} so far` }) });

  // This year: only its own days, totalled by kind; the planned day is upcoming.
  await expect(upcoming.getByRole('listitem')).toHaveCount(1);
  await expect(past.locator('dl')).toHaveText(`Sick4.00 hVacation24.00 h`);
  await expect(past.getByText('Dec 22')).toHaveCount(0);

  // A year back: last December and March, and nothing from this year.
  await past.getByRole('button', { name: 'Previous year' }).click();
  await expect(me.page).toHaveURL(new RegExp(`year=${year - 1}`));
  const last = main.locator('section', { has: me.page.getByRole('heading', { name: String(year - 1), exact: true }) });
  await expect(last.locator('dl')).toHaveText(`Sick8.00 hVacation16.00 h`);

  // Two back has none; This year comes straight back.
  await last.getByRole('button', { name: 'Previous year' }).click();
  await expect(main).toContainText(`No time off in ${year - 2}.`);
  await main.getByRole('button', { name: 'This year' }).click();
  await expect(main.getByRole('heading', { name: `${year} so far` })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Next year' })).toBeDisabled();
});
