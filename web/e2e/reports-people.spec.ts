import { expect, lastWeek, test } from './fixtures';

const LONG = ['Rosalind Achterberg-Vance', 'Maximiliana Oyelaran-Whitcombe', 'Tomasz Ellery', 'Ines Halvorsen'];

test('the payroll table fits a desktop window without scrolling sideways', async ({ someone, adminPerson }) => {
  const week = lastWeek();
  const ids: string[] = [];
  for (const n of LONG) {
    const p = await someone(n.split(' ')[0].toLowerCase());
    ids.push(p.id);
    await p.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '17:00'));
  }
  const { page } = await adminPerson();
  // Real-length names, as a directory gives them.
  await page.route('**/api/v1/reports/payroll**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // Everyone in the report, including other tests' people, gets a real-length name.
    (body.rows ?? []).forEach((row: { person: { id: string; name: string } }, n: number) => {
      const i = ids.indexOf(row.person.id);
      row.person.name = LONG[i >= 0 ? i : n % LONG.length];
    });
    await route.fulfill({ response, json: body });
  });
  for (const width of [1180, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/reports?day=${week.day(0)}`);
    const scroller = page.locator('table').last().locator('..');
    await expect(scroller.getByText(LONG[1]).first()).toBeVisible();
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth), `at ${width}px`).toBe(0);
    // A name sits on the same line as the rest of its row.
    // A row with no note under the name ("Clock running"), which would sit the name above center.
    const row = page
      .getByRole('row')
      .filter({ hasText: LONG[0] })
      .filter({ hasNotText: /running|pending/i })
      .first();
    const name = await row.getByRole('button', { name: LONG[0] }).boundingBox();
    const hours = await row.getByRole('cell').nth(1).boundingBox();
    if (!name || !hours) throw new Error('no row');
    expect(Math.abs(name.y + name.height / 2 - (hours.y + hours.height / 2)), `at ${width}px`).toBeLessThan(3);
  }
  // On a phone the table scrolls instead, and names keep a readable width rather than a letter per line.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/reports?day=${week.day(0)}`);
  const name = page.getByRole('row').filter({ hasText: LONG[0] }).first().getByRole('button', { name: LONG[0] });
  const box = await name.boundingBox();
  if (!box) throw new Error('no name');
  expect(box.width).toBeGreaterThan(120);
  // At most three lines, as a long double-barrelled name takes; a letter per line runs to dozens.
  expect(box.height).toBeLessThan(64);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('people in payroll and exceptions open their profile, and the sheet opens from its status', async ({
  someone,
  adminPerson,
}) => {
  const week = lastWeek();
  const ada = await someone('ada');
  await ada.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '17:00'));
  await ada.api.post('/time-off', { from: week.day(3), to: week.day(3), hours: 8, kind: 'vacation' });
  const { page } = await adminPerson();

  await page.goto(`/reports?day=${week.day(0)}`);
  const row = page.getByRole('row').filter({ hasText: ada.name });
  await row.getByRole('button', { name: ada.name }).hover();
  await expect(page.getByText(ada.email)).toBeVisible();
  await page.mouse.move(0, 0);
  await row.getByRole('link', { name: `Open the timesheet of ${ada.name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/timesheet\\?.*person=${ada.id}`));

  await page.goto(`/reports?tab=exceptions&day=${week.day(0)}`);
  const group = page.locator('section').filter({ has: page.getByRole('button', { name: ada.name }) });
  await group.getByRole('button', { name: ada.name }).hover();
  await expect(page.getByText(ada.email)).toBeVisible();
});
