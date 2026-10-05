// Local Toggl contract fixture. It never reads credentials or contacts Toggl.
const workspaces = new Map();
let serial = 500;
const read = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
};

export async function toggl(req, res, url) {
  if (!url.pathname.startsWith('/toggl')) return false;
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
    return true;
  };
  if (url.pathname === '/toggl-test' && req.method === 'POST') {
    const { email } = await read(req);
    const id = ++serial;
    const project = id * 10;
    const entry = (entryID, start, description) => ({
      id: entryID,
      workspace_id: id,
      user_id: id,
      project_id: project,
      description,
      start,
      stop: new Date(Date.parse(start) + 3_600_000).toISOString(),
      duration: 3600,
    });
    const entries = [
      entry(1, '2014-02-04T14:00:00Z', 'Historical planning'),
      entry(2, '2014-02-05T14:00:00Z', 'Historical delivery'),
      entry(3, '2019-06-10T14:00:00Z', 'Later historical work'),
      entry(4, new Date(Date.now() - 86_400_000).toISOString(), 'Recent Toggl work'),
    ];
    entries[2].project_id = project + 1;
    workspaces.set(id, {
      id,
      email,
      project,
      entries: new Map(entries.map((e) => [e.id, e])),
      requests: [],
      next: 100,
    });
    return json(201, { id, token: `e2e-toggl-${id}` });
  }
  const control = url.pathname.match(/^\/toggl-test\/(\d+)(?:\/entries\/(\d+))?$/);
  if (control) {
    const w = workspaces.get(Number(control[1]));
    if (!w) return json(404, {});
    if (req.method === 'PUT' && control[2]) {
      const id = Number(control[2]);
      w.entries.set(id, { ...w.entries.get(id), ...(await read(req)), id, workspace_id: w.id, user_id: w.id });
    }
    return json(200, { entries: [...w.entries.values()], requests: w.requests });
  }
  const credentials = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
  const match = credentials.match(/^e2e-toggl-(\d+):api_token$/);
  const w = match && workspaces.get(Number(match[1]));
  if (!w) return json(403, {});
  const path = url.pathname.slice('/toggl'.length);
  w.requests.push({ method: req.method, path });
  if (path === '/api/v9/me/workspaces')
    return json(200, [{ id: w.id, organization_id: w.id, name: 'Toggl sandbox', admin: true }]);
  if (path.endsWith('/workspace_users'))
    return json(200, [{ user_id: w.id, name: 'Toggl teammate', email: w.email, inactive: false }]);
  if (path.endsWith('/projects'))
    return json(200, [
      {
        id: w.project,
        workspace_id: w.id,
        name: `Current project ${w.id}`,
        active: true,
        client_id: w.id,
        billable: true,
      },
      {
        id: w.project + 1,
        workspace_id: w.id,
        name: `Archived project ${w.id}`,
        active: false,
        client_id: w.id,
        billable: true,
      },
    ]);
  if (path.endsWith('/clients')) return json(200, [{ id: w.id, name: `Historical customer ${w.id}` }]);
  if (path.startsWith('/reports/')) {
    const body = await read(req);
    w.requests.at(-1).body = body;
    const filtered = [...w.entries.values()]
      .filter((e) => e.start.slice(0, 10) >= body.start_date && e.start.slice(0, 10) <= body.end_date)
      .sort((a, b) => a.start.localeCompare(b.start));
    // Force pagination even for two entries, so a single-page importer fails.
    const index = body.first_row_number ?? 0;
    const e = filtered[index];
    if (filtered[index + 1]) res.setHeader('X-Next-Row-Number', String(index + 1));
    return json(
      200,
      e
        ? [
            {
              user_id: e.user_id,
              project_id: e.project_id,
              description: e.description,
              time_entries: [{ id: e.id, start: e.start, stop: e.stop, seconds: e.duration }],
            },
          ]
        : [],
    );
  }
  const item = path.match(/\/time_entries\/(\d+)$/);
  const id = item ? Number(item[1]) : 0;
  if (req.method === 'GET' && item) return json(w.entries.has(id) ? 200 : 404, w.entries.get(id) ?? {});
  if (req.method === 'DELETE' && item) {
    w.entries.delete(id);
    return json(200, {});
  }
  if (path.includes('/time_entries') && ['POST', 'PUT'].includes(req.method)) {
    const body = await read(req);
    const entryID = id || ++w.next;
    const e = { ...body, id: entryID };
    w.entries.set(entryID, e);
    return json(200, e);
  }
  return json(404, {});
}
