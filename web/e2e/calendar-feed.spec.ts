import { expect, test } from './fixtures';

/** A calendar app reading a feed: signed out, with only its address. */
const subscribe = (url: string) => fetch(url);

test('someone gets a calendar link to subscribe to, makes a new one, and turns it off', async ({ me }) => {
  const { page } = me;
  await page.goto('/settings?tab=calendar');
  const panel = page.locator('section', {
    has: page.getByRole('heading', { name: 'Subscribe in your calendar' }),
  });
  await panel.getByRole('button', { name: 'Get a calendar link' }).click();

  const link = panel.getByRole('textbox', { name: 'Calendar link' });
  await expect(link).toHaveValue(/\/api\/v1\/calendar\/feeds\/\w+\.ics$/);
  const first = await link.inputValue();
  const google = new URL(
    (await panel.getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('href')) ?? '',
  );
  expect(google.searchParams.get('cid')).toBe(first.replace(/^https?:/, 'webcal:'));

  const feed = await subscribe(first);
  expect(feed.status).toBe(200);
  expect(feed.headers.get('content-type')).toMatch(/^text\/calendar/);
  expect(await feed.text()).toContain('BEGIN:VCALENDAR');

  // What it shows changes at the same link, and is never nothing.
  const tracked = panel.getByRole('switch', { name: 'My tracked time' });
  await expect(tracked).toHaveAttribute('aria-checked', 'false');
  await tracked.click();
  await expect(tracked).toHaveAttribute('aria-checked', 'true');
  for (const name of ['Company holidays', 'Who’s out', 'My tracked time']) {
    await panel.getByRole('switch', { name }).click();
  }
  await expect(panel.getByRole('alert')).toHaveText('Choose at least one.');
  expect((await subscribe(first)).status).toBe(200);

  // Back later, the link isn't shown again, and the choice is kept: a new link retires the old.
  await page.reload();
  await expect(tracked).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('switch', { name: 'Company holidays' })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByText(/Your calendar link is on/)).toBeVisible();
  await expect(link).toHaveCount(0);
  await panel.getByRole('button', { name: 'Make a new link' }).click();
  await expect(link).not.toHaveValue(first);
  const second = await link.inputValue();
  expect((await subscribe(first)).status).toBe(404);
  expect((await subscribe(second)).status).toBe(200);

  await panel.getByRole('button', { name: 'Turn off' }).click();
  await expect(panel.getByRole('button', { name: 'Get a calendar link' })).toBeVisible();
  await expect(link).toHaveCount(0);
  expect((await subscribe(second)).status).toBe(404);
});
