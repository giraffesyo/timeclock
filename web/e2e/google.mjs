// Local Google Calendar fixture: the same made-up meetings every workweek, in
// the tests' time zone, for whoever the access token names. It never
// contacts Google.
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

export async function google(req, res, url) {
  if (!url.pathname.startsWith('/google/')) return false;
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  const email = (req.headers.authorization ?? '').match(/^Bearer e2e:(.+)$/)?.[1];
  if (!email) return json(401, { error: { message: 'no token' } });
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
