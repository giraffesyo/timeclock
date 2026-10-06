import { expect, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { ACCOUNTS_ENV } from '../playwright.config';
import { address, authenticatorCode, join, manager, PASSWORD, signIn, workspaceKey } from './accounts';
import { lastWeek } from './fixtures';

// A server with its own accounts: nobody is signed in until they accept an
// invitation and set a password.

const manage = manager(ACCOUNTS_ENV);

test('nobody gets in without signing in', async ({ page, request }) => {
  await page.goto('/timesheet');
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await request.get('/api/v1/me')).status()).toBe(401);
  expect((await request.get('/api/v1/entries?from=2026-01-01&to=2026-01-02')).status()).toBe(401);
});

test('an invited admin sets a password, signs out, and signs back in', async ({ browser }) => {
  const email = address('pat');
  const page = await join(browser, manage('invite', 'default', email, '--admin'), 'Pat Admin');

  // They run payroll here, so they have Settings.
  await expect(
    page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Settings' }),
  ).toBeVisible();
  await expect(page.getByRole('complementary').getByText('Pat Admin')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The wrong password says so, without saying which part was wrong.
  await signIn(page, email, 'not the password');
  await expect(page.getByRole('alert')).toHaveText('That email and password don’t match.');

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();
});

test('a password that is too short is refused, in words', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(manage('invite', 'default', address('sam')));
  await page.getByLabel('Your name').fill('Sam');
  const password = page.getByLabel('Choose a password');
  await password.fill('short');
  // The browser's own check is bypassed, to see the server's answer.
  await password.evaluate((el: HTMLInputElement) => el.removeAttribute('minlength'));
  await page.getByRole('button', { name: /^Join / }).click();
  await expect(page.getByRole('alert')).toHaveText('Use at least 10 characters.');
});

test('an admin invites someone from Settings, and they join as a member', async ({ browser }) => {
  const admin = await join(browser, manage('invite', 'default', address('boss'), '--admin'), 'Bo Boss');
  const email = address('ada');

  await admin.goto('/settings?tab=people');
  await admin.getByRole('textbox', { name: 'Email address to invite' }).fill(email);
  await admin.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(admin.getByRole('status')).toContainText(`${email} is invited.`);
  const link = await admin.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  expect(link).toContain('/invite?token=');
  await expect(admin.getByRole('listitem').filter({ hasText: email })).toBeVisible();

  const ada = await join(browser, new URL(link).pathname + new URL(link).search, 'Ada Lovelace');
  const nav = ada.getByRole('navigation', { name: 'Sections' });
  await expect(nav.getByRole('link', { name: 'Timer' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);

  // The invitation is used: it is gone from the list, and its link no longer works.
  await admin.reload();
  await expect(admin.getByRole('listitem').filter({ hasText: email })).toHaveCount(0);
  const again = await (await browser.newContext()).newPage();
  await again.goto(new URL(link).pathname + new URL(link).search);
  await expect(again.getByRole('heading', { name: 'This invitation can’t be used' })).toBeVisible();

  // Ada is now one of the workspace's people.
  await admin.goto('/settings?tab=people');
  await expect(admin.getByRole('row', { name: /^Ada Lovelace/ })).toBeVisible();
});

test('someone in two workspaces switches between them, and each has its own time', async ({ browser }) => {
  const email = address('wren');
  const page = await join(browser, manage('invite', 'default', email, '--admin'), 'Wren');
  const key = workspaceKey('north');
  const invite = manage('workspace', key, 'North Office', '--admin', email);

  // A project in the first workspace.
  await page.goto('/settings?tab=projects');
  const internal = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Internal' }) });
  await internal.getByRole('button', { name: 'Add project' }).click();
  await page.getByRole('dialog', { name: 'Add project' }).getByLabel('Name').fill(`Only here ${key}`);
  await page.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: 'Save' }).click();
  await expect(internal).toContainText(`Only here ${key}`);

  // They already have an account, so the invitation asks for its password.
  await page.goto(invite);
  await expect(page.getByRole('heading', { name: 'Join North Office' })).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Join North Office' }).click();

  const switcher = page.getByRole('button', { name: /switch workspace$/ });
  await expect(switcher).toContainText('North Office');
  // The new workspace has none of the first one's projects.
  await page.goto('/settings?tab=projects');
  await expect(page.getByText(`Only here ${key}`)).toHaveCount(0);

  await switcher.click();
  await page.getByRole('menuitemradio').filter({ hasNotText: 'North Office' }).click();
  await expect(page.getByRole('button', { name: /switch workspace$/ })).not.toContainText('North Office');
  await page.goto('/settings?tab=projects');
  await expect(page.getByText(`Only here ${key}`)).toBeVisible();
});

test('the signed-in person changes their password', async ({ browser }) => {
  const email = address('kit');
  const page = await join(browser, manage('invite', 'default', email), 'Kit');
  await page.getByRole('link', { name: 'Account and sign-in' }).click();
  await page.getByRole('button', { name: 'Change password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change password' });
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByLabel('New password').fill('a different long passphrase');
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password').fill('a different long passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();
});

test('an authenticator app is asked for after the password, and a recovery code stands in for it', async ({
  browser,
}) => {
  const email = address('tova');
  const page = await join(browser, manage('invite', 'default', email), 'Tova');
  await page.goto('/account');

  // Setting it up asks for the password, shows a QR code and the key, and turns on with a code.
  await page.getByRole('button', { name: 'Set up' }).click();
  const gate = page.getByRole('dialog', { name: 'Set up' });
  await gate.getByLabel('Your password').fill(PASSWORD);
  await gate.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: 'QR code to scan with your authenticator app' })).toBeVisible();
  const key = (await page.locator('code').innerText()).trim();
  await page.getByLabel('Code from the app').fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code isn’t right, or was already used.');
  await page.getByLabel('Code from the app').fill(authenticatorCode(key));
  await page.getByRole('button', { name: 'Turn on' }).click();

  const saved = page.getByRole('dialog', { name: 'Save your recovery codes' });
  await expect(saved.getByRole('listitem')).toHaveCount(10);
  const codes = await saved.getByRole('listitem').allInnerTexts();
  await saved.getByRole('button', { name: 'I’ve saved them' }).click();
  await expect(page.getByText('10 recovery codes left.')).toBeVisible();

  // Now the password is only the first step.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await page.getByLabel('Code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code isn’t right, or was already used.');
  // The next half-minute's code: the one that turned it on is spent.
  await page.getByLabel('Code', { exact: true }).fill(authenticatorCode(key, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();

  // Without the phone: a recovery code, once.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email, PASSWORD);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(codes[0] ?? '');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();
  await page.goto('/account');
  await expect(page.getByText('9 recovery codes left.')).toBeVisible();

  // Turning it off needs the password; then the password is enough again.
  await page.getByRole('button', { name: 'Turn off' }).click();
  const off = page.getByRole('dialog', { name: 'Turn off' });
  await off.getByLabel('Your password').fill(PASSWORD);
  await off.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Set up' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();
});

test('a passkey signs in on its own, with no password or code', async ({ browser }) => {
  const email = address('pia');
  const page = await join(browser, manage('invite', 'default', email), 'Pia');
  // A pretend authenticator that keeps passkeys and verifies its user, as a laptop's does.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto('/account');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  const gate = page.getByRole('dialog', { name: 'Add a passkey' });
  await gate.getByLabel('Name').fill('Work laptop');
  await gate.getByLabel('Your password').fill(PASSWORD);
  await gate.getByRole('button', { name: 'Continue' }).click();
  await expect(gate).toBeHidden();
  await expect(page.getByRole('listitem').filter({ hasText: 'Work laptop' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();
  await expect(page.getByRole('complementary').getByText('Pia', { exact: true })).toBeVisible();

  // Removed, it no longer signs in.
  await page.goto('/account');
  await expect(page.getByRole('listitem').filter({ hasText: 'Work laptop' })).toContainText('Last used');
  await page.getByRole('button', { name: 'Remove the passkey Work laptop' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Work laptop' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a workspace admin sees where to set up single sign-on', async ({ browser }) => {
  const page = await join(browser, manage('invite', 'default', address('ora'), '--admin'), 'Ora');
  await page.goto('/settings?tab=signin');
  await expect(page.getByLabel('Redirect URL')).toHaveValue(/\/auth\/callback$/);
  // An address that is no provider is refused when saving.
  await page.getByLabel('Issuer').fill('http://127.0.0.1:9');
  await page.getByLabel('Client ID').fill('timeclock');
  await page.getByLabel('Client secret').fill('secret');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('Couldn’t save single sign-on.');
});

test('workspace project and description requirements control clocks and manual entries independently', async ({
  browser,
}) => {
  const page = await join(
    browser,
    manage('workspace', workspaceKey('entry-rules'), 'Entry rules', '--admin', address('rules-admin')),
    'Rules Admin',
  );
  const request = page.request;
  const settings = async () => (await (await request.get('/api/v1/me')).json()).settings;
  expect(await settings()).toMatchObject({ requireProject: true, requireDescription: false });
  await page.goto('/settings?tab=projects');
  const internal = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Internal' }) });
  await internal.getByRole('button', { name: 'Add project' }).click();
  const project = page.getByRole('dialog', { name: 'Add project' });
  await project.getByLabel('Name', { exact: true }).fill('Review');
  await project.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(project).toBeHidden();

  await page.goto('/settings');
  const projectRule = page.getByLabel('Require a project on every entry', { exact: true });
  const descriptionRule = page.getByLabel('Require a description on every entry', { exact: true });
  await projectRule.click();
  await descriptionRule.click();
  // A previous save toast may still be visible; wait for this write before navigating.
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT' && response.ok(),
    ),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.reload();
  expect(await settings()).toMatchObject({ requireProject: false, requireDescription: true });

  await page.getByRole('link', { name: 'Timer', exact: true }).click();
  const clock = page.getByRole('form', { name: 'Clock' });
  const note = clock.getByRole('textbox', { name: 'What you are working on' });
  await expect(note).not.toHaveAttribute('required');
  await clock.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await expect(clock.getByRole('timer')).toBeVisible();
  await clock.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(clock.getByRole('alert')).toContainText('Add a description to stop the clock');
  await note.fill('   ');
  await clock.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(clock.getByRole('alert')).toContainText('Add a description to stop the clock');
  const refused = await request.post('/api/v1/clock/out');
  expect(refused.status()).toBe(422);
  await note.fill('Review the schedule');
  await expect(clock.getByRole('timer')).toBeVisible();
  await clock.getByRole('button', { name: /^Project the clock is running on:/ }).click();
  await page.getByRole('option', { name: 'Review', exact: true }).click();
  await expect(clock.getByRole('button', { name: /^Project the clock is running on: Review/ })).toBeVisible();
  await expect(note).toHaveValue('Review the schedule');
  await clock.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(clock.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add time', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add time' });
  await add.getByLabel('Day', { exact: true }).fill(lastWeek().day(0));
  await add.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(add.getByRole('alert')).toContainText('Describe what you worked on.');
  await add.getByRole('textbox', { name: /^Note/ }).fill('Planning');
  await add.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(add).toBeHidden();

  await page.goto('/settings');
  await projectRule.click();
  await descriptionRule.click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/settings') && response.request().method() === 'PUT' && response.ok(),
    ),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect(await settings()).toMatchObject({ requireProject: true, requireDescription: false });
  await page.getByRole('link', { name: 'Timer', exact: true }).click();
  await expect(note).not.toHaveAttribute('required');
  await note.fill('');
  await clock.getByRole('button', { name: /^Project:/ }).click();
  await expect(page.getByRole('option', { name: 'No project', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Review', exact: true }).click();
  await clock.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await expect(clock.getByRole('timer')).toBeVisible();
  await clock.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(clock.getByRole('timer')).toHaveCount(0);

  // Both rules together: start empty, then fill each field while time keeps running.
  const updated = await request.put('/api/v1/settings', { data: { ...(await settings()), requireDescription: true } });
  expect(updated.ok()).toBeTruthy();
  await page.reload();
  await clock.getByRole('button', { name: 'Start the clock', exact: true }).click();
  await expect(clock.getByRole('timer')).toBeVisible();
  const session = await (await request.get('/api/v1/me')).json();
  const started = session.running;
  await clock.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(clock.getByRole('alert')).toContainText('Add a description and choose a project');
  await clock.getByRole('button', { name: /^Project the clock is running on:/ }).click();
  await page.getByRole('option', { name: 'Review', exact: true }).click();
  await expect(clock.getByRole('alert')).toHaveText('Add a description to stop the clock and save this time entry.');
  await note.fill('Finish the review');
  await clock.getByRole('button', { name: 'Stop the clock' }).click();
  await expect(clock.getByRole('timer')).toHaveCount(0);
  // Entry filters use the person's calendar date, which can differ from UTC.
  const day = DateTime.fromISO(started.startedAt)
    .setZone(session.person.timezone || session.settings.timezone)
    .toISODate();
  const entries = (await (await request.get(`/api/v1/entries?from=${day}&to=${day}`)).json()).entries;
  expect(entries.find((entry: { id: string }) => entry.id === started.id)).toMatchObject({
    startedAt: started.startedAt,
    note: 'Finish the review',
    endedAt: expect.any(String),
  });
  await page.context().close();
});
