import type { Page } from '@playwright/test';
import { DateTime } from 'luxon';
import { ZONE } from '../playwright.config';
import { column, drag, expect, hourPoint, instant, lastWeek, test } from './fixtures';

// The full day is rendered, initially scrolled to working hours.
const FROM = 0;
const TO = 24;
const at = (page: Page, weekday: number, hour: number, across = 0.5) =>
  hourPoint(page, weekday, hour, FROM, TO, across);
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name });
const dayTotal = (page: Page, date: RegExp) => page.getByRole('group', { name: date });

test('the calendar fills the space above payroll at different window heights', async ({ me }) => {
  const { page } = me;
  await page.goto('/');
  const hours = page.getByRole('region', { name: 'Calendar hours' });
  const payroll = page.getByText('Pay period', { exact: true }).locator('..');
  for (const height of [800, 1200]) {
    await page.setViewportSize({ width: 1440, height });
    await expect
      .poll(async () => {
        const calendar = await hours.boundingBox();
        const footer = await payroll.boundingBox();
        if (!calendar || !footer) throw new Error('calendar is not laid out');
        return Math.abs(footer.y - calendar.y - calendar.height);
      })
      .toBeLessThanOrEqual(1);
    await expect(payroll).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height);
  }
});

test('the day headings line up with their columns', async ({ me }) => {
  const { page } = me;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Calendar hours' })).toBeVisible();
  // Where scrollbars take space, the hours' scrollbar must not shift the columns.
  const offsets = await page.evaluate(() => {
    const left = (els: NodeListOf<Element>) => [...els].map((el) => el.getBoundingClientRect().left);
    const heads = left(document.querySelectorAll('.wk-head > [role="group"]'));
    const columns = left(document.querySelectorAll('.wk-scroll > .grid > .border-l'));
    return heads.map((x, i) => Math.abs(x - (columns[i] ?? Number.NaN)));
  });
  expect(offsets).toHaveLength(7);
  for (const off of offsets) expect(off).toBeLessThan(1);
  await page.screenshot({ path: '/tmp/timeclock-calendar-columns.png' });
});

test('the calendar opens around now and keeps the chosen scroll position', async ({ me }) => {
  const { page } = me;
  // Midday today, so "now" is never at the very top or bottom of the day.
  await page.clock.install({ time: DateTime.now().setZone(ZONE).set({ hour: 12, minute: 0 }).toJSDate() });
  await page.goto('/');
  const hours = page.getByRole('region', { name: 'Calendar hours' });
  const now = page.locator('.tl-now');
  await expect(now).toBeVisible();
  const viewport = await hours.boundingBox();
  const line = await now.boundingBox();
  if (!viewport || !line) throw new Error('calendar is not laid out');
  expect(line.y).toBeGreaterThanOrEqual(viewport.y);
  expect(line.y).toBeLessThanOrEqual(viewport.y + viewport.height);
  await hours.hover();
  const initial = await hours.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => hours.evaluate((el) => el.scrollTop)).toBeLessThan(initial);
  const position = await hours.evaluate((el) => el.scrollTop);
  await page.clock.fastForward(31_000);
  expect(await hours.evaluate((el) => el.scrollTop)).toBe(position);
});

test('scrolling reaches early and late hours while day headings stay visible', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '01:00'), week.at(0, '02:00'), 'Early work');
  await api.entry('Acme / Platform', week.at(0, '22:00'), week.at(0, '23:00'), 'Late work');
  await page.goto(`/?day=${week.day(0)}`);
  const hours = page.getByRole('region', { name: 'Calendar hours' });
  await expect(page.getByRole('button', { name: /^Edit Early work/ })).toBeInViewport();
  await hours.hover();
  await page.mouse.wheel(0, 2000);
  await expect(page.getByRole('button', { name: /^Edit Late work/ })).toBeInViewport();
  await expect(dayTotal(page, /^Monday/)).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Show later hours' })).toHaveCount(0);
  await hours.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => hours.evaluate((el) => el.scrollTop)).toBe(0);
});

test('dragging an empty stretch adds time there', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await page.goto(`/?day=${week.day(2)}`);
  await expect(column(page, 2)).toBeVisible();

  await drag(page, await at(page, 2, 9), await at(page, 2, 11.5));
  const add = dialog(page, 'Add time');
  await expect(add.locator('input[type=date]')).toHaveValue(week.day(2));
  await expect(add.locator('input[type=time]').first()).toHaveValue('09:00');
  await expect(add.locator('input[type=time]').last()).toHaveValue('11:30');

  await add.getByRole('button', { name: /^Project: / }).click();
  await page.getByRole('option', { name: 'Platform' }).click();
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(add).toBeHidden();

  await expect(column(page, 2).locator('[data-entry]')).toHaveCount(1);
  await expect(dayTotal(page, /^Wednesday/)).toContainText('2h 30m');
  await expect
    .poll(async () => (await api.get(`/entries?from=${week.day(2)}&to=${week.day(2)}`)).entries.length)
    .toBe(1);
  const { entries } = await api.get(`/entries?from=${week.day(2)}&to=${week.day(2)}`);
  expect(instant(entries[0].startedAt)).toBe(instant(week.at(2, '09:00')));
});

test('a click on empty space offers a quarter hour from there, and stays open', async ({ me }) => {
  const { page } = me;
  const week = lastWeek();
  await page.goto(`/?day=${week.day(2)}`);
  await expect(column(page, 2)).toBeVisible();

  const p = await at(page, 2, 14);
  await page.mouse.click(p.x, p.y);
  const add = dialog(page, 'Add time');
  await expect(add.locator('input[type=time]').first()).toHaveValue('14:00');
  await expect(add.locator('input[type=time]').last()).toHaveValue('14:15');
  // The click that ended the press isn't one outside the popover.
  await page.waitForTimeout(200);
  await expect(add).toBeVisible();
});

test('dragging an edge changes when an entry ends, on five-minute marks', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(1, '09:00'), week.at(1, '12:00'), 'Build');
  await page.goto(`/?day=${week.day(1)}`);
  const block = column(page, 1).locator('[data-entry]');
  await expect(block).toBeVisible();

  const end = await at(page, 1, 12);
  // Not on a mark: it lands on the nearest one.
  await drag(page, { x: end.x, y: end.y - 2 }, await at(page, 1, 14.03));
  await expect
    .poll(async () => instant((await api.get(`/entries?from=${week.day(1)}&to=${week.day(1)}`)).entries[0].endedAt))
    .toBe(instant(week.at(1, '14:00')));
  await expect(dayTotal(page, /^Tuesday/)).toContainText('5h 0m');
});

test('dragging a block moves it and keeps its length', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'));
  await page.goto(`/?day=${week.day(0)}`);
  await expect(column(page, 0).locator('[data-entry]')).toBeVisible();

  await drag(page, await at(page, 0, 9.5), await at(page, 0, 13.5));
  await expect
    .poll(async () => {
      const e = (await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`)).entries[0];
      return [instant(e.startedAt), instant(e.endedAt)];
    })
    .toEqual([instant(week.at(0, '13:00')), instant(week.at(0, '14:00'))]);
});

test('Escape puts back a block in hand, and its release changes nothing', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'));
  await page.goto(`/?day=${week.day(0)}`);
  const block = column(page, 0).locator('[data-entry]');
  await expect(block).toBeVisible();
  const before = await block.boundingBox();

  const from = await at(page, 0, 9.5);
  const to = await at(page, 0, 13.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('.tl-held')).not.toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tl-held')).toHaveCount(0);
  await page.mouse.up();

  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await block.boundingBox()).toEqual(before);
  const e = (await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`)).entries[0];
  expect([instant(e.startedAt), instant(e.endedAt)]).toEqual([
    instant(week.at(0, '09:00')),
    instant(week.at(0, '10:00')),
  ]);
});

test('Escape drops a stretch being drawn without offering it', async ({ me }) => {
  const { page } = me;
  const week = lastWeek();
  await page.goto(`/?day=${week.day(2)}`);
  await expect(column(page, 2)).toBeVisible();

  const from = await at(page, 2, 9);
  const to = await at(page, 2, 11.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(column(page, 2).locator('[data-draft]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(column(page, 2).locator('[data-draft]')).toHaveCount(0);
  await page.mouse.up();

  await page.waitForTimeout(300);
  await expect(dialog(page, 'Add time')).toHaveCount(0);
});

test('an edge moves with the arrow keys, and saves once the keys rest', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(3, '09:00'), week.at(3, '10:00'), 'Build');
  await page.goto(`/?day=${week.day(3)}`);

  const start = page.getByRole('slider', { name: 'Start of Build' });
  await start.focus();
  await expect(start).toHaveAttribute('aria-valuetext', '9:00 AM');
  await start.press('ArrowUp');
  await start.press('ArrowUp');
  await start.press('PageUp');
  await expect(start).toHaveAttribute('aria-valuetext', '8:20 AM');
  await expect
    .poll(async () => instant((await api.get(`/entries?from=${week.day(3)}&to=${week.day(3)}`)).entries[0].startedAt))
    .toBe(instant(week.at(3, '08:20')));
});

test('a block opens its entry to edit', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(4, '09:00'), week.at(4, '10:00'), 'Build');
  await page.goto(`/?day=${week.day(4)}`);

  await page.getByRole('button', { name: /^Edit Build, Acme \/ Platform, 9:00 AM – 10:00 AM, 1h 0m$/ }).press('Enter');
  const edit = dialog(page, 'Edit time');
  await edit.getByRole('textbox', { name: 'Note' }).fill('Build and test');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(column(page, 4)).toContainText('Build and test');
  expect((await api.get(`/entries?from=${week.day(4)}&to=${week.day(4)}`)).entries[0].note).toBe('Build and test');
});

test('a click on a block opens it too', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(4, '09:00'), week.at(4, '11:00'), 'Build');
  await page.goto(`/?day=${week.day(4)}`);
  const p = await at(page, 4, 10);
  await page.mouse.click(p.x, p.y);
  await expect(dialog(page, 'Edit time')).toBeVisible();
});

test('a mouse click opens the entry even when pointer capture is released', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '11:00'), 'Build');
  await page.goto(`/?day=${week.day(0)}`);
  await expect(page.getByRole('button', { name: /^Edit Build/ })).toBeVisible();
  // Capture can be lost independently of the browser's ordinary click event.
  await page.evaluate(() => {
    document.addEventListener(
      'gotpointercapture',
      (event) => {
        (event.target as Element).releasePointerCapture(event.pointerId);
      },
      { once: true },
    );
  });
  const p = await at(page, 0, 10);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 1, p.y + 1);
  await page.mouse.up();
  await expect(dialog(page, 'Edit time')).toBeVisible();
  await expect(dialog(page, 'Edit time')).toHaveAttribute('popover', 'auto');
  await expect(page.locator('[data-draft]')).toHaveCount(0);
});

test('a short entry remains clickable next to the following entry', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '09:07'), 'Short entry');
  await api.entry('Acme / Support', week.at(0, '09:07'), week.at(0, '10:00'), 'Following entry');
  await page.goto(`/?day=${week.day(0)}`);
  await page
    .getByRole('button', { name: /^Edit Short entry/ })
    .locator('..')
    .click();
  const edit = dialog(page, 'Edit time');
  await expect(edit).toBeVisible();
  await expect(edit.getByRole('textbox', { name: 'Note' })).toHaveValue('Short entry');
  await expect(edit.getByLabel(/^End/)).toHaveValue('09:07');
});

test('a click with small pointer movement opens the popover without moving time', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:02'), week.at(0, '11:17'), 'Click me');
  await page.goto(`/?day=${week.day(0)}`);
  const block = page.getByRole('button', { name: /^Edit Click me/ });
  await expect(block).toBeVisible();
  const p = await at(page, 0, 10);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  // Pressing is still a click: the entry should not turn into a drag preview.
  await expect(block).toContainText('Click me');
  await page.mouse.move(p.x + 3, p.y + 5);
  await page.mouse.up();
  const edit = dialog(page, 'Edit time');
  await expect(edit).toBeVisible();
  await expect(edit).toHaveAttribute('popover', 'auto');
  await expect(edit.getByLabel('Start', { exact: true })).toHaveValue('09:02');
  await expect(edit.getByLabel(/^End/)).toHaveValue('11:17');
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  const { entries } = await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`);
  expect(entries).toHaveLength(1);
  expect(instant(entries[0].startedAt)).toBe(instant(week.at(0, '09:02')));
  expect(instant(entries[0].endedAt)).toBe(instant(week.at(0, '11:17')));
});

test('an entry edits in a popover, changes project, and dismisses with Escape', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'), 'Build');
  await page.goto(`/?day=${week.day(0)}`);
  const block = page.getByRole('button', { name: /^Edit Build/ });
  await block.press('Enter');
  const edit = dialog(page, 'Edit time');
  await expect(edit).toHaveAttribute('popover', 'auto');
  await expect(edit).not.toHaveAttribute('aria-modal', 'true');
  await edit.getByRole('button', { name: /^Project: / }).click();
  await page.getByRole('option', { name: 'Support' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(block).toHaveAttribute('aria-label', /Acme \/ Support/);
  await block.press('Enter');
  await page.keyboard.press('Escape');
  await expect(edit).toBeHidden();
  await expect(block).toBeFocused();
});

test('duplicating time preserves its details and can put the copy on another day', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:30'), 'Build');
  await page.goto(`/?day=${week.day(0)}`);
  await page.getByRole('button', { name: /^Edit Build/ }).press('Enter');
  const edit = dialog(page, 'Edit time');
  await edit.getByLabel('Day', { exact: true }).fill(week.day(1));
  await edit.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(column(page, 0).locator('[data-entry]')).toHaveCount(1);
  await expect(column(page, 1).locator('[data-entry]')).toHaveCount(1);
  const { entries } = await api.get(`/entries?from=${week.day(0)}&to=${week.day(1)}`);
  expect(entries).toHaveLength(2);
  expect(entries.map((e: { note: string }) => e.note)).toEqual(['Build', 'Build']);
  expect(entries[0].projectId).toBe(entries[1].projectId);
  expect(entries.map((e: { startedAt: string; endedAt: string }) => instant(e.endedAt) - instant(e.startedAt))).toEqual(
    [90 * 60_000, 90 * 60_000],
  );
});

test('the entry actions delete time on desktop and mobile, while cancel preserves edits', async ({ me }, testInfo) => {
  const { page, api } = me;
  const week = lastWeek();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 650 },
  ]) {
    await page.setViewportSize(viewport);
    await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'), 'Delete me');
    await page.goto(`/?day=${week.day(0)}`);
    await page.getByRole('button', { name: /^Edit Delete me/ }).click();
    const edit = dialog(page, 'Edit time');
    await edit.getByRole('textbox', { name: 'Note' }).fill('Unsaved changes');
    const actions = edit.getByRole('button', { name: 'Entry actions' });
    await actions.press('Enter');
    const deletion = edit.getByRole('menuitem', { name: 'Delete' });
    await expect(deletion).toBeInViewport({ ratio: 1 });
    await testInfo.attach(`entry-actions-${viewport.width}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`entry-actions-${viewport.width}.png`) }),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(edit.getByRole('menu')).toBeHidden();
    await expect(edit).toBeVisible();
    await expect(actions).toBeFocused();
    await actions.press('Enter');
    await deletion.click();
    await expect(edit.getByRole('heading', { name: 'Delete this time?' })).toBeVisible();
    await expect(edit).toContainText('9:00 AM – 10:00 AM on Acme / Platform');
    await expect(edit.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await testInfo.attach(`entry-delete-${viewport.width}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`entry-delete-${viewport.width}.png`) }),
      contentType: 'image/png',
    });
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit.getByRole('textbox', { name: 'Note' })).toHaveValue('Unsaved changes');
    expect((await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`)).entries).toHaveLength(1);
    await actions.click();
    await deletion.click();
    await edit.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(edit).toBeHidden();
    await expect(page.locator('[data-entry]')).toHaveCount(0);
    expect((await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`)).entries).toHaveLength(0);
    await expect(page.getByText('Week total').locator('..')).toContainText('0h 0m');
  }
});

test('a failed deletion can be retried and deleting running time clears the clock', async ({ me }) => {
  const { page, api } = me;
  // Started today, so the running block doesn't reach back into yesterday's column.
  const sinceMidnight = Math.floor(
    DateTime.now().setZone(ZONE).diff(DateTime.now().setZone(ZONE).startOf('day'), 'minutes').minutes,
  );
  const entry = await api.clockInAgo('Acme / Platform', Math.min(30, sinceMidnight), 'Running to delete');
  await page.goto('/');
  await page.getByRole('button', { name: /^Edit Running to delete/ }).press('Enter');
  const edit = dialog(page, 'Edit time');
  await edit.getByRole('button', { name: 'Entry actions' }).click();
  await edit.getByRole('menuitem', { name: 'Delete' }).click();
  await page.route(`**/api/v1/entries/${entry.id}`, (route) => route.fulfill({ status: 500 }), { times: 1 });
  await edit.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(edit.getByRole('alert')).toContainText('Couldn’t delete the time.');
  await expect(page.locator('[data-entry]')).toHaveCount(1);
  await edit.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator('[data-entry]')).toHaveCount(0);
  expect((await api.get('/me')).running).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Start the clock', exact: true })).toBeVisible();
});

test('dragging time into another day preserves its duration and details', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  const original = await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:30'), 'Build');
  await page.goto(`/?day=${week.day(0)}`);
  await expect(column(page, 0).locator('[data-entry]')).toBeVisible();
  await drag(page, await at(page, 0, 9.5), await at(page, 2, 11.5));
  await expect(column(page, 0).locator('[data-entry]')).toHaveCount(0);
  await expect(column(page, 2).locator('[data-entry]')).toHaveCount(1);
  await expect
    .poll(async () => {
      const { entries } = await api.get(`/entries?from=${week.day(0)}&to=${week.day(2)}`);
      return instant(entries[0].startedAt);
    })
    .toBe(instant(week.at(2, '11:00')));
  const { entries } = await api.get(`/entries?from=${week.day(0)}&to=${week.day(2)}`);
  expect(entries).toHaveLength(1);
  expect(entries[0].id).toBe(original.id);
  expect(entries[0].note).toBe('Build');
  expect(instant(entries[0].startedAt)).toBe(instant(week.at(2, '11:00')));
  expect(instant(entries[0].endedAt)).toBe(instant(week.at(2, '12:30')));
  await expect(dayTotal(page, /^Monday/)).toContainText('0h 0m');
  await expect(dayTotal(page, /^Wednesday/)).toContainText('1h 30m');
  await expect(dialog(page, 'Edit time')).toHaveCount(0);
});

test('a duplicate drags into another day, from either side of its original', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:30'), 'Build');
  await page.goto(`/?day=${week.day(0)}`);
  await column(page, 0).locator('[data-entry] .tl-body').click();
  await dialog(page, 'Edit time').getByRole('button', { name: 'Duplicate' }).click();
  await expect(column(page, 0).locator('[data-entry]')).toHaveCount(2);
  // The two sit side by side; take the left one, then the right, each to a day of its own.
  await drag(page, await at(page, 0, 9.5, 0.25), await at(page, 1, 13.5));
  await expect(column(page, 1).locator('[data-entry]')).toHaveCount(1);
  await drag(page, await at(page, 0, 9.5, 0.5), await at(page, 2, 13.5));
  await expect(column(page, 2).locator('[data-entry]')).toHaveCount(1);
  await expect(column(page, 0).locator('[data-entry]')).toHaveCount(0);
  await expect
    .poll(async () => {
      const { entries } = await api.get(`/entries?from=${week.day(0)}&to=${week.day(2)}`);
      return entries.map((e: { startedAt: string; note: string }) => [instant(e.startedAt), e.note]).sort();
    })
    .toEqual([
      [instant(week.at(1, '13:00')), 'Build'],
      [instant(week.at(2, '13:00')), 'Build'],
    ]);
});

test('dragging a block past a later one in its day still moves it', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  const early = await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'), 'Early');
  await api.entry('Meetings', week.at(0, '12:00'), week.at(0, '13:00'), 'Late');
  await page.goto(`/?day=${week.day(0)}`);
  await expect(column(page, 0).locator('[data-entry]')).toHaveCount(2);
  await drag(page, await at(page, 0, 9.5), await at(page, 0, 15.5));
  await expect
    .poll(async () => {
      const { entries } = await api.get(`/entries?from=${week.day(0)}&to=${week.day(0)}`);
      return instant(entries.find((e: { id: string }) => e.id === early.id).startedAt);
    })
    .toBe(instant(week.at(0, '15:00')));
});

test('overlapping entries sit side by side and count once', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '17:00'), 'Long build');
  await api.entry('Meetings', week.at(0, '10:00'), week.at(0, '11:00'), 'Review triage');
  await page.goto(`/?day=${week.day(0)}`);

  const blocks = column(page, 0).locator('[data-entry]');
  await expect(blocks).toHaveCount(2);
  const [long, meeting] = await Promise.all([blocks.nth(0).boundingBox(), blocks.nth(1).boundingBox()]);
  if (!long || !meeting) throw new Error('blocks are not laid out');
  expect(long.x + long.width).toBeLessThanOrEqual(meeting.x + 1);

  // Eight hours passed, so eight were worked, though nine were recorded.
  await expect(dayTotal(page, /^Monday/)).toContainText('8h 0m');
  await expect(page.getByText('Week total').locator('..')).toContainText('8h 0m');
  const sheet = await api.get(`/timesheet?day=${week.day(0)}`);
  expect(sheet.regular).toBe(8);
});

test('hover tooltips only supplement small or clipped entry blocks', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Meetings', week.at(0, '09:00'), week.at(0, '12:00'), 'Review');
  await api.entry('Meetings', week.at(1, '09:00'), week.at(1, '09:15'), 'Quick call');
  await api.entry(
    'Meetings',
    week.at(2, '09:00'),
    week.at(2, '12:00'),
    'A very long description that cannot possibly fit in one calendar column',
  );
  await page.goto(`/?day=${week.day(0)}`);
  const roomy = page.getByRole('button', { name: /^Edit Review,/ }).locator('..');
  await roomy.hover();
  await expect(roomy).not.toHaveAttribute('data-tooltip-id');
  const small = page.getByRole('button', { name: /^Edit Quick call,/ }).locator('..');
  await small.hover();
  await expect(small).toHaveAttribute('data-tooltip-id');
  await expect(page.getByRole('tooltip')).toContainText('Quick call');
  const clipped = page.getByRole('button', { name: /^Edit A very long description/ }).locator('..');
  await clipped.hover();
  await expect(clipped).toHaveAttribute('data-tooltip-id');
  await small.click();
  await expect(dialog(page, 'Edit time')).toHaveAttribute('popover', 'auto');
});

test('a day ahead takes no time', async ({ me }) => {
  const { page } = me;
  await page.goto('/');
  await expect(column(page, 0)).toBeVisible();
  const ahead = page.locator('.wk-future .tl-track');
  test.skip((await ahead.count()) === 0, 'today is the last day of the week');
  const box = await page.locator('.wk-scroll').boundingBox();
  const track = await ahead.last().boundingBox();
  if (!box || !track) throw new Error('no column');
  await drag(page, { x: track.x + 20, y: box.y + 60 }, { x: track.x + 20, y: box.y + 160 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the list shows the week a day at a time', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '12:00'), 'Build');
  await api.entry('Acme / Support', week.at(2, '13:00'), week.at(2, '14:30'), 'Ticket');
  await page.goto(`/?day=${week.day(0)}`);
  await page.getByRole('button', { name: 'List' }).click();
  await expect(page).toHaveURL(/view=list/);
  const days = page.getByRole('main').locator('section h3');
  await expect(days).toHaveCount(2);
  await expect(days.first()).toContainText('Wednesday');
  await expect(page.getByRole('listitem').filter({ hasText: 'Ticket' })).toContainText('1h 30m');
});

test('the project menu escapes the entry popover and stays selectable at viewport edges', async ({ me }) => {
  const { page, api } = me;
  const week = lastWeek();
  await api.entry('Acme / Platform', week.at(0, '09:00'), week.at(0, '10:00'), 'Menu clipping');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1440, height: 600 },
    { width: 390, height: 650 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/?day=${week.day(0)}`);
    await page.getByRole('button', { name: /^Edit Menu clipping/ }).click();
    const edit = dialog(page, 'Edit time');
    await edit.getByRole('button', { name: /^Project:/ }).click();
    const menu = page.getByRole('listbox', { name: 'Project', exact: true });
    await expect(menu).toBeVisible();
    const last = menu.getByRole('option').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport({ ratio: 1 });
    // Visibility alone passes for clipped descendants. Hit-test the last row's
    // lower edge: it must actually receive a click, outside the editor's bounds too.
    expect(
      await last.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 2));
      }),
    ).toBe(true);
    const bounds = await menu.locator('..').boundingBox();
    if (!bounds) throw new Error('menu has no bounds');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(edit).toBeVisible();
    await edit.getByRole('button', { name: /^Project:/ }).click();
    const chosen = (await last.innerText()).trim();
    await last.click();
    await expect(menu).toBeHidden();
    await expect(edit).toBeVisible();
    await expect(edit.getByRole('button', { name: /^Project:/ })).toContainText(chosen);
    // Save with this test's own project: the last one belongs to whichever test
    // sorts there, and may be archived or changed before this saves.
    await edit.getByRole('button', { name: /^Project:/ }).click();
    await menu.getByRole('option', { name: 'Platform', exact: true }).click();
    await expect(edit.getByRole('button', { name: /^Project:/ })).toContainText('Acme / Platform');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toBeHidden();
  }
});
