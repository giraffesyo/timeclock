import { defineConfig, devices } from '@playwright/test';

// The end-to-end tests run the real server, with the web build embedded and
// its production CSP, against PostgreSQL. Every run gets a schema of its own.
// Build first: `make e2e` does (the web build, then the server binary).
const port = Number(process.env.E2E_PORT ?? 8099);
const baseURL = `http://localhost:${port}`;

/** The organization's time zone, and the one the browsers are in unless a test says otherwise. */
export const ZONE = 'America/Chicago';
export const ADMIN = 'admin@e2e.test';

const database =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54331/timeclock_test?sslmode=disable';

// A second server with real sign-in: no development user, so its tests
// invite people, set passwords and sign in. Tests reach its command line
// (to invite) with the same settings, so they are kept in the environment,
// which the workers inherit.
const accountsPort = Number(process.env.E2E_ACCOUNTS_PORT ?? 8098);
process.env.E2E_ACCOUNTS_SCHEMA ??= `e2e_accounts_${Date.now()}`;
export const ACCOUNTS_URL = `http://localhost:${accountsPort}`;
export const ACCOUNTS_ENV = {
  PORT: String(accountsPort),
  TIMECLOCK_DATABASE_URL: database,
  TIMECLOCK_SCHEMA: process.env.E2E_ACCOUNTS_SCHEMA,
  TIMECLOCK_PUBLIC_URL: ACCOUNTS_URL,
  // The breach list is a network call; the Go tests cover it.
  TIMECLOCK_BREACH_CHECK: 'off',
};

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: ZONE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
      testIgnore: /(mobile|accounts)\.spec/,
    },
    // Safari handles focus on buttons differently, which the clock bar depends on.
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } },
      testMatch: /clock\.spec/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
    {
      name: 'accounts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, baseURL: ACCOUNTS_URL },
      testMatch: /accounts\.spec/,
    },
  ],
  webServer: [
    {
      command: '../timeclock-server',
      url: `${baseURL}/readyz`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: String(port),
        TIMECLOCK_DATABASE_URL: database,
        TIMECLOCK_SCHEMA: `e2e_${Date.now()}`,
        TIMECLOCK_DEV_USER: ADMIN,
        TIMECLOCK_ADMIN_EMAILS: ADMIN,
      },
    },
    {
      command: '../timeclock-server',
      url: `${ACCOUNTS_URL}/readyz`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'ignore',
      env: ACCOUNTS_ENV,
    },
  ],
});
