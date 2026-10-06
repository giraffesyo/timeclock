import { column, expect, lastWeek, test } from './fixtures';

test('a timesheet is submitted, locks its time, and the manager approves it for payroll', async ({
  me,
  someone,
  manages,
  admin,
}) => {
  const boss = await someone('boss');
  await manages(boss, me);
  const week = lastWeek();
  const entry = await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '17:00'), 'Build');

  // Submit.
  await me.page.goto(`/timesheet?day=${week.day(1)}`);
  await me.page.getByRole('button', { name: 'Submit timesheet' }).click();
  await me.page.getByRole('dialog', { name: 'Submit this timesheet?' }).getByRole('button', { name: 'Submit' }).click();
  await expect(me.page.getByRole('main')).toContainText('Waiting for approval');

  // Its time can no longer change: not through the API, and not in the calendar.
  const refused = await me.api.try('put', `/entries/${entry.id}`, {
    projectId: entry.projectId,
    startedAt: week.at(1, '10:00'),
    endedAt: week.at(1, '17:00'),
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe('period_locked');
  await me.page.goto(`/?day=${week.day(1)}`);
  await expect(column(me.page, 1).getByRole('img', { name: /in a submitted timesheet$/ })).toBeVisible();
  await expect(column(me.page, 1).getByRole('slider')).toHaveCount(0);

  // Not ready for payroll until it is approved.
  expect(await admin.text(`/reports/payroll.csv?day=${week.day(1)}`)).not.toContain(me.name);

  // The manager approves it.
  await boss.page.goto(`/team?day=${week.day(1)}`);
  const row = boss.page.getByRole('row').filter({ hasText: me.name });
  await row.getByRole('button', { name: 'Approve' }).click();
  await boss.page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Approved');

  await me.page.goto(`/timesheet?day=${week.day(1)}`);
  await expect(me.page.getByRole('main')).toContainText(/Approved by boss/);
  const csv = await admin.text(`/reports/payroll.csv?day=${week.day(1)}`);
  expect(csv.split('\n').find((line) => line.includes(me.name))).toContain('8.00');
});

test('a timesheet sent back can be corrected and submitted again', async ({ me, someone, manages }) => {
  const boss = await someone('boss');
  await manages(boss, me);
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '17:00'));
  await me.api.post('/timesheet/submit', { day: week.day(1) });

  await boss.page.goto(`/team?day=${week.day(1)}`);
  await boss.page.getByRole('row').filter({ hasText: me.name }).getByRole('button', { name: 'Send back' }).click();
  const dialog = boss.page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Tuesday looks short');
  await dialog.getByRole('button', { name: 'Send back' }).click();
  await expect(dialog).toBeHidden();

  await me.page.goto(`/timesheet?day=${week.day(1)}`);
  await expect(me.page.getByRole('main')).toContainText('Tuesday looks short');
  await expect(me.page.getByRole('button', { name: 'Submit timesheet' })).toBeVisible();
});

test('nobody approves their own timesheet', async ({ me, someone, manages }) => {
  const report = await someone('rae');
  await manages(me, report);
  const week = lastWeek();
  await me.api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '17:00'));
  const sheet = await me.api.post('/timesheet/submit', { day: week.day(1) });

  const refused = await me.api.try('post', `/timesheets/${sheet.timesheet.id}/decision`, { approve: true });
  expect(refused.status()).toBe(403);
  await me.page.goto(`/team?day=${week.day(1)}`);
  const own = me.page.getByRole('row').filter({ hasText: me.name });
  await expect(own).toContainText('Yours: your manager or an admin decides it.');
  await expect(own.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('time off is requested, approved, and counted on the timesheet', async ({ me, someone, manages }) => {
  const boss = await someone('boss');
  await manages(boss, me);
  const week = lastWeek();

  await me.page.goto('/time-off');
  await me.page.getByLabel('First day').fill(week.day(3));
  await me.page.getByLabel('Last day').fill(week.day(4));
  await me.page.getByRole('button', { name: 'Request time off' }).click();
  await expect(me.page.getByRole('main')).toContainText('2 days (16 h) requested');

  // Pending hours aren't paid yet.
  expect((await me.api.get(`/timesheet?day=${week.day(3)}`)).vacation).toBe(0);

  await boss.page.goto('/team');
  await boss.page.getByRole('button', { name: /^Approve .+ vacation on /i }).click();
  await boss.page
    .getByRole('dialog')
    .getByRole('button', { name: /^Approve/ })
    .click();
  await expect(boss.page.getByText('No time off is waiting for your decision.')).toBeVisible();
  expect((await me.api.get(`/timesheet?day=${week.day(3)}`)).vacation).toBe(16);
});

test('everyone gets personal Settings, and only approvers get Team', async ({ me, adminPerson }) => {
  await me.page.goto('/');
  const nav = me.page.getByRole('navigation', { name: 'Sections' });
  await expect(nav.getByRole('link', { name: 'Timer' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Team' })).toHaveCount(0);
  await me.page.getByRole('button', { name: /: user menu$/ }).click();
  await me.page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    me.page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'Payroll' }),
  ).toHaveCount(0);
  const refused = await me.api.try('post', '/customers', { name: 'Not mine to add' });
  expect(refused.status()).toBe(403);

  const admin = await adminPerson();
  await admin.page.goto('/');
  const adminNav = admin.page.getByRole('navigation', { name: 'Sections' });
  await admin.page.getByRole('button', { name: /: user menu$/ }).click();
  await expect(admin.page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(adminNav.getByRole('link', { name: 'Team' })).toBeVisible();
  await admin.page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    admin.page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'Payroll' }),
  ).toBeVisible();
});
