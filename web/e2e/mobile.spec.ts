import { expect, lastWeek, test } from './fixtures';

// A phone: one day at a time, and a finger instead of a mouse.

test('the week is a strip of days, and a tap on an empty hour adds time', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await page.goto(`/?day=${week.day(0)}`);

  const wednesday = page.getByRole('button', { name: /^Wednesday/ });
  await wednesday.tap();
  await expect(wednesday).toHaveAttribute('aria-pressed', 'true');

  // The day shows 7 AM to 7 PM: a tap a quarter of the way down is 10 AM.
  const track = page.locator('.tl-column .tl-track');
  await expect(track).toHaveCount(1);
  const box = await track.boundingBox();
  if (!box) throw new Error('no day shown');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.25);

  const dialog = page.getByRole('dialog', { name: 'Add time' });
  await expect(dialog.locator('input[type=date]')).toHaveValue(week.day(2));
  await expect(dialog.locator('input[type=time]').first()).toHaveValue('10:00');
  await expect(dialog.locator('input[type=time]').last()).toHaveValue('11:00');
  await dialog.getByRole('button', { name: /^Project: / }).tap();
  await page.getByRole('option', { name: 'Support' }).tap();
  await dialog.getByRole('button', { name: 'Save' }).tap();
  await expect(dialog).toBeHidden();
  await expect(wednesday).toContainText('1h 0m');
  expect((await api.get(`/entries?from=${week.day(2)}&to=${week.day(2)}`)).entries).toHaveLength(1);
});

test('a tap on a block opens it', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '12:00'), 'Build');
  await page.goto(`/?day=${week.day(0)}`);
  await page.getByRole('button', { name: /^Edit Build/ }).tap();
  await expect(page.getByRole('dialog', { name: 'Edit time' })).toBeVisible();
  // The tap is the block's alone: it doesn't also start a new stretch under it.
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('[data-draft]')).toHaveCount(0);
});

test('the clock starts and stops', async ({ me }) => {
  const { page } = me;
  await page.goto('/');
  await page
    .getByRole('main')
    .getByRole('button', { name: /^Project: / })
    .tap();
  await page.getByRole('option', { name: 'Platform' }).tap();
  await page.getByRole('button', { name: 'Start the clock', exact: true }).tap();
  await expect(page.getByRole('main').getByRole('timer')).toBeVisible();
  await page.getByRole('button', { name: 'Stop the clock' }).tap();
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();
});

for (const path of ['/', '/?view=list', '/overview', '/timesheet', '/time-off', '/reports']) {
  test(`${path} fits the screen`, async ({ me }) => {
    const { page, api } = me;
    const week = lastWeek();
    await api.entry(
      'Acme / Platform',
      week.at(0, '09:00'),
      week.at(0, '17:00'),
      'A long note about what this stretch of work was for',
    );
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}
