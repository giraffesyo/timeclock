import { type FullConfig, request } from '@playwright/test';

/** The projects every test can record time on. Tests that change the catalog make their own. */
export const CATALOG = { customer: 'Acme', projects: ['Platform', 'Support'], internal: 'Meetings' };

/** Sets up the organization once: a customer with two projects, and an internal project. */
export default async function globalSetup(config: FullConfig) {
  const api = await request.newContext({ baseURL: config.projects[0]?.use.baseURL });
  const post = async (path: string, data: unknown) => {
    const res = await api.post(`/api/v1${path}`, { data });
    if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
    return res.json();
  };
  const customer = await post('/customers', { name: CATALOG.customer });
  for (const name of CATALOG.projects) await post('/projects', { customerId: customer.id, name, billable: true });
  await post('/projects', { name: CATALOG.internal, billable: false });
  await api.dispose();
}
