import { expect, test } from './fixtures';

/** A calendar app reading a feed: signed out, with only its address. */
const subscribe = (url: string) => fetch(url);

test('someone gets a calendar link to subscribe to, makes a new one, and turns it off', async ({ me }) => {
  const { page } = me;
  await page.goto('/settings?tab=calendar');
  const panel = page.locator('section', {
    has: page.getByRole('heading', { name: 'Subscribe to holidays and time off' }),
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

  // Back later, the link isn't shown again: a new one retires the old.
  await page.reload();
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
