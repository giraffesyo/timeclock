import { execFileSync } from 'node:child_process';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { ACCOUNTS_ENV } from '../playwright.config';

// A server with its own accounts: nobody is signed in until they accept an
// invitation and set a password.

const PASSWORD = 'correct horse battery staple';
let serial = 0;
const address = (name: string) => `${name}-${Date.now().toString(36)}${process.pid}${serial++}@accounts.test`;

/** Runs the server's own command line, the way whoever runs it would, and returns the link it prints. */
function manage(...args: string[]): string {
  const out = execFileSync('../timeclock-server', args, {
    env: { ...process.env, ...ACCOUNTS_ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const link = out.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`no link in: ${out}`);
  return new URL(link).pathname + new URL(link).search;
}

/** Accepts an invitation as someone new, in a browser of their own. */
async function join(browser: Browser, link: string, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Choose a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^Join / }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  return page;
}

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
  await expect(page.getByText('Pat Admin')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The wrong password says so, without saying which part was wrong.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That email and password don’t match.');

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
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
  const key = `north-${Date.now().toString(36)}${process.pid}`;
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
  await page.getByRole('button', { name: 'Change your password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change your password' });
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByLabel('New password').fill('a different long passphrase');
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password').fill('a different long passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('form', { name: 'Clock' })).toBeVisible();
});
