import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { DayTimeline, type MovePreview } from '@/components/day-timeline';
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
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const scroll = useRef<HTMLElement>(null);
  const positioned = useRef('');
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

  // Render the whole day at a constant scale. Start at the working day, or
  // the first earlier entry, but leave every hour reachable by scrolling.
  const from = 0;
  const to = Math.max(24, ...days.map((d) => (d.bounds.end - d.bounds.start) / HOUR));
  let initialHour = 7;
  for (const d of days) {
    for (const s of d.spans) {
      initialHour = Math.min(initialHour, Math.floor((s.start - d.bounds.start) / HOUR));
    }
  }
  const todayBounds = days.find((d) => d.day === today)?.bounds;
  const currentHour = todayBounds ? (now - todayBounds.start) / HOUR : null;
  const positionKey = `${week[0]}:${zone}`;
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || positioned.current === positionKey) return;
    const height = el.firstElementChild?.clientHeight ?? 0;
    el.scrollTop =
      currentHour === null ? (initialHour / to) * height : (currentHour / to) * height - el.clientHeight / 2;
    positioned.current = positionKey;
  }, [positionKey, initialHour, currentHour, to]);
  const hours = { from, to };
  const marks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const first = days[0];
  const hourLabel = (h: number) =>
    first ? format.dateTime(new Date(first.bounds.start + h * HOUR), { hour: 'numeric', timeZone: zone }) : '';

  const shown = wide ? days : days.filter((d) => d.day === (picked ?? (hasToday ? today : week[0])));
  const total = (ms: number) => tc('duration', hoursMinutes(ms));

  return (
    <div className="wk">
      {/* The days: on a wide screen the heads of the columns, on a narrow one the way to pick a day. */}
      <div className={cn('grid shrink-0 border-b border-border', wide ? 'wk-grid' : 'grid-cols-7')}>
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

      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus and scroll the hours. */}
      <section ref={scroll} className="wk-scroll" aria-label={t('hours')} tabIndex={0}>
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
              <DayTimeline
                day={d.day}
                entries={d.entries}
                readOnly={readOnly(d.day)}
                hours={hours}
                movePreview={movePreview?.day === d.day ? movePreview : null}
                onMovePreview={setMovePreview}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
