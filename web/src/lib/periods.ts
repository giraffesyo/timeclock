// The server's pay period rule (internal/clock/period.go), mirrored so the
// payroll form can show what a pay cycle does before it is saved.
import { DateTime } from 'luxon';
import type { Period, Settings } from '@/lib/queries';
import { addDays, type Day } from '@/lib/time';

type PayCycle = Settings['payCycle'];

const utc = (day: Day) => DateTime.fromISO(day, { zone: 'utc' });

/** The pay period a day falls in. The anchor matters only to weekly and biweekly cycles. */
export function periodContaining(cycle: PayCycle, anchor: Day, day: Day): Period {
  const d = utc(day);
  if (cycle === 'weekly' || cycle === 'biweekly') {
    const n = cycle === 'weekly' ? 7 : 14;
    const days = Math.round(d.diff(utc(anchor), 'days').days);
    const start = addDays(anchor, Math.floor(days / n) * n);
    return { start, end: addDays(start, n - 1) };
  }
  const first = d.startOf('month').toISODate() ?? day;
  const last = d.endOf('month').toISODate() ?? day;
  if (cycle === 'monthly') return { start: first, end: last };
  return d.day <= 15 ? { start: first, end: addDays(first, 14) } : { start: addDays(first, 15), end: last };
}

/** The pay period that starts the day after this one ends. */
export function periodAfter(cycle: PayCycle, anchor: Day, period: Period): Period {
  return periodContaining(cycle, anchor, addDays(period.end, 1));
}

/** Today in a time zone. */
export function todayIn(zone: string, fallback: Day): Day {
  return DateTime.now().setZone(zone).toISODate() ?? fallback;
}

/** Whether a string is a real calendar day, YYYY-MM-DD. */
export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && utc(value).isValid;
}
