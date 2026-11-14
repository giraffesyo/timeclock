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
  await edit.getByRole('button', { name: 'Close entry' }).click();

  // Submitted, the day's time is shown but no longer changes.
  await api.post('/timesheet/submit', { day: week.day(1) });
  await page.reload();
  await day.click();
  await expect(page.getByRole('img', { name: /^Build, Acme \/ Platform.*in a submitted timesheet$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
});

test('time that runs past midnight is in both days it is on', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(1, '22:00'), week.at(2, '02:00'), 'Overnight');
  await page.goto(`/timesheet?day=${week.day(1)}`);
  for (const [weekday, range] of [
    [1, '10:00 PM – 12:00 AM'],
    [2, '12:00 AM – 2:00 AM'],
  ] as const) {
    const day = page.locator(`button[aria-controls="day-${week.day(weekday)}"]`);
    await expect(day).toContainText('1 entry');
    await day.click();
    // The hours the day is paid for are the ones drawn and listed under it.
    const row = page.locator(`#day-${week.day(weekday)}`);
    await expect(
      row.getByRole('button', { name: `Edit Overnight, Acme / Platform, ${range}, 2h 0m`, exact: true }),
    ).toBeVisible();
    await expect(row.getByRole('listitem')).toContainText(`${range}Overnight`);
    await expect(row.getByRole('listitem')).toContainText('2h 0m');
  }
  const sheet = await api.get(`/timesheet?day=${week.day(1)}`);
  const hours = (weekday: number) => sheet.days.find((d: { day: string }) => d.day === week.day(weekday)).regular;
  expect([hours(1), hours(2)]).toEqual([2, 2]);
});
