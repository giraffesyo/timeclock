import { expect, lastWeek, test } from './fixtures';

test('the overview adds up a team’s week by day and project, and shows who is on the clock', async ({
  me,
  someone,
  manages,
}) => {
  const ada = await someone('ada');
  const bob = await someone('bob');
  await manages(me, ada, bob);
  const week = lastWeek();
  await ada.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '15:00'));
  await ada.api.entry('Meetings', week.at(0, '10:00'), week.at(0, '11:00'));
  await bob.api.entry('Acme / Support', week.at(2, '09:00'), week.at(2, '12:30'));
  await bob.api.clockInAgo('Acme / Support', 20, 'Ticket 7');

  const { page } = me;
  await page.goto(`/overview?day=${week.day(0)}`);
  const projects = page
    .getByRole('region', { name: 'Projects' })
    .or(page.locator('section').filter({ hasText: /^Projects/ }));
  await expect(projects.getByRole('listitem').filter({ hasText: 'Acme / Platform' })).toContainText('6.00');
  await expect(projects.getByRole('listitem').filter({ hasText: 'Acme / Support' })).toContainText('3.50');
  await expect(projects.getByRole('listitem').filter({ hasText: 'Meetings' })).toContainText('1.00');
  // Every project shows all the time recorded on it, overlap included.
  await expect(page.locator('section').filter({ hasText: /^Hours by day/ })).toContainText('10.50 h');
  await expect(page.getByText(/^Monday, .+: 7\.00 hours$/)).toBeAttached();
  // Hovering a day's bar says what each part of it is.
  const monday = page.locator('[data-day]').first();
  await monday.locator('.project-fill').first().hover();
  const tip = page.locator('#day-chart');
  await expect(tip).toContainText(/Monday, .+7\.00 h/);
  await expect(tip).toContainText('Acme / Platform6.00 h');
  await expect(tip).toContainText('Meetings1.00 h');

  // Only the manager's own time.
  await page.getByRole('button', { name: 'Mine' }).click();
  await expect(page.getByText('Nothing recorded this week.')).toBeVisible();

  // This week: who is tracking now.
  await page.goto('/overview');
  const tracking = page.locator('section').filter({ hasText: /^On the clock/ });
  await expect(tracking).toContainText('1 of 3 tracking');
  const bobRow = tracking.getByRole('listitem').filter({ hasText: bob.name });
  await expect(bobRow).toContainText('Ticket 7');
  await expect(bobRow.getByRole('timer')).toHaveText(/^0:2\d:\d\d$/);
  await expect(tracking.getByRole('listitem').filter({ hasText: ada.name })).toContainText('Not tracking');
});

test('someone with no reports sees only their own week', async ({ me }) => {
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '11:00'));
  await me.page.goto(`/overview?day=${week.day(0)}`);
  await expect(me.page.getByRole('main')).toContainText('What you recorded this week.');
  await expect(me.page.getByRole('main')).toContainText('2.00 h');
  await expect(me.page.getByRole('button', { name: 'Mine' })).toHaveCount(0);
  await expect(me.page.getByText('On the clock')).toHaveCount(0);
});
