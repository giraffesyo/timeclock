import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { type Browser, type BrowserContextOptions, expect, type Page } from '@playwright/test';

// What the tests of a server with its own accounts share: people who are
// invited, set a password and sign in.

export const PASSWORD = 'correct horse battery staple';
let serial = 0;
/** A new email address, so each test is its own people. */
export const address = (name: string) => `${name}-${Date.now().toString(36)}${process.pid}${serial++}@accounts.test`;
/** A new workspace key. */
export const workspaceKey = (name: string) => `${name}-${Date.now().toString(36)}${process.pid}${serial++}`;

/** A link as the path the tests' browser goes to. */
export const pathOf = (link: string) => new URL(link).pathname + new URL(link).search;

/**
 * The server's own command line, run the way whoever runs the server would,
 * with that server's settings. It returns the link the command prints.
 */
export function manager(env: Record<string, string | undefined>) {
  return (...args: string[]): string => {
    const out = execFileSync('../timeclock-server', args, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const link = out.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error(`no link in: ${out}`);
    return pathOf(link);
  };
}

/** Accepts an invitation as someone new, in a browser of their own. */
export async function join(
  browser: Browser,
  link: string,
  name: string,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(link);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Choose a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^Join / }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  return page;
}

/** Signs in with an email and password, as far as the password goes. */
export async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The code an authenticator app shows for a key now (RFC 6238). */
export function authenticatorCode(key: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of key) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const secret = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', secret).update(step).digest();
  const offset = (mac.at(-1) ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Adds an authenticator app to the signed-in account, from its Account
 * page, and returns the app's key and the recovery codes.
 */
export async function addAuthenticator(page: Page): Promise<{ key: string; codes: string[] }> {
  await page.goto('/account');
  await page.getByRole('button', { name: 'Set up' }).click();
  const gate = page.getByRole('dialog', { name: 'Set up' });
  await gate.getByLabel('Your password').fill(PASSWORD);
  await gate.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: 'QR code to scan with your authenticator app' })).toBeVisible();
  const key = (await page.locator('code').innerText()).trim();
  await page.getByLabel('Code from the app').fill(authenticatorCode(key));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const saved = page.getByRole('dialog', { name: 'Save your recovery codes' });
  await expect(saved.getByRole('listitem')).toHaveCount(10);
  const codes = await saved.getByRole('listitem').allInnerTexts();
  await saved.getByRole('button', { name: 'I’ve saved them' }).click();
  return { key, codes };
}
