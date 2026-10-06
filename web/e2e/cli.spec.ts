import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ACCOUNTS_ENV } from '../playwright.config';
import { addAuthenticator, address, join, manager, PASSWORD, signIn, workspaceKey } from './accounts';
import { browserApproval, installation } from './cli';

const manage = manager(ACCOUNTS_ENV);

test('PKCE login, CLI clock and reports, refresh rotation, and logout work end to end', async ({ browser }) => {
  const email = address('cli');
  const page = await join(browser, manage('invite', 'default', email, '--admin'), 'CLI User');
  const cli = installation();
  try {
    await browserApproval(page, cli);
    expect(readFileSync(cli.config, 'utf8')).not.toContain('access_token');
    expect(statSync(cli.credentialPath()).mode & 0o777).toBe(0o600);
    const me = JSON.parse(cli.run(['status', '--json']));
    expect(me.person.email).toBe(email);
    const project = JSON.parse(
      cli.run(
        ['api', '/projects', '-X', 'POST', '--input', '-'],
        JSON.stringify({ name: `CLI project ${email}`, code: 'CLI', billable: false, archived: false }),
      ),
    );
    expect(cli.run(['projects'])).toContain(project.id);
    const running = JSON.parse(cli.run(['clock', 'in', '--project', project.id, '--note', 'CLI E2E work', '--json']));
    expect(running.endedAt).toBeUndefined();
    expect(cli.run(['status'])).toContain('CLI E2E work');
    const switched = JSON.parse(
      cli.run(['clock', 'switch', '--project', project.id, '--note', 'Second task', '--json']),
    );
    expect(switched.note).toBe('Second task');
    const stopped = JSON.parse(cli.run(['clock', 'out', '--json']));
    expect(stopped.endedAt).toBeTruthy();
    expect(cli.run(['entries', 'list', '--from', me.today, '--to', me.today])).toContain('Second task');
    expect(cli.run(['reports', 'projects', '--from', me.today, '--to', me.today, '--csv'])).toContain(
      'customer,project,code,billable,person,hours',
    );
    expect(cli.run(['reports', 'payroll', '--day', me.today, '--csv'])).toContain('gusto_employee_id');

    const entryFlags = [
      '--start',
      '2026-09-14T09:00:00-05:00',
      '--end',
      '2026-09-14T10:00:00-05:00',
      '--project',
      project.id,
    ];
    const added = JSON.parse(cli.run(['entries', 'add', ...entryFlags, '--note', 'Manual CLI work', '--json']));
    const updated = JSON.parse(
      cli.run(['entries', 'update', added.id, ...entryFlags, '--note', 'Corrected CLI work', '--json']),
    );
    expect(updated.note).toBe('Corrected CLI work');
    cli.run(['entries', 'delete', added.id]);
    expect(
      JSON.parse(cli.run(['entries', 'list', '--from', '2026-09-14', '--to', '2026-09-14', '--json'])).entries,
    ).toHaveLength(0);
    cli.run(['entries', 'add', ...entryFlags, '--note', 'Submitted CLI work']);
    const sheet = JSON.parse(cli.run(['timesheet', 'submit', '--day', '2026-09-14', '--json']));
    expect(sheet.timesheet.status).toBe('submitted');
    expect(cli.run(['timesheet', 'show', '--day', '2026-09-14'])).toContain('submitted');
    expect(cli.run(['team', '--day', '2026-09-14'])).toContain('CLI User');
    expect(cli.run(['people'])).toContain(email);
    expect(cli.run(['clocked-in'])).toContain('CLI User');
    expect(JSON.parse(cli.run(['timesheet', 'approve', sheet.timesheet.id, '--json'])).status).toBe('approved');
    cli.run(['timesheet', 'reopen', sheet.timesheet.id, '--note', 'Correct my time']);
    cli.run(['timesheet', 'submit', '--day', '2026-09-14']);
    expect(
      JSON.parse(cli.run(['timesheet', 'reject', sheet.timesheet.id, '--note', 'Needs a correction', '--json'])).status,
    ).toBe('rejected');

    // Force the client to refresh through the real token endpoint; the
    // backend's expiry enforcement is tested with a controlled clock in Go.
    const old = cli.credentials();
    writeFileSync(cli.credentialPath(), JSON.stringify({ ...old, expires_at: '2000-01-01T00:00:00Z' }));
    expect(JSON.parse(cli.run(['status', '--json'])).person.email).toBe(email);
    const fresh = cli.credentials();
    expect(fresh.refresh_token).not.toBe(old.refresh_token);
    expect(cli.run(['auth', 'logout'])).toContain('Signed out');
    expect(readdirSync(cli.dir).some((name) => name.endsWith('.credentials'))).toBe(false);
    expect(
      (await page.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${fresh.access_token}` } })).status(),
    ).toBe(401);
    expect(() => cli.run(['status'])).toThrow();
    // CLI logout does not end the browser session.
    expect((await page.request.get('/api/v1/me')).ok()).toBe(true);
  } finally {
    cli.clean();
  }
});

test('device login asks for a matching code and binds the selected workspace', async ({ browser }, testInfo) => {
  const email = address('device');
  const key = workspaceKey('cli-workspace');
  const page = await join(browser, manage('workspace', key, 'CLI Workspace', '--admin', email), 'Device User');
  const cli = installation();
  const login = cli.start(true);
  try {
    await expect.poll(() => login.output()).toContain('enter code:');
    const code = login.output().match(/enter code: ([A-Z2-7-]+)/)?.[1];
    await page.goto('/cli');
    await expect(page.getByText('CLI Workspace', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('cli-approval-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Authorize CLI', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('cli-approval-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(
      (
        await page.request.post('/auth/cli/decision', {
          headers: { Origin: 'https://other.example' },
          data: { userCode: code, approve: true, workspace: key },
        })
      ).status(),
    ).toBe(403);
    await page.getByLabel('Code from your terminal').fill('AAAA-AAAA');
    await page.getByRole('button', { name: 'Authorize CLI', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('code is incorrect');
    await page.getByLabel('Code from your terminal').fill(code as string);
    await page.getByRole('button', { name: 'Authorize CLI', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'CLI authorized', exact: true })).toBeVisible();
    expect(await login.finished, login.output()).toBe(0);
    const me = JSON.parse(cli.run(['status', '--json']));
    expect(me.person.email).toBe(email);
    const project = JSON.parse(
      cli.run(
        ['api', '/projects', '-X', 'POST', '--input', '-'],
        JSON.stringify({ name: 'Only in CLI workspace', code: '', billable: false, archived: false }),
      ),
    );

    // Joining/switching the browser to another organization cannot change
    // the workspace of an already-authorized CLI token.
    const other = manage('invite', 'default', email);
    await page.goto(other);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: /^Join / }).click();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    expect((await page.request.post('/auth/workspace', { data: { workspace: 'default' } })).ok()).toBe(true);
    const otherProjects = await (await page.request.get('/api/v1/projects')).json();
    expect(otherProjects.projects.some((p: { id: string }) => p.id === project.id)).toBe(false);
    expect(cli.run(['projects'])).toContain(project.id);
    cli.run(['auth', 'logout']);
  } finally {
    login.child.kill();
    cli.clean();
  }
});

test('denied browser and device authorizations never store credentials', async ({ browser }) => {
  const page = await join(browser, manage('invite', 'default', address('deny')), 'Deny User');
  const cli = installation();
  try {
    await browserApproval(page, cli, false);
    const login = cli.start(true);
    try {
      await expect.poll(() => login.output()).toContain('enter code:');
      const code = login.output().match(/enter code: ([A-Z2-7-]+)/)?.[1];
      await page.goto(`/cli?user_code=${code}`);
      await page.getByRole('button', { name: 'Deny', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Authorization denied' })).toBeVisible();
      expect(await login.finished, login.output()).toBe(1);
      expect(login.output()).toContain('access_denied');
      expect(readdirSync(cli.dir).some((name) => name.endsWith('.credentials'))).toBe(false);
    } finally {
      login.child.kill();
    }
  } finally {
    cli.clean();
  }
});

test('CLI browser authorization preserves MFA and rejects a forged callback state', async ({ browser, request }) => {
  const email = address('mfa-cli');
  const page = await join(browser, manage('invite', 'default', email), 'MFA CLI User');
  const { codes } = await addAuthenticator(page);
  await page.context().clearCookies();
  const cli = installation();
  const login = cli.start();
  try {
    await expect.poll(() => login.output()).toContain('/auth/cli/authorize?');
    const link = login.output().match(/http:\/\/\S+/)?.[0] as string;
    const redirect = new URL(link).searchParams.get('redirect_uri');
    expect((await request.get(`${redirect}?state=forged&code=forged`)).status()).toBe(400);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await signIn(page, email, PASSWORD);
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    expect(readdirSync(cli.dir).some((name) => name.endsWith('.credentials'))).toBe(false);
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code', { exact: true }).fill(codes[0] as string);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Authorize Timeclock CLI' })).toBeVisible();
    await page.getByRole('button', { name: 'Authorize CLI', exact: true }).click();
    expect(await login.finished, login.output()).toBe(0);
    expect(JSON.parse(cli.run(['status', '--json'])).person.email).toBe(email);
    cli.run(['auth', 'logout']);
  } finally {
    login.child.kill();
    cli.clean();
  }
});
