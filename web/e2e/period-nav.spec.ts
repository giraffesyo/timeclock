import type { Page } from '@playwright/test';
import { expect, lastWeek, type Person, test } from './fixtures';

/** The pages that step through pay periods: where each is, what it loads, and who can see it. */
const pages = [
  { name: 'team', path: '/team', api: /\/api\/v1\/team\?/, viewer: 'boss' },
  { name: 'timesheet', path: '/timesheet', api: /\/api\/v1\/timesheet\?/, viewer: 'me' },
  { name: 'payroll report', path: '/reports?tab=payroll', api: /\/api\/v1\/reports\/payroll\?/, viewer: 'admin' },
  { name: 'exceptions report', path: '/reports?tab=exceptions', api: /\/api\/v1\/exceptions\?/, viewer: 'admin' },
] as const;

for (const target of pages) {
  test(`the ${target.name} steps back through periods without waiting for each to load`, async ({
    me,
    someone,
    manages,
    adminPerson,
  }) => {
    const boss = await someone('boss');
    await manages(boss, me);
    const week = lastWeek();
    // Long enough that the exceptions report has something to say about it.
    await me.api.entry('Acme / Platform', week.at(1, '06:00'), week.at(1, '19:00'));
    const viewer: Person = target.viewer === 'boss' ? boss : target.viewer === 'me' ? me : await adminPerson();
    const page: Page = viewer.page;
    const join = target.path.includes('?') ? '&' : '?';
    await page.goto(`${target.path}${join}day=${week.day(1)}`);
    const busy = page.locator('[aria-busy="true"]');
    await expect(page.getByRole('main')).toContainText(target.viewer === 'me' ? '13.00' : me.name);

    // A slow network: each period takes a while to arrive.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(target.api, async (route) => {
      await held;
      await route.continue();
    });

    const previous = page.getByRole('button', { name: 'Previous pay period' });
    const title = page.getByRole('heading', { level: 1 });
    const before = await title.boundingBox();
    // Two steps back before either arrives: the navigation stays and moves on from where it is.
    const day = () => new URL(page.url()).searchParams.get('day') ?? '';
    const start = day();
    await previous.click();
    await expect.poll(day).not.toBe(start);
    const once = day();
    await previous.click();
    await expect.poll(day).not.toBe(once);
    expect(day() < once).toBe(true);
    // What was shown stays in place, dimmed and out of reach, rather than a spinner in its stead.
    await expect(busy).toBeVisible();
    await expect(busy).toHaveAttribute('inert');
    expect(await title.boundingBox()).toEqual(before);

    release();
    await expect(busy).toHaveCount(0);
  });
}
