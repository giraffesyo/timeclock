// Local Google fixture: the same made-up meetings every workweek, in the
// tests' time zone, for whoever the access token names, and the OAuth steps
// that connect a calendar. Its consent screen allows at once, as the account
// the login hint names, unless that starts with "deny". It never contacts
// Google.
import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';

const ZONE = 'America/Chicago';

/** By ISO weekday: [start, end, title], and whether the person declined. */
const WEEK = {
  1: [
    ['09:30', '09:45', 'Daily standup'],
    ['09:30', '10:00', 'Customer call'],
    ['13:00', '14:00', 'Sprint planning'],
  ],
  2: [
    ['09:30', '09:45', 'Daily standup'],
    ['11:00', '12:00', 'Design review'],
    ['15:00', '15:30', 'Declined sync', true],
  ],
  3: [
    ['09:30', '09:45', 'Daily standup'],
    ['14:00', '14:45', 'Roadmap check-in'],
  ],
  4: [
    ['09:30', '09:45', 'Daily standup'],
    ['10:00', '11:30', 'Release rehearsal'],
    ['16:00', '16:30', 'Office hours'],
  ],
  5: [
    ['09:30', '09:45', 'Daily standup'],
    ['15:00', '16:00', 'Weekly demo'],
  ],
};

const CLIENT_SECRET = 'the fake Google’s secret';
/** Codes not yet exchanged: code → { email, challenge, redirect }. */
const codes = new Map();
/** Accounts whose connection was revoked, until they connect again. */
const revoked = new Set();

const form = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
};
const unsigned = (claims) =>
  `${['{"alg":"none"}', JSON.stringify(claims)].map((p) => Buffer.from(p).toString('base64url')).join('.')}.`;

export async function google(req, res, url) {
  if (!url.pathname.startsWith('/google/')) return false;
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  const q = url.searchParams;

  if (url.pathname === '/google/auth') {
    const back = new URL(q.get('redirect_uri') ?? '');
    back.searchParams.set('state', q.get('state') ?? '');
    const email = q.get('login_hint') ?? '';
    if (email.startsWith('deny') || q.get('access_type') !== 'offline' || q.get('code_challenge_method') !== 'S256') {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = randomBytes(12).toString('hex');
      codes.set(code, { email, challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: back.toString() });
    res.end();
    return true;
  }
  if (url.pathname === '/google/token' && req.method === 'POST') {
    const f = await form(req);
    if (f.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
    if (f.get('grant_type') === 'authorization_code') {
      const grant = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');
      const verified = createHash('sha256')
        .update(f.get('code_verifier') ?? '')
        .digest('base64url');
      if (!grant || grant.challenge !== verified || grant.redirect !== f.get('redirect_uri')) {
        return json(400, { error: 'invalid_grant' });
      }
      revoked.delete(grant.email);
      return json(200, {
        access_token: `e2e:${grant.email}`,
        refresh_token: `refresh:${grant.email}`,
        expires_in: 3600,
        token_type: 'Bearer',
        id_token: unsigned({ email: grant.email }),
      });
    }
    const email = (f.get('refresh_token') ?? '').match(/^refresh:(.+)$/)?.[1];
    if (f.get('grant_type') !== 'refresh_token' || !email || revoked.has(email)) {
      return json(400, { error: 'invalid_grant' });
    }
    return json(200, { access_token: `e2e:${email}`, expires_in: 3600, token_type: 'Bearer' });
  }
  if (url.pathname === '/google/revoke' && req.method === 'POST') {
    const email = ((await form(req)).get('token') ?? '').match(/^refresh:(.+)$/)?.[1];
    if (!email) return json(400, { error: 'invalid_token' });
    revoked.add(email);
    return json(200, {});
  }
  // Whether an account's connection was revoked, for the tests to ask.
  if (url.pathname === '/google/revoked') return json(200, { revoked: revoked.has(q.get('email') ?? '') });

  const email = (req.headers.authorization ?? '').match(/^Bearer e2e:(.+)$/)?.[1];
  if (!email || revoked.has(email)) return json(401, { error: { message: 'no token' } });
  if (url.pathname !== '/google/calendar/v3/calendars/primary/events') return json(404, { error: { message: 'no' } });
  const from = DateTime.fromISO(url.searchParams.get('timeMin') ?? '', { zone: ZONE });
  const to = DateTime.fromISO(url.searchParams.get('timeMax') ?? '', { zone: ZONE });
  if (!from.isValid || !to.isValid || to.diff(from, 'days').days > 60)
    return json(400, { error: { message: 'range' } });
  const items = [];
  for (let day = from.startOf('day'); day < to; day = day.plus({ days: 1 })) {
    const date = day.toISODate();
    if (day.weekday === 1) {
      items.push({
        id: `${date}-allday`,
        status: 'confirmed',
        summary: 'Team offsite',
        start: { date },
        end: { date },
      });
    }
    for (const [start, end, summary, declined] of WEEK[day.weekday] ?? []) {
      const at = (hm) => DateTime.fromISO(`${date}T${hm}`, { zone: ZONE });
      if (at(end) <= from || at(start) >= to) continue;
      const id = `${date}-${summary.toLowerCase().replaceAll(/\W+/g, '-')}`;
      items.push({
        id,
        status: 'confirmed',
        summary,
        htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
        start: { dateTime: at(start).toISO() },
        end: { dateTime: at(end).toISO() },
        attendees: [{ email, self: true, responseStatus: declined ? 'declined' : 'accepted' }],
      });
    }
  }
  return json(200, { summary: email, items });
}
