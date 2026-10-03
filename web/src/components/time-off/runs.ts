import { useFormatter, useTranslations } from 'use-intl';
import type { TimeOff } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, type Day, dayToDate } from '@/lib/time';

/** The most days one request may span; the server refuses longer runs. */
export const MAX_REQUEST_DAYS = 92;

export function isWeekend(day: Day): boolean {
  const weekday = dayToDate(day).getDay();
  return weekday === 0 || weekday === 6;
}

/** Whether b is the next day off after a: the next day, or the next weekday across a weekend. */
function follows(a: Day, b: Day): boolean {
  let d = addDays(a, 1);
  while (d < b) {
    if (!isWeekend(d)) return false;
    d = addDays(d, 1);
  }
  return d === b;
}

/** Days of time off that read as one stretch: alike, and one after the other. */
export interface Run {
  /** The id of the run's first day, stable while the run keeps its first day. */
  id: string;
  /** Oldest first; never empty. */
  days: TimeOff[];
  first: TimeOff;
  last: TimeOff;
  hours: number;
}

/**
 * Groups time off into runs of consecutive days that are alike, oldest run
 * first. Time off is one record per day; `alike` names what must match for
 * days to belong together. A weekend between two days doesn't break a run.
 */
export function groupRuns(items: TimeOff[], alike: (t: TimeOff) => string): Run[] {
  const buckets = new Map<string, TimeOff[]>();
  for (const item of items) {
    const key = alike(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const runs: Run[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.day.localeCompare(b.day));
    let current: Run | null = null;
    for (const item of bucket) {
      if (current && follows(current.last.day, item.day)) {
        current.days.push(item);
        current.last = item;
        current.hours += item.hours;
      } else {
        current = { id: item.id, days: [item], first: item, last: item, hours: item.hours };
        runs.push(current);
      }
    }
  }
  return runs.sort((a, b) => a.first.day.localeCompare(b.first.day) || a.id.localeCompare(b.id));
}

/** Days and runs of days in words; the year shows only when it isn't this one. */
export function useDayLabel() {
  const format = useFormatter();
  const t = useTranslations('common.period');
  const { today } = useSession();
  const day = (d: Day) =>
    format.dateTime(dayToDate(d), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: d.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
    });
  const range = (from: Day, to: Day) => (from === to ? day(from) : t('range', { start: day(from), end: day(to) }));
  return { day, range };
}

/** Hours in a sentence: no trailing zeros, at most two places. */
export function useHoursText() {
  const format = useFormatter();
  return (hours: number) => format.number(hours, { maximumFractionDigits: 2 });
}
