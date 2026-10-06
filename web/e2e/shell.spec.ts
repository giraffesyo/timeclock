import { expect, test } from './fixtures';

for (const mobile of [false, true]) {
  test(`account identity shows the host avatar and full name${mobile ? ' on mobile' : ''}`, async ({ me }) => {
    const { page } = me;
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const name = 'Alexandria Montgomery';
    let avatarUrl = '/test-avatar.svg';
    await page.route('**/api/v1/me', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, person: { ...body.person, name }, avatarUrl } });
    });
    await page.route('**/test-avatar.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#06354f"/></svg>',
      }),
    );
    await page.route('**/missing-avatar.png', (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto('/');
    const account = page.locator(mobile ? '.shell-top' : '.shell-side');
    const avatar = account.locator('img');
    await expect(avatar).toHaveAttribute('src', avatarUrl);
    await expect.poll(() => avatar.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(32);
    const fullName = account.getByText(name, { exact: true });
    await expect(fullName).toBeVisible();
    expect(
      await fullName.evaluate((el) => ({
        fits: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight,
        overflow: getComputedStyle(el).textOverflow,
      })),
    ).toEqual({ fits: true, overflow: 'clip' });
    await account.getByRole('button', { name: /: user menu$/ }).click();
    await expect(page.getByRole('link', { name: 'Account and sign-in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await account.screenshot({ path: `/tmp/timeclock-account-${mobile ? 'mobile' : 'desktop'}.png` });

    // A bad image and an absent image both keep the person's initials visible.
    for (const src of ['/missing-avatar.png', '']) {
      avatarUrl = src;
      await page.reload();
      await expect(account.getByText('AM', { exact: true })).toBeVisible();
      await expect(avatar).toHaveCount(0);
      await expect(fullName).toBeVisible();
    }
  });
}
