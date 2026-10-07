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
  process.env.E2E_DATABASE_URL ?? 'postgres://timeclock:timeclock@localhost:54331/timeclock_test?sslmode=disable';

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
  TIMECLOCK_SECRET_KEY: 'a key only the end-to-end tests use, long enough',
};

// The outside world for a third server: a mail server that keeps what it is
// sent, an OpenID Connect provider, and a breach list (e2e/services.mjs).
const servicesPort = Number(process.env.E2E_SERVICES_PORT ?? 8095);
const smtpPort = Number(process.env.E2E_SMTP_PORT ?? 8094);
export const SERVICES_URL = `http://localhost:${servicesPort}`;
export const IDP = { issuer: `${SERVICES_URL}/idp`, clientId: 'timeclock-e2e', clientSecret: 'the provider’s secret' };
/** A password the breach list knows. */
export const BREACHED_PASSWORD = 'breached passphrase';

// That server is set up the way a real deployment is: mail goes out by
// SMTP, the breach list is checked, there is a provider for the whole
// server, and it sits behind a proxy that says where each request is from.
const signInPort = Number(process.env.E2E_SIGNIN_PORT ?? 8097);
process.env.E2E_SIGNIN_SCHEMA ??= `e2e_signin_${Date.now()}`;
export const SIGNIN_URL = `http://localhost:${signInPort}`;
export const SIGNIN_ENV = {
  PORT: String(signInPort),
  TIMECLOCK_DATABASE_URL: database,
  TIMECLOCK_SCHEMA: process.env.E2E_SIGNIN_SCHEMA,
  TIMECLOCK_PUBLIC_URL: SIGNIN_URL,
  TIMECLOCK_SECRET_KEY: 'another key only the end-to-end tests use',
  TIMECLOCK_SMTP_HOST: 'localhost',
  TIMECLOCK_SMTP_PORT: String(smtpPort),
  TIMECLOCK_SMTP_FROM: 'Timeclock <time@signin.test>',
  TIMECLOCK_SMTP_SECURITY: 'none',
  TIMECLOCK_BREACH_URL: `${SERVICES_URL}/breach/range/`,
  TIMECLOCK_TRUST_PROXY: '1',
  TIMECLOCK_OIDC_ISSUER: IDP.issuer,
  TIMECLOCK_OIDC_CLIENT_ID: IDP.clientId,
  TIMECLOCK_OIDC_CLIENT_SECRET: IDP.clientSecret,
};

// Timeclock inside another application: examples/host mounts it under
// /timeclock, with its own people, organizations and colors.
const hostPort = Number(process.env.E2E_HOST_PORT ?? 8096);
export const HOST_URL = `http://localhost:${hostPort}`;

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } };

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
      testIgnore: /(mobile|accounts|signin|host|cli)\.spec/,
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
      testMatch: /(accounts|cli)\.spec/,
    },
    { name: 'signin', use: { ...desktop, baseURL: SIGNIN_URL }, testMatch: /signin\.spec/ },
    { name: 'host', use: { ...desktop, baseURL: HOST_URL }, testMatch: /host\.spec/ },
  ],
  webServer: [
    // First: the sign-in server looks its provider up as it starts.
    {
      command: 'node e2e/services.mjs',
      url: `${SERVICES_URL}/readyz`,
      reuseExistingServer: false,
      env: {
        E2E_SERVICES_PORT: String(servicesPort),
        E2E_SMTP_PORT: String(smtpPort),
        E2E_IDP_SECRET: IDP.clientSecret,
      },
    },
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
        TIMECLOCK_SECRET_KEY: 'integration key only used by the e2e tests',
        E2E_SERVICES_URL: SERVICES_URL,
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
    {
      command: '../timeclock-server',
      url: `${SIGNIN_URL}/readyz`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'ignore',
      env: SIGNIN_ENV,
    },
    {
      command: '../example-host',
      url: `${HOST_URL}/readyz`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'ignore',
      env: {
        PORT: String(hostPort),
        EXAMPLE_DATABASE_URL: database,
        EXAMPLE_SCHEMA: `e2e_host_${Date.now()}`,
        E2E_SERVICES_URL: SERVICES_URL,
      },
    },
  ],
});
