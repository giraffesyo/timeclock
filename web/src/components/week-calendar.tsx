import { AngleDownIcon, AngleUpIcon } from '@parallelworks/ui/icons';
import { type CSSProperties, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { DayTimeline } from '@/components/day-timeline';
import { cn } from '@/lib/cn';
import type { Entry } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, dayToDate, hoursMinutes } from '@/lib/time';
import { covered, dayBounds, HOUR, type Span } from '@/lib/timeline';
import { useMedia } from '@/lib/use-media';
import { useNow } from '@/lib/use-now';
import { useZone } from '@/lib/zone';

/**
 * A workweek as seven day rulers side by side over the same hours, each with
 * its total. On a narrow screen one day shows at a time, picked from the
 * week's days above it.
 */
export function WeekCalendar({
  week,
  entries,
  readOnly,
}: {
  week: Day[];
  /** Every entry that touches the week. */
  entries: Entry[];
  /** Whether a day's time can't be changed here. */
  readOnly: (day: Day) => boolean;
}) {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  const format = useFormatter();
  const { today } = useSession();
  const zone = useZone();
  const wide = useMedia('(min-width: 48rem)');
  const [picked, setPicked] = useState<Day | null>(null);
  const [earlier, setEarlier] = useState(0);
  const [later, setLater] = useState(0);
  const hasToday = week.includes(today);
  const now = useNow(30_000, hasToday);

  const days = week.map((day) => {
    const bounds = dayBounds(day, zone);
    const own = entries.filter((e) => {
      const start = Date.parse(e.startedAt);
      const end = e.endedAt ? Date.parse(e.endedAt) : Math.max(now, start);
      return start < bounds.end && end > bounds.start;
    });
    const spans: Span[] = own.map((e) => ({
      start: Math.max(Date.parse(e.startedAt), bounds.start),
      end: Math.min(e.endedAt ? Date.parse(e.endedAt) : now, bounds.end),
    }));
    return { day, bounds, entries: own, spans, worked: covered(spans) };
  });

  // Every day shows the same hours: the working day, widened to whole hours
  // around everything in the week.
  let from = 7;
  let to = 19;
  for (const d of days) {
    for (const s of d.spans) {
      from = Math.min(from, Math.floor((s.start - d.bounds.start) / HOUR));
      to = Math.max(to, Math.ceil((s.end - d.bounds.start) / HOUR));
    }
    if (d.day === today) to = Math.max(to, Math.ceil((now - d.bounds.start) / HOUR));
  }
  from = Math.max(0, from - earlier);
  to = Math.min(24, to + later);
  const hours = { from, to };
  const marks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const first = days[0];
  const hourLabel = (h: number) =>
    first ? format.dateTime(new Date(first.bounds.start + h * HOUR), { hour: 'numeric', timeZone: zone }) : '';

  const shown = wide ? days : days.filter((d) => d.day === (picked ?? (hasToday ? today : week[0])));
  const total = (ms: number) => tc('duration', hoursMinutes(ms));

  return (
    <div className="wk" style={{ '--wk-hours': to - from } as CSSProperties}>
      {/* The days: on a wide screen the heads of the columns, on a narrow one the way to pick a day. */}
      <div className={cn('grid border-b border-border', wide ? 'wk-grid' : 'grid-cols-7')}>
        {wide && <span />}
        {days.map((d) => {
          const date = dayToDate(d.day);
          const isToday = d.day === today;
          const head = (
            <>
              <span
                className={cn(
                  'tabular flex size-8 shrink-0 items-center justify-center rounded-full text-lg font-semibold',
                  isToday && 'bg-primary text-primary-foreground',
                )}
              >
                {format.dateTime(date, { day: 'numeric' })}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className={cn('text-xs font-medium', isToday ? 'text-primary' : 'text-muted-foreground')}>
                  {format.dateTime(date, { weekday: 'short' })}
                </span>
                <span className={cn('tabular text-xs', d.worked === 0 ? 'text-muted-foreground/60' : 'font-medium')}>
                  {total(d.worked)}
                </span>
              </span>
            </>
          );
          const label = t('dayTotal', {
            date: format.dateTime(date, { weekday: 'long', month: 'long', day: 'numeric' }),
            length: total(d.worked),
          });
          return wide ? (
            // biome-ignore lint/a11y/useSemanticElements: the head of a column of the calendar, not a table's
            <div
              key={d.day}
              role="group"
              aria-label={label}
              className="flex items-center gap-2 border-l border-border px-2.5 py-2"
            >
              {head}
            </div>
          ) : (
            <button
              key={d.day}
              type="button"
              aria-label={label}
              aria-pressed={shown[0]?.day === d.day}
              className={cn(
                'flex cursor-pointer flex-col items-center gap-0.5 py-2 [&>span:last-child]:items-center',
                shown[0]?.day === d.day && 'bg-muted',
              )}
              onClick={() => setPicked(d.day)}
            >
              {head}
            </button>
          );
        })}
      </div>

      {from > 0 && (
        <button type="button" className="wk-more border-b border-border" onClick={() => setEarlier(earlier + 2)}>
          <AngleUpIcon aria-hidden className="size-3" />
          {t('earlier')}
        </button>
      )}
      <div className={cn('grid', wide ? 'wk-grid' : 'wk-one')}>
        <div className="wk-gutter" aria-hidden style={{ '--tl-hours': to - from } as CSSProperties}>
          {marks.map((h, i) => (
            <span key={h} className="tl-at" style={{ '--s': i / Math.max(1, to - from) } as CSSProperties}>
              {i > 0 && i < marks.length - 1 && <span className="tl-hour-label tabular">{hourLabel(h)}</span>}
            </span>
          ))}
        </div>
        {shown.map((d) => (
          <div
            key={d.day}
            className={cn(
              'min-w-0 border-l border-border',
              d.day === today && 'bg-primary/[0.035]',
              d.day > today && 'wk-future',
            )}
          >
            <DayTimeline day={d.day} entries={d.entries} readOnly={readOnly(d.day)} hours={hours} />
          </div>
        ))}
      </div>
      {to < 24 && (
        <button type="button" className="wk-more border-t border-border" onClick={() => setLater(later + 2)}>
          <AngleDownIcon aria-hidden className="size-3" />
          {t('later')}
        </button>
      )}
    </div>
  );
}
