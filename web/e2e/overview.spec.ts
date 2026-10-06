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
  // Only running clocks are listed; the count still says how many could be.
  await expect(tracking.getByRole('listitem')).toHaveCount(1);
  await expect(tracking.getByRole('listitem').filter({ hasText: ada.name })).toHaveCount(0);
  // A name opens the person's profile card.
  await tracking.getByRole('button', { name: bob.name }).hover();
  await expect(page.getByText(bob.email)).toBeVisible();

  // It is about now, so another week doesn't show it.
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.getByText('On the clock')).toHaveCount(0);
});

test('with no clock running, On the clock says so instead of listing everyone', async ({ me, someone, manages }) => {
  const ada = await someone('ada');
  await manages(me, ada);
  await me.page.goto('/overview');
  const tracking = me.page.locator('section').filter({ hasText: /^On the clock/ });
  await expect(tracking).toContainText('0 of 2 tracking');
  await expect(tracking).toContainText('No one is on the clock right now.');
  await expect(tracking.getByRole('listitem')).toHaveCount(0);
});

test('hovering a part of a bar picks out its project, in the bars and the tooltip', async ({
  me,
  someone,
  manages,
}) => {
  const ada = await someone('ada');
  await manages(me, ada);
  const week = lastWeek();
  await ada.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '15:00'));
  await ada.api.entry('Meetings', week.at(0, '15:00'), week.at(0, '16:00'));
  await ada.api.entry('Meetings', week.at(1, '09:00'), week.at(1, '10:00'));
  const { page } = me;
  await page.goto(`/overview?day=${week.day(0)}`);
  const meetings = await ada.api.project('Meetings');
  const platform = await ada.api.project('Acme / Platform');
  const slice = (day: number, project: string) =>
    page.locator('[data-day]').nth(day).locator(`[data-project="${project}"]`);
  const opacity = (day: number, project: string) =>
    slice(day, project).evaluate((el) => Number(getComputedStyle(el).opacity));

  await slice(0, meetings).hover();
  await expect(slice(0, meetings)).toHaveAttribute('data-highlighted', 'true');
  // The same project stands out on every day; the others step back.
  await expect(slice(1, meetings)).toHaveAttribute('data-highlighted', 'true');
  await expect.poll(() => opacity(0, platform)).toBeLessThan(0.5);
  expect(await opacity(0, meetings)).toBe(1);
  const tip = page.locator('#day-chart');
  await expect(tip.locator('li[data-highlighted]')).toHaveCount(1);
  await expect(tip.locator('li[data-highlighted]')).toContainText('Meetings');

  // Moving to another part moves the highlight with it.
  await slice(0, platform).hover();
  await expect(tip.locator('li[data-highlighted]')).toContainText('Acme / Platform');
  await expect(slice(1, meetings)).not.toHaveAttribute('data-highlighted');

  // Leaving the chart puts every part back.
  await page.getByRole('heading', { name: 'Overview' }).hover();
  await expect.poll(() => opacity(0, platform)).toBe(1);
});

test('the chart fills its panel, and long project lists fold', async ({ me, someone, manages, admin }) => {
  const ada = await someone('ada');
  await manages(me, ada);
  const week = lastWeek();
  // Ten projects of ada's own, an hour each.
  const customer = await admin.post('/customers', { name: `Fold ${Date.now().toString(36)}` });
  for (let i = 0; i < 10; i++) {
    const project = await admin.post('/projects', { name: `Part ${i}`, customerId: customer.id, billable: false });
    await ada.api.post('/entries', {
      projectId: project.id,
      startedAt: week.at(0, `${String(8 + i).padStart(2, '0')}:00`),
      endedAt: week.at(0, `${String(8 + i).padStart(2, '0')}:30`),
      note: '',
    });
  }
  const { page } = me;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/overview?day=${week.day(0)}`);
  const projects = page.locator('section').filter({ hasText: /^Projects/ });
  await expect(projects.getByRole('listitem')).toHaveCount(8);
  await projects.getByRole('button', { name: 'Show 2 more projects' }).click();
  await expect(projects.getByRole('listitem')).toHaveCount(10);
  // Side by side, the chart's panel is as tall as the projects', and the chart reaches its bottom.
  const chart = page.locator('section').filter({ hasText: /^Hours by day/ });
  const panel = await chart.boundingBox();
  const figure = await chart.locator('figure').boundingBox();
  if (!panel || !figure) throw new Error('no chart');
  expect(panel.y + panel.height - (figure.y + figure.height)).toBeLessThan(24);
  await projects.getByRole('button', { name: 'Show fewer' }).click();
  await expect(projects.getByRole('listitem')).toHaveCount(8);
});

test('leaving this week or period doesn’t move the navigation', async ({ me, someone, manages }) => {
  const ada = await someone('ada');
  await manages(me, ada);
  const { page } = me;
  for (const [path, previous, back] of [
    ['/', 'Previous week', 'This week'],
    ['/overview', 'Previous week', 'This week'],
    ['/team', 'Previous pay period', 'Current period'],
  ]) {
    await page.goto(path);
    const prev = page.getByRole('button', { name: previous });
    const backButton = page.getByRole('button', { name: back, exact: true });
    // On the current one, the way back is hidden but keeps its room.
    await expect(backButton).toHaveCount(0);
    const before = await prev.boundingBox();
    await prev.click();
    await expect(backButton).toBeVisible();
    const after = await prev.boundingBox();
    expect(after?.x).toBeCloseTo(before?.x ?? -1, 0);
    expect(after?.y).toBeCloseTo(before?.y ?? -1, 0);
    await backButton.click();
    await expect(backButton).toHaveCount(0);
    expect((await prev.boundingBox())?.x).toBeCloseTo(before?.x ?? -1, 0);
  }
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
