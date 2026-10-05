import { expect, test } from './fixtures';

for (const mobile of [false, true]) {
  test(`an admin connects Toggl once and disconnects it${mobile ? ' on mobile' : ''}`, async ({ adminPerson, me }) => {
    const { page } = await adminPerson();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    let connected = false;
    let setup: unknown;
    const people = [{ personId: me.id, userId: 123 }];
    await page.route('**/api/v1/integrations/toggl**', async (route) => {
      const req = route.request();
      if (req.url().endsWith('/preview')) {
        await route.fulfill({
          json: {
            workspaces: [{ id: 42, name: 'Trial company', organization_id: 9, admin: true, role: 'admin' }],
            users: req.postDataJSON().workspaceId
              ? [{ user_id: 123, name: 'Trial teammate', email: me.email, inactive: false }]
              : [],
            suggested: req.postDataJSON().workspaceId ? people : [],
          },
        });
        return;
      }
      if (req.method() === 'DELETE') {
        connected = false;
        await route.fulfill({ status: 204 });
        return;
      }
      if (req.method() === 'PUT') {
        setup = req.postDataJSON();
        connected = true;
      }
      await route.fulfill({
        json: {
          available: true,
          connected,
          workspaceId: connected ? 42 : 0,
          from: connected ? '2026-10-01' : '',
          lastSync: null,
          nextSync: null,
          error: '',
          people: connected ? people : [],
          issues: [],
        },
      });
    });
    await page.goto('/integrations');
    await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
    await page.getByLabel('Toggl API token').fill('mock-token');
    await page.getByRole('button', { name: 'Find workspaces and people' }).click();
    await page.getByRole('combobox', { name: 'Toggl workspace' }).selectOption('42');
    await expect(page.getByRole('combobox', { name: 'Trial teammate' })).toHaveValue(me.id);
    await page.getByRole('button', { name: 'Connect and start syncing' }).click();
    await expect(page.getByRole('button', { name: 'Manage connection' })).toBeVisible();
    expect(setup).toMatchObject({ token: 'mock-token', workspaceId: 42, from: '', people });
    expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/timeclock-integrations-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('all person, project and entry mappings');
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByLabel('Toggl API token')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Manage connection' })).toHaveCount(0);
  });
}

test('a non-admin cannot manage integrations', async ({ me }) => {
  await me.page.goto('/integrations');
  await expect(me.page.getByText('An admin can manage your company’s integrations.')).toBeVisible();
  await expect(me.page.getByLabel('Toggl API token')).toHaveCount(0);
  const response = await me.api.try('post', '/integrations/toggl/preview', { token: 'secret', workspaceId: 0 });
  expect(response.status()).toBe(403);
});

// The browser, API, PostgreSQL, and Hopper worker are real. Only Toggl's
// external HTTP API is replaced by e2e/toggl.mjs; no real token is read.
test('full history, two-way edits, disconnect, and reconnect through the real backend', async ({
  adminPerson,
  me,
  request,
}) => {
  test.setTimeout(180_000);
  const { page, api } = await adminPerson();
  const { SERVICES_URL } = await import('../playwright.config');
  const seeded = await request.post(`${SERVICES_URL}/toggl-test`, { data: { email: me.email } });
  const sandbox = await seeded.json();
  const remote = async () => (await request.get(`${SERVICES_URL}/toggl-test/${sandbox.id}`)).json();
  const historical = async () => (await me.api.get('/entries?from=2014-01-01&to=2019-12-31')).entries;
  const connect = async () => {
    await page.getByLabel('Toggl API token').fill(sandbox.token);
    await page.getByRole('button', { name: 'Find workspaces and people' }).click();
    await page.getByRole('combobox', { name: 'Toggl workspace' }).selectOption(String(sandbox.id));
    await expect(page.getByRole('combobox', { name: 'Toggl teammate' })).toHaveValue(me.id);
    await expect(page.getByRole('combobox', { name: 'Time entry history' })).toHaveValue('all');
    await page.getByRole('button', { name: 'Connect and start syncing' }).click();
    await expect(page.getByRole('button', { name: 'Manage connection' })).toBeVisible();
  };
  const sweep = async () => {
    await expect
      .poll(
        async () => {
          const status = await api.get('/integrations/toggl');
          expect(status.error).toBe('');
          if (!status.historyComplete) await api.post('/integrations/toggl/sync');
          return status.historyComplete;
        },
        { timeout: 60_000, intervals: [500, 1000] },
      )
      .toBe(true);
  };
  const disconnect = async () => {
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('all person, project and entry mappings');
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByLabel('Toggl API token')).toHaveValue('');
  };

  await page.goto('/integrations');
  await connect();
  await sweep();
  const imported = await historical();
  expect(imported).toHaveLength(3);
  expect(imported.map((e: { note: string }) => e.note)).toEqual([
    'Historical planning',
    'Historical delivery',
    'Later historical work',
  ]);
  const { projects } = await me.api.get('/projects?archived=true');
  expect(projects.some((p: { name: string }) => p.name === `Archived project ${sandbox.id}`)).toBe(true);
  expect(
    (await remote()).requests.some((r: { body?: { first_row_number?: number } }) => r.body?.first_row_number === 1),
  ).toBe(true);
  await page.reload();
  await expect(page.getByText('Historical scan complete.', { exact: false })).toBeVisible();

  const original = imported[0];
  await me.api.put(`/entries/${original.id}`, {
    startedAt: original.startedAt,
    endedAt: original.endedAt,
    projectId: original.projectId,
    note: 'Edited in Timeclock',
  });
  await api.post('/integrations/toggl/sync');
  await expect
    .poll(async () => (await remote()).entries.find((e: { id: number }) => e.id === 1)?.description)
    .toBe('Edited in Timeclock');

  // Cancel is harmless; confirm removes the connection but keeps recorded data.
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await api.get('/integrations/toggl')).connected).toBe(true);
  await disconnect();
  const disconnected = await api.get('/integrations/toggl');
  expect(disconnected).toMatchObject({
    connected: false,
    workspaceId: 0,
    people: [],
    issues: [],
    historyComplete: false,
    historyThrough: '',
  });
  expect((await historical()).map((e: { id: string }) => e.id)).toEqual(imported.map((e: { id: string }) => e.id));
  const calls = (await remote()).requests.length;
  await api.post('/integrations/toggl/sync');
  await page.waitForTimeout(1500); // Allow a worker tick to prove the disconnected job is idle.
  expect((await remote()).requests).toHaveLength(calls);
  const withoutToken = await api.try('post', '/integrations/toggl/preview', { token: '', workspaceId: sandbox.id });
  expect(withoutToken.ok()).toBe(false);

  // Both apps change the same old entry while disconnected. Reconnect must
  // recover its identity, preserve both versions, and offer a conflict.
  await me.api.put(`/entries/${original.id}`, {
    startedAt: original.startedAt,
    endedAt: original.endedAt,
    projectId: original.projectId,
    note: 'Local offline edit',
  });
  await request.put(`${SERVICES_URL}/toggl-test/${sandbox.id}/entries/1`, {
    data: { description: 'Remote offline edit' },
  });
  await connect();
  await sweep();
  const reconnected = await historical();
  expect(reconnected.map((e: { id: string }) => e.id)).toEqual(imported.map((e: { id: string }) => e.id));
  expect((await remote()).entries).toHaveLength(4);
  await page.reload();
  await expect(page.getByText('Local offline edit ·', { exact: false })).toBeVisible();
  await expect(page.getByText('Remote offline edit ·', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Keep Toggl version' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm choice' }).click();
  await api.post('/integrations/toggl/sync');
  await expect
    .poll(async () => (await historical()).find((e: { id: string }) => e.id === original.id)?.note)
    .toBe('Remote offline edit');
  expect((await api.get('/integrations/toggl')).issues).toEqual([]);
  await disconnect();
});
