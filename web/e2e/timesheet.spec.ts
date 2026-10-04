import { expect, lastWeek, test } from './fixtures';

test('a timesheet day opens to its time, drawn by the hour', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '11:30'), 'Build');
  await api.entry('Meetings', week.at(1, '10:00'), week.at(1, '10:30'), 'Standup');
  await page.goto(`/timesheet?day=${week.day(1)}`);

  // A pay period can hold the same weekday twice, so the day is found by its date.
  const day = page.locator(`button[aria-controls="day-${week.day(1)}"]`);
  await expect(day).toHaveAccessibleName(/^Show time for Tuesday/);
  await expect(day).toHaveAttribute('aria-expanded', 'false');
  await day.click();
  await expect(day).toHaveAccessibleName(/^Hide time for Tuesday/);
  await expect(day).toHaveAttribute('aria-expanded', 'true');

  // Both stretches are on the ruler, and listed under it; the overlap counts once.
  const row = page.locator(`#day-${week.day(1)}`);
  await expect(row.locator('[data-entry]')).toHaveCount(2);
  await expect(
    row.getByRole('button', { name: /^Edit Build, Acme \/ Platform, 9:00 AM – 11:30 AM, 2h 30m$/ }),
  ).toBeVisible();
  await expect(row.getByRole('button', { name: 'Edit time' })).toHaveCount(2);
  expect((await api.get(`/timesheet?day=${week.day(1)}`)).regular).toBe(2.5);

  // A block opens the entry to change it.
  await row.getByRole('button', { name: /^Edit Standup, Meetings/ }).click();
  const edit = page.getByRole('dialog', { name: 'Edit time' });
  await expect(edit.locator('input[type=time]').first()).toHaveValue('10:00');
  await edit.getByRole('button', { name: 'Cancel' }).click();

  // Submitted, the day's time is shown but no longer changes.
  await api.post('/timesheet/submit', { day: week.day(1) });
  await page.reload();
  await day.click();
  await expect(page.getByRole('img', { name: /^Build, Acme \/ Platform.*in a submitted timesheet$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
});
