import {
  type APIRequestContext,
  type Browser,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
} from '@playwright/test';
import { DateTime } from 'luxon';
import { ADMIN, ZONE } from '../playwright.config';

const HEADER = 'X-Timeclock-Dev-User';

/** Someone using Timeclock: their own browser page and API access. */
export interface Person {
  email: string;
  /** Their id, as the API names them. */
  id: string;
  name: string;
  page: Page;
  api: Api;
}

/** The API as one person, for arranging what a test starts from. */
export class Api {
  constructor(private request: APIRequestContext) {}

  private async send(method: 'get' | 'post' | 'put' | 'delete', path: string, data?: unknown) {
    const res = await this.request[method](`/api/v1${path}`, data === undefined ? undefined : { data });
    return res;
  }
  private async ok(method: 'get' | 'post' | 'put' | 'delete', path: string, data?: unknown) {
    const res = await this.send(method, path, data);
    if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
    return res.status() === 204 ? null : res.json();
  }
  get = (path: string) => this.ok('get', path);
  post = (path: string, data: unknown = {}) => this.ok('post', path, data);
  put = (path: string, data: unknown) => this.ok('put', path, data);
  /** The response itself, for a request the test expects to be refused. */
  try = (method: 'post' | 'put', path: string, data: unknown = {}) => this.send(method, path, data);
  text = async (path: string) => (await this.request.get(`/api/v1${path}`)).text();

  /** A project's id, by "Customer / Project" or an internal project's name. */
  async project(label: string): Promise<string> {
    const { projects } = await this.get('/projects');
    const found = projects.find(
      (p: { name: string; customerName: string }) =>
        (p.customerName ? `${p.customerName} / ${p.name}` : p.name) === label,
    );
    if (!found) throw new Error(`no project ${label}`);
    return found.id;
  }

  /** Records a finished stretch of work. */
  async entry(project: string, startedAt: string, endedAt: string, note = '') {
    return this.post('/entries', { projectId: await this.project(project), startedAt, endedAt, note });
  }

  /** Starts the clock as though it had been started `minutes` ago. */
  async clockInAgo(project: string, minutes: number, note = '') {
    const projectId = await this.project(project);
    const running = await this.post('/clock/in', { projectId, note });
    const startedAt = DateTime.now().minus({ minutes }).toUTC().toISO();
    return this.put(`/entries/${running.id}`, { projectId, startedAt, note });
  }
}

/**
 * Days that are always wholly in the past, so tests don't depend on what
 * time it is: last workweek (Monday first) in a time zone.
 */
export function lastWeek(zone = ZONE) {
  const monday = DateTime.now().setZone(zone).startOf('week').minus({ weeks: 1 });
  return {
    /** The date of a weekday, 0 for Monday. */
    day: (weekday: number) => monday.plus({ days: weekday }).toISODate() as string,
    /** An instant on a weekday, as the API takes it. */
    at: (weekday: number, time: string) => {
      const [hour = 0, minute = 0] = time.split(':').map(Number);
      return monday.plus({ days: weekday }).set({ hour, minute }).toUTC().toISO() as string;
    },
  };
}

/** An instant as a number, for comparing times the API and a test wrote differently. */
export const instant = (iso: string) => Date.parse(iso);

/** A date some days from today (UTC), for asking the API about a range around now. */
export const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** The API path of every entry near now. */
export const RECENT = () => `/entries?from=${daysFromNow(-2)}&to=${daysFromNow(1)}`;

let serial = 0;

async function join(
  browser: Browser,
  baseURL: string,
  name: string,
  options: BrowserContextOptions = {},
): Promise<Person> {
  // Everyone is new, so tests don't see each other's time; the admin is the one person who isn't.
  const email =
    name === ADMIN ? ADMIN : `${name}-${Date.now().toString(36)}${process.pid}${serial++}@e2e.test`.toLowerCase();
  const context = await browser.newContext({ ...options, baseURL, extraHTTPHeaders: { [HEADER]: email } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('console', (msg) => {
    // A refused request is the app's to show, and tests look for that in the
    // page; what is watched for here is the page itself going wrong.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
      problems.push(`console: ${msg.text()}`);
    }
  });
  const api = new Api(context.request);
  const me = await api.get('/me');
  Object.defineProperty(page, 'problems', { value: problems });
  return { email, id: me.person.id, name: me.person.name, page, api };
}

interface Fixtures {
  /** The person the test is about, signed in on their own page. */
  me: Person;
  /** Another person, by a short name. Each call is someone new. */
  someone: (name: string, options?: BrowserContextOptions) => Promise<Person>;
  /** The API as the payroll admin. */
  admin: Api;
  /** The payroll admin, signed in on a page. */
  adminPerson: () => Promise<Person>;
  /** Makes `manager` the one who approves each of `reports`' time. */
  manages: (manager: Person, ...reports: Person[]) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  someone: async ({ browser, baseURL, contextOptions }, use) => {
    const people: Person[] = [];
    await use(async (name, options = {}) => {
      const p = await join(browser, baseURL as string, name, { ...contextOptions, ...options });
      people.push(p);
      return p;
    });
    // No page may log an error or throw: that includes a CSP violation.
    for (const p of people) {
      const problems = (p.page as Page & { problems: string[] }).problems;
      expect.soft(problems, `${p.name}'s page`).toEqual([]);
      await p.page.context().close();
    }
  },
  me: async ({ someone }, use) => use(await someone('ada')),
  adminPerson: async ({ someone }, use) => use(() => someone(ADMIN)),
  manages: async ({ admin }, use) =>
    use(async (manager, ...reports) => {
      for (const r of reports) {
        await admin.put(`/people/${r.id}`, {
          timezone: (await r.api.get('/me')).person.timezone,
          managerId: manager.id,
          overtimeExempt: false,
          payrollId: '',
          active: true,
        });
      }
    }),
  admin: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL });
    await use(new Api(request));
    await request.dispose();
  },
});

export { expect };

/** The week calendar's column for a weekday (0 is Monday). */
export const column = (page: Page, weekday: number) => page.locator('.tl-column .tl-track').nth(weekday);

/**
 * Where an hour of the day is in a calendar column, in page pixels. The
 * calendar shows the same whole hours in every column; `from` is the first.
 */
export async function hourPoint(page: Page, weekday: number, hour: number, from: number, to: number, across = 0.5) {
  const box = await column(page, weekday).boundingBox();
  if (!box) throw new Error('no such column');
  return { x: box.x + box.width * across, y: box.y + ((hour - from) / (to - from)) * box.height };
}

/** Drags the mouse the way a hand does: press, travel in steps, release. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
