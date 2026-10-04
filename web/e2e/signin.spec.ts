import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { BREACHED_PASSWORD, IDP, SERVICES_URL, SIGNIN_ENV } from '../playwright.config';
import {
  addAuthenticator,
  address,
  authenticatorCode,
  join,
  manager,
  PASSWORD,
  pathOf,
  signIn,
  workspaceKey,
} from './accounts';

// A server set up the way a real deployment is: mail goes out by SMTP, the
// breach list is checked, workspaces and the server have identity providers,
// and a proxy in front says where each request came from. The mail server,
// the provider and the breach list are e2e/services.mjs.

const manage = manager(SIGNIN_ENV);

/** Each visitor comes from an address of their own, as the proxy reports it. */
const from = () => {
  const part = () => 1 + Math.floor(Math.random() * 250);
  return { extraHTTPHeaders: { 'X-Forwarded-For': `10.${part()}.${part()}.${part()}` } };
};
const visitor = async (browser: Browser): Promise<Page> => (await browser.newContext(from())).newPage();

interface Mail {
  subject: string;
  text: string;
}
const mailTo = async (to: string): Promise<Mail[]> =>
  (await fetch(`${SERVICES_URL}/mail?to=${encodeURIComponent(to)}`)).json();

/** The link in the newest message to an address, once `count` messages have arrived. */
async function mailedLink(to: string, count = 1): Promise<string> {
  await expect.poll(async () => (await mailTo(to)).length, { message: `mail to ${to}` }).toBeGreaterThanOrEqual(count);
  const text = (await mailTo(to)).at(-1)?.text ?? '';
  const link = text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`no link in: ${text}`);
  return pathOf(link);
}

/** Signs in at the identity provider's own page, as whoever the test says. */
async function atProvider(page: Page, email: string, name = '', verified = true) {
  await expect(page.getByRole('heading', { name: 'Example Identity' })).toBeVisible();
  await page.getByLabel('Email at the provider').fill(email);
  await page.getByLabel('Name at the provider').fill(name);
  if (!verified) await page.getByLabel('The address isn’t verified').check();
  await page.getByRole('button', { name: 'Sign in at the provider' }).click();
}

/** From the sign-in page: asks for a link to reset an address's password. */
async function forgot(page: Page, email: string) {
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

const clock = (page: Page) => page.getByRole('form', { name: 'Clock' });
const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

/** A workspace of its own, with its first admin signed in. */
async function workspace(browser: Browser, name: string) {
  const key = workspaceKey('ws');
  const email = address('owner');
  manage('workspace', key, name, '--admin', email);
  const admin = await join(browser, await mailedLink(email), 'Olu Owner', from());
  return { key, name, email, admin };
}

/** Gives the workspace the provider, from Settings, and returns its sign-in link. */
async function connect(admin: Page, options: { required?: boolean; autoJoin?: boolean } = {}): Promise<string> {
  await admin.goto('/settings?tab=signin');
  await admin.getByLabel('Issuer').fill(IDP.issuer);
  await admin.getByLabel('Client ID').fill(IDP.clientId);
  await admin.getByLabel('Client secret').fill(IDP.clientSecret);
  if (options.required) await admin.getByRole('switch', { name: 'Require single sign-on' }).click();
  if (options.autoJoin) await admin.getByRole('switch', { name: 'Let anyone the provider signs in join' }).click();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByText('Single sign-on is saved.')).toBeVisible();
  return pathOf(await admin.getByLabel('Sign-in link').inputValue());
}

test.describe('email', () => {
  test('an invitation arrives by email, and its link lets them in', async ({ browser }) => {
    const boss = address('boss');
    // Whoever runs the server invites the first admin; the same link is mailed.
    const printed = manage('invite', 'default', boss, '--admin');
    expect(await mailedLink(boss)).toBe(printed);
    const admin = await join(browser, printed, 'Bo Boss', from());

    const email = address('ada');
    await admin.goto('/settings?tab=people');
    await admin.getByRole('textbox', { name: 'Email address to invite' }).fill(email);
    await admin.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(admin.getByRole('status')).toContainText(`${email} is invited.`);

    const link = await mailedLink(email);
    const [message] = await mailTo(email);
    expect(message?.subject).toContain('Timeclock');
    expect(message?.text).toContain('The link works for 7 days.');
    const ada = await join(browser, link, 'Ada Lovelace', from());
    await expect(sections(ada).getByRole('link', { name: 'Timer' })).toBeVisible();
    await expect(sections(ada).getByRole('link', { name: 'Settings' })).toHaveCount(0);
  });

  test('a forgotten password is replaced from an emailed link, which works once', async ({ browser }) => {
    const email = address('kit');
    const page = await join(browser, manage('invite', 'default', email), 'Kit', from());
    await page.getByRole('button', { name: 'Sign out' }).click();
    await mailedLink(email); // the invitation

    // Asking for an address nobody has looks the same, and sends nothing.
    const nobody = address('nobody');
    await forgot(page, nobody);
    await expect(page.getByRole('status')).toContainText(nobody);

    await page.getByRole('link', { name: 'Back to sign in' }).click();
    await forgot(page, email);
    const link = await mailedLink(email, 2);
    expect(link).toContain('/reset?token=');
    expect(await mailTo(nobody)).toHaveLength(0);

    await page.goto(link);
    await page.getByLabel('New password').fill('a brand new passphrase');
    await page.getByRole('button', { name: 'Set the password' }).click();
    await expect(clock(page)).toBeVisible();

    // The old password is gone, and the new one works.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, email, PASSWORD);
    await expect(page.getByRole('alert')).toHaveText('That email and password don’t match.');
    await page.getByLabel('Password').fill('a brand new passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(clock(page)).toBeVisible();

    // The link was spent.
    const again = await visitor(browser);
    await again.goto(link);
    await again.getByLabel('New password').fill('yet another passphrase');
    await again.getByRole('button', { name: 'Set the password' }).click();
    await expect(again.getByRole('alert')).toHaveText('This link no longer works. Ask for a new one.');
  });

  test('a new password doesn’t stand in for the authenticator', async ({ browser }) => {
    const email = address('tova');
    const page = await join(browser, manage('invite', 'default', email), 'Tova', from());
    const { key } = await addAuthenticator(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await forgot(page, email);
    await page.goto(await mailedLink(email, 2));
    await page.getByLabel('New password').fill('a brand new passphrase');
    await page.getByRole('button', { name: 'Set the password' }).click();

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    // The code that turned it on is spent; the next half-minute's isn't.
    await page.getByLabel('Code', { exact: true }).fill(authenticatorCode(key, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(clock(page)).toBeVisible();
  });
});

test.describe('passwords', () => {
  test('a password known from a breach is refused', async ({ browser }) => {
    const page = await visitor(browser);
    await page.goto(manage('invite', 'default', address('sam')));
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Choose a password').fill(BREACHED_PASSWORD);
    await page.getByRole('button', { name: /^Join / }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'That password has appeared in a data breach, so it’s easy to guess. Choose another.',
    );
    await page.getByLabel('Choose a password').fill(PASSWORD);
    await page.getByRole('button', { name: /^Join / }).click();
    await expect(sections(page)).toBeVisible();
  });

  test('repeated wrong passwords pause sign-in, for that account and from that address only', async ({ browser }) => {
    const email = address('tess');
    const page = await join(browser, manage('invite', 'default', email), 'Tess', from());
    await page.getByRole('button', { name: 'Sign out' }).click();

    const attempt = async (password: string) => {
      const answered = page.waitForResponse((r) => r.url().endsWith('/auth/login'));
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      return (await answered).status();
    };
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    for (let i = 0; i < 5; i++) expect(await attempt(`wrong guess ${i}`)).toBe(401);
    await expect(page.getByRole('alert')).toHaveText('That email and password don’t match.');

    // From here guesses are slowed, and so is the right password.
    await expect.poll(() => attempt('one more wrong guess')).toBe(429);
    await expect(page.getByRole('alert')).toHaveText('Too many attempts. Wait a little, then try again.');
    expect(await attempt(PASSWORD)).toBe(429);

    // Someone else, somewhere else, isn't slowed by it.
    const other = address('uma');
    const theirs = await join(browser, manage('invite', 'default', other), 'Uma', from());
    await theirs.getByRole('button', { name: 'Sign out' }).click();
    await signIn(theirs, other, PASSWORD);
    await expect(clock(theirs)).toBeVisible();
  });
});

test.describe('a workspace’s single sign-on', () => {
  test('its people sign in through the provider, into that workspace only', async ({ browser }) => {
    const ws = await workspace(browser, 'Harbor Works');
    const loginLink = await connect(ws.admin);
    expect(loginLink).toContain(`/auth/sso/login?workspace=${ws.key}`);

    // Someone invited, who never set a password: their address is offered the provider.
    const email = address('ines');
    manage('invite', ws.key, email);
    const page = await visitor(browser);
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Continue with Harbor Works single sign-on' }).click();
    await atProvider(page, email, 'Ines Provider');
    await expect(clock(page)).toBeVisible();
    await expect(page.getByText('Ines Provider')).toBeVisible();
    await expect(page.getByText('Harbor Works')).toBeVisible();
    await expect(sections(page).getByRole('link', { name: 'Settings' })).toHaveCount(0);

    // What the provider says doesn't change how the account signs in.
    await page.goto('/account');
    await expect(page.getByText('You came in through your workspace’s single sign-on')).toBeVisible();
    await expect(page.getByText('This account has no password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Set up' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeDisabled();

    // The admin sees them among the workspace's people.
    await ws.admin.goto('/settings?tab=people');
    await expect(ws.admin.getByRole('row', { name: /^Ines Provider/ })).toBeVisible();

    // Someone the provider knows but the workspace doesn't is turned away.
    const stranger = await visitor(browser);
    await stranger.goto(loginLink);
    await atProvider(stranger, address('stranger'), 'A Stranger');
    await expect(stranger).toHaveURL(/\/login\?error=sso/);
    await expect(stranger.getByRole('alert')).toContainText('Single sign-on didn’t complete.');

    // So is an invited address the provider hasn't verified.
    const unverified = address('una');
    manage('invite', ws.key, unverified);
    const una = await visitor(browser);
    await una.goto(loginLink);
    await atProvider(una, unverified, 'Una', false);
    await expect(una).toHaveURL(/\/login\?error=sso/);

    // Removed, the provider is no longer offered.
    await ws.admin.goto('/settings?tab=signin');
    await ws.admin.getByRole('button', { name: 'Remove single sign-on' }).click();
    await expect(ws.admin.getByText('Single sign-on is removed.')).toBeVisible();
    const after = await visitor(browser);
    await after.goto('/login');
    await after.getByLabel('Email').fill(email);
    await after.getByRole('button', { name: 'Continue' }).click();
    await expect(after.getByLabel('Password')).toBeVisible();
    await expect(after.getByRole('link', { name: /single sign-on$/ })).toHaveCount(0);
  });

  test('a workspace can take anyone its provider signs in', async ({ browser }) => {
    const ws = await workspace(browser, 'Open Door');
    const loginLink = await connect(ws.admin, { autoJoin: true });

    const email = address('nell');
    const page = await visitor(browser);
    await page.goto(loginLink);
    await atProvider(page, email, 'Nell Newcomer');
    await expect(clock(page)).toBeVisible();
    await expect(page.getByText('Nell Newcomer')).toBeVisible();
    // They join as a member, not an admin.
    await expect(sections(page).getByRole('link', { name: 'Settings' })).toHaveCount(0);

    await ws.admin.goto('/settings?tab=people');
    await expect(ws.admin.getByRole('row', { name: /^Nell Newcomer/ })).toBeVisible();

    // Next time their address is offered the provider on the sign-in page.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Continue with Open Door single sign-on' }).click();
    await atProvider(page, email);
    await expect(clock(page)).toBeVisible();
  });

  test('a workspace that requires it is entered only through the provider', async ({ browser }) => {
    const ws = await workspace(browser, 'Strict Co');
    await connect(ws.admin, { required: true });
    // The admin is in a second workspace too, one a password gets into.
    const other = workspaceKey('side');
    manage('workspace', other, 'Side Project', '--admin', ws.email);
    const context: BrowserContext = await browser.newContext(from());
    const page = await context.newPage();
    await page.goto(await mailedLink(ws.email, 2));
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Join Side Project' }).click();
    const switcher = () => page.getByRole('button', { name: /switch workspace$/ });
    await expect(switcher()).toContainText('Side Project');

    // Choosing the strict workspace goes by way of its provider.
    await switcher().click();
    await page.getByRole('menuitemradio', { name: /Strict Co/ }).click();
    await atProvider(page, ws.email);
    await expect(switcher()).toContainText('Strict Co');
    await expect(clock(page)).toBeVisible();

    // That session is the provider's: it stays in the workspace it vouched for.
    await switcher().click();
    await page.getByRole('menuitemradio', { name: /Side Project/ }).click();
    await expect(page.getByRole('alert')).toContainText('This needs your workspace’s single sign-on.');
    await page.goto('/account');
    await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled();

    // A password still signs the account in, but not into the strict workspace.
    const fresh = await visitor(browser);
    await fresh.goto('/login');
    await signIn(fresh, ws.email, PASSWORD);
    await expect(clock(fresh)).toBeVisible();
    await expect(fresh.getByRole('button', { name: /switch workspace$/ })).toContainText('Side Project');

    // Someone whose only workspace is the strict one isn't asked for a password at all.
    const email = address('pau');
    manage('invite', ws.key, email);
    const pau = await visitor(browser);
    await pau.goto('/login');
    await pau.getByLabel('Email').fill(email);
    await pau.getByRole('button', { name: 'Continue' }).click();
    await pau.getByRole('link', { name: 'Continue with Strict Co single sign-on' }).click();
    await atProvider(pau, email, 'Pau');
    await expect(clock(pau)).toBeVisible();
    await pau.getByRole('button', { name: 'Sign out' }).click();
    await pau.getByLabel('Email').fill(email);
    await pau.getByRole('button', { name: 'Continue' }).click();
    await expect(pau.getByText('Your workspace signs in through its own single sign-on.')).toBeVisible();
    await expect(pau.getByLabel('Password')).toHaveCount(0);
    await expect(pau.getByRole('link', { name: 'Continue with Strict Co single sign-on' })).toBeVisible();
  });
});

test('the server’s own provider signs someone in, and makes their account', async ({ browser }) => {
  const email = address('rory');
  const page = await visitor(browser);
  await page.goto('/overview');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByRole('link', { name: 'Continue with single sign-on' }).click();
  await atProvider(page, email, 'Rory Remote');
  // Back where they were going, in the server's first workspace, as a member.
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText('Rory Remote')).toBeVisible();
  await expect(sections(page).getByRole('link', { name: 'Settings' })).toHaveCount(0);

  // The server's provider vouches for the whole account, so nothing is held back.
  await page.goto('/account');
  await expect(page.getByText('This account has no password')).toBeVisible();
  await expect(page.getByText('You came in through your workspace’s single sign-on')).toHaveCount(0);
});
