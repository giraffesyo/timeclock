import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { ACCOUNTS_URL } from '../playwright.config';

export function installation(server = ACCOUNTS_URL) {
  const dir = mkdtempSync(joinPath(tmpdir(), 'timeclock-cli-'));
  const config = joinPath(dir, 'config.json');
  const flags = ['--config', config, '--credential-store=file'];
  const env = {
    ...process.env,
    TIMECLOCK_TOKEN: '',
    TIMECLOCK_URL: server,
    TIMECLOCK_CONFIG: '',
    TIMECLOCK_CREDENTIAL_STORE: '',
  };
  const run = (args: string[], input?: string) =>
    execFileSync('../timeclock', [...flags, ...args], {
      encoding: 'utf8',
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const start = (device = false) => {
    const child = spawn(
      '../timeclock',
      [...flags, 'auth', 'login', '--no-browser', '--login-timeout=25s', ...(device ? ['--device'] : [])],
      { env },
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { child, finished, output: () => output };
  };
  const credentialPath = () =>
    joinPath(dir, readdirSync(dir).find((name) => name.endsWith('.credentials')) ?? 'missing');
  const credentials = () => JSON.parse(readFileSync(credentialPath(), 'utf8'));
  return {
    dir,
    config,
    run,
    start,
    credentials,
    credentialPath,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function browserApproval(page: Page, cli: ReturnType<typeof installation>, approve = true) {
  const login = cli.start();
  try {
    await expect.poll(() => login.output()).toContain('/auth/cli/authorize?');
    const link = login.output().match(/http:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    await page.goto(link as string);
    await expect(page.getByRole('heading', { name: 'Authorize Timeclock CLI' })).toBeVisible();
    await page.getByRole('button', { name: approve ? 'Authorize CLI' : 'Deny', exact: true }).click();
    expect(await login.finished, login.output()).toBe(approve ? 0 : 1);
  } finally {
    login.child.kill();
  }
}
