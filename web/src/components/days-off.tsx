import { CheckIcon } from '@parallelworks/ui/icons';
import { useTranslations } from 'use-intl';
import { TOOLTIP_ID } from '@/components/tooltip';
import { cn } from '@/lib/cn';
import { type TimeOff, useHolidays, useTimeOff, useTimeOffTypes } from '@/lib/queries';
import type { Day } from '@/lib/time';
import { useHoursText } from './time-off/runs';

/** Hours off that make a whole day away, as a holiday pays when its admin doesn't say. */
const FULL_DAY = 8;

/** What takes someone away on a day: a company holiday, or their own time off. */
export type DayOff = { kind: 'holiday'; key: string; name: string } | { kind: 'timeOff'; key: string; item: TimeOff };

export interface DaysOff {
  /** What's on each day, holidays first, then time off in the workspace's order of types. */
  on: (day: Day) => DayOff[];
  /** Away for the whole day: a holiday, or a full day of time off that counts. */
  out: (day: Day) => 'holiday' | 'timeOff' | null;
}

/**
 * A person's days off across some days: the company's holidays, and their
 * time off that isn't rejected. Pending time off shows, marked as waiting,
 * but only time off that counts makes a day away.
 */
export function useDaysOff(days: Day[], personId?: string): DaysOff {
  const first = days[0] ?? '';
  const last = days.at(-1) ?? first;
  const timeOff = useTimeOff(first, last, personId);
  const holidays = useHolidays();
  const types = useTimeOffTypes();
  const order = new Map((types.data ?? []).map((t, i) => [t.id, i]));

  const byDay = new Map<Day, DayOff[]>();
  const add = (day: Day, item: DayOff) => {
    if (!days.includes(day)) return;
    const list = byDay.get(day);
    if (list) list.push(item);
    else byDay.set(day, [item]);
  };
  for (const h of holidays.data ?? []) {
    for (const d of h.days ?? []) add(d.day, { kind: 'holiday', key: `holiday-${h.id}-${d.day}`, name: h.name });
  }
  const shown = (timeOff.data ?? [])
    .filter((t) => t.status !== 'rejected')
    .sort((a, b) => (order.get(a.typeId) ?? 0) - (order.get(b.typeId) ?? 0));
  for (const item of shown) add(item.day, { kind: 'timeOff', key: item.id, item });

  return {
    on: (day) => byDay.get(day) ?? [],
    out: (day) => {
      const list = byDay.get(day) ?? [];
      const counted = list.reduce(
        (sum, d) => (d.kind === 'timeOff' && d.item.status === 'approved' ? sum + d.item.hours : sum),
        0,
      );
      if (counted >= FULL_DAY) return 'timeOff';
      return list.some((d) => d.kind === 'holiday') ? 'holiday' : null;
    },
  };
}

/**
 * One day off as a small tile: what it is, then its hours and where it
 * stands. Time off that needed no approval says nothing more; approved by
 * someone, it says who.
 */
export function DayOffChip({ off, className }: { off: DayOff; className?: string }) {
  const t = useTranslations('timeline.off');
  const hoursText = useHoursText();
  if (off.kind === 'holiday') {
    return (
      <li
        className={cn('dayoff dayoff-holiday', className)}
        data-tooltip-id={TOOLTIP_ID}
        data-tooltip-content={t('holidayHint', { name: off.name })}
      >
        <span className="dayoff-name">{off.name}</span>
        <span className="dayoff-detail">{t('holiday')}</span>
      </li>
    );
  }
  const { item } = off;
  const hours = t('hours', { hours: hoursText(item.hours) });
  const pending = item.status === 'pending';
  const approvedBy = item.status === 'approved' && item.decidedBy ? item.decidedByName || t('someone') : null;
  const hint = pending
    ? t('pendingHint', { type: item.typeName, hours })
    : approvedBy
      ? t('approvedHint', { type: item.typeName, hours, name: approvedBy })
      : t('recordedHint', { type: item.typeName, hours });
  return (
    <li
      className={cn('dayoff', pending && 'dayoff-pending', className)}
      data-tooltip-id={TOOLTIP_ID}
      data-tooltip-content={hint}
    >
      <span className="dayoff-name">{item.typeName}</span>
      <span className="dayoff-detail tabular">
        {hours}
        {pending && <span className="dayoff-state"> · {t('pending')}</span>}
        {approvedBy && (
          <>
            <CheckIcon aria-hidden className="dayoff-check" />
            <span className="sr-only">{t('approvedBy', { name: approvedBy })}</span>
          </>
        )}
      </span>
    </li>
  );
}
