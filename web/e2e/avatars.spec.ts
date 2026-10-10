import type { Page } from '@playwright/test';
import { expect, lastWeek, test } from './fixtures';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#06354f"/></svg>';

/** Gives everyone the API returns a picture, as a host directory would. */
async function withAvatars(page: Page) {
  const dress = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(dress);
    if (!v || typeof v !== 'object') return v;
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dress(x)]));
    if ('avatarUrl' in o && typeof o.id === 'string') o.avatarUrl = `/test-avatar/${o.id}.svg`;
    return o;
  };
  await page.route('**/api/v1/**', async (route) => {
    const response = await route.fetch();
    if (!response.headers()['content-type']?.includes('json')) return route.fulfill({ response });
    await route.fulfill({ response, json: dress(await response.json()) });
  });
  await page.route('**/test-avatar/*.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body: SVG }));
}

test('people show their pictures wherever they are listed', async ({
  me,
  someone,
  manages,
  adminPerson,
  auditorPerson,
}) => {
  const ada = await someone('ada');
  const bob = await someone('bob');
  await manages(me, ada, bob);
  const week = lastWeek();
  await ada.api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '15:00'));
  await bob.api.clockInAgo('Acme / Support', 5);
  await ada.api.post('/time-off', { from: week.day(3), to: week.day(3), hours: 8, kind: 'vacation' });

  const { page } = me;
  await withAvatars(page);
  const picture = (where: ReturnType<Page['locator']>, name: string) => where.getByRole('img', { name, exact: true });

  // On the clock: a running clock also shows as a dot on the picture.
  await page.goto('/overview');
  const tracking = page.locator('section').filter({ hasText: /^On the clock/ });
  const bobRow = tracking.getByRole('listitem').filter({ hasText: bob.name });
  await expect(picture(bobRow, bob.name)).toHaveAttribute('src', `/test-avatar/${bob.id}.svg`);
  await expect(bobRow.getByTestId('online-indicator')).toBeVisible();
  // Only running clocks are listed.
  await expect(tracking.getByRole('listitem').filter({ hasText: ada.name })).toHaveCount(0);

  // The team's sheets, and the time off waiting on the manager.
  await page.goto(`/team?day=${week.day(0)}`);
  await expect(picture(page.getByRole('row').filter({ hasText: ada.name }), ada.name)).toBeVisible();
  await expect(picture(page.getByRole('row').filter({ hasText: bob.name }), bob.name)).toBeVisible();
  const pending = page
    .getByRole('listitem')
    .filter({ hasText: /vacation/i })
    .filter({ hasText: ada.name });
  await expect(picture(pending.first(), ada.name)).toBeVisible();

  // Payroll and its exceptions.
  const admin = await adminPerson();
  await withAvatars(admin.page);
  await admin.page.goto(`/reports?tab=payroll&day=${week.day(0)}`);
  await expect(picture(admin.page.getByRole('row').filter({ hasText: ada.name }), ada.name)).toBeVisible();
  await admin.page.goto(`/reports?tab=exceptions&day=${week.day(0)}`);
  const group = admin.page.locator('section').filter({ has: admin.page.getByRole('heading', { name: ada.name }) });
  await expect(picture(group, ada.name)).toBeVisible();
  // The project report, under each project and as the head of each person's group.
  const range = `from=${week.day(0)}&to=${week.day(4)}`;
  await admin.page.goto(`/reports?tab=projects&${range}`);
  await expect(picture(admin.page.getByRole('row').filter({ hasText: ada.name }), ada.name)).toBeVisible();
  await admin.page.goto(`/reports?tab=projects&${range}&by=person`);
  const own = admin.page.locator('tbody').filter({ hasText: ada.name });
  await expect(picture(own.getByRole('row').first(), ada.name)).toBeVisible();
  // Choosing a person in History shows their picture too.
  const auditor = await auditorPerson();
  await withAvatars(auditor.page);
  await auditor.page.goto('/reports?tab=history');
  const filter = auditor.page.getByRole('button', { name: 'Show changes to one person’s time' });
  await filter.click();
  await picture(auditor.page.getByRole('option', { name: ada.name }), ada.name).click();
  await expect(picture(filter, ada.name)).toBeVisible();
  await expect(filter).toHaveText(ada.name);
  for (const p of [page, admin.page, auditor.page]) await p.unrouteAll({ behavior: 'ignoreErrors' });
});
