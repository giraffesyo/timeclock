import { column, expect, lastWeek, test } from './fixtures';

const PACIFIC = 'America/Los_Angeles';

test('a browser in another zone is offered its own time, and times follow', async ({ someone }) => {
  const pat = await someone('pat', { timezoneId: PACIFIC });
  const week = lastWeek();
  await pat.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '10:00'));
  const { page } = pat;
  await page.goto(`/?view=list&day=${week.day(1)}`);

  await expect(
    page.getByText('This browser is in Los Angeles time, but your times are shown in Chicago time.'),
  ).toBeVisible();
  await expect(page.getByRole('listitem').first()).toContainText('9:00 AM – 10:00 AM');

  await page.getByRole('button', { name: 'Use Los Angeles time' }).click();
  await expect(page.getByRole('listitem').first()).toContainText('7:00 AM – 8:00 AM');
  await expect(page.getByText(/This browser is in/)).toHaveCount(0);
  expect((await pat.api.get('/me')).person.timezone).toBe(PACIFIC);

  await page.getByRole('button', { name: 'Calendar' }).click();
  await page.getByRole('button', { name: /: user menu$/ }).click();
  await expect(page.getByRole('button', { name: `Times are in ${PACIFIC}. Change your time zone` })).toContainText(
    'Los Angeles',
  );
});

test('keeping the organization’s zone is remembered', async ({ someone }) => {
  const pat = await someone('pat', { timezoneId: PACIFIC });
  await pat.page.goto('/');
  await pat.page.getByRole('button', { name: 'Keep Chicago time' }).click();
  await expect(pat.page.getByText(/This browser is in/)).toHaveCount(0);
  await pat.page.reload();
  await expect(pat.page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();
  await expect(pat.page.getByText(/This browser is in/)).toHaveCount(0);
  expect((await pat.api.get('/me')).person.timezone).toBe('');
});

test('a person’s day ends at their own midnight', async ({ someone }) => {
  const pat = await someone('pat', { timezoneId: PACIFIC });
  await pat.api.put('/me/timezone', { timezone: PACIFIC });
  const week = lastWeek(PACIFIC);
  // 9:00–11:30 PM Pacific on Thursday: already Friday in Chicago.
  await pat.api.entry('Acme / Platform', week.at(3, '21:00'), week.at(3, '23:30'));

  const sheet = await pat.api.get(`/timesheet?day=${week.day(3)}`);
  const hours = (day: string) => sheet.days.find((d: { day: string }) => d.day === day).regular;
  expect(hours(week.day(3))).toBe(2.5);
  expect(hours(week.day(4))).toBe(0);

  await pat.page.goto(`/?day=${week.day(3)}`);
  await expect(pat.page.getByRole('group', { name: /^Thursday/ })).toContainText('2h 30m');
  await expect(pat.page.getByRole('group', { name: /^Friday/ })).toContainText('0h 0m');
  await expect(column(pat.page, 3).locator('[data-entry]')).toHaveCount(1);
});

test('a time typed in the dialog is read in the person’s own zone', async ({ someone }) => {
  const pat = await someone('pat', { timezoneId: PACIFIC });
  await pat.api.put('/me/timezone', { timezone: PACIFIC });
  const week = lastWeek(PACIFIC);
  const { page } = pat;
  await page.goto(`/?view=list&day=${week.day(2)}`);
  await page.getByRole('button', { name: 'Add time' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add time' });
  await dialog.locator('input[type=date]').fill(week.day(2));
  await dialog.locator('input[type=time]').first().fill('09:00');
  await dialog.locator('input[type=time]').last().fill('10:15');
  await dialog.getByRole('button', { name: /^Project: / }).click();
  await page.getByRole('option', { name: 'Platform' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const { entries } = await pat.api.get(`/entries?from=${week.day(2)}&to=${week.day(2)}`);
  expect(Date.parse(entries[0].startedAt)).toBe(Date.parse(week.at(2, '09:00')));
  expect(Date.parse(entries[0].endedAt)).toBe(Date.parse(week.at(2, '10:15')));
});

test('a manager sees a report’s time in the report’s zone', async ({ me, someone, manages }) => {
  const pat = await someone('pat', { timezoneId: PACIFIC });
  await pat.api.put('/me/timezone', { timezone: PACIFIC });
  await manages(me, pat);
  const week = lastWeek(PACIFIC);
  await pat.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '10:00'), 'Standup');

  // The manager is in Chicago, where that was 11:00 AM.
  const { page } = me;
  await page.goto(`/timesheet?person=${pat.id}&day=${week.day(1)}`);
  const tuesday = new Date(`${week.day(1)}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  await page.getByRole('button', { name: `Show time for ${tuesday}` }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Standup' })).toContainText('9:00 AM – 10:00 AM');
});
