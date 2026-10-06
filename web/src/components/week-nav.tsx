import { ChevronLeftIcon, ChevronRightIcon } from '@parallelworks/ui/icons';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';
import { addDays, type Day, dayToDate, weekStartOf } from '@/lib/time';

/** The workweek a day falls in, as its seven days. */
export function useWeek(day?: Day): Day[] {
  const { today, settings } = useSession();
  const start = weekStartOf(day ?? today, settings.weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Steps through workweeks; the weeks ahead of this one have nothing in them. */
export function WeekNav({
  week,
  onChange,
}: {
  week: Day[];
  /** Called with a day in the week to show, or undefined for this week. */
  onChange: (day: Day | undefined) => void;
}) {
  const t = useTranslations('common.week');
  const format = useFormatter();
  const { today } = useSession();
  const first = week[0] ?? today;
  const last = week[6] ?? today;
  const current = today >= first && today <= last;
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" aria-label={t('previous')} onClick={() => onChange(addDays(first, -7))}>
        <ChevronLeftIcon aria-hidden />
      </Button>
      <span className="tabular min-w-40 text-center text-sm font-medium">
        {current
          ? t('this')
          : t('range', {
              start: format.dateTime(dayToDate(first), { month: 'short', day: 'numeric' }),
              end: format.dateTime(dayToDate(last), { month: 'short', day: 'numeric' }),
            })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('next')}
        disabled={last >= today}
        onClick={() => onChange(addDays(first, 7))}
      >
        <ChevronRightIcon aria-hidden />
      </Button>
      {/* Always there, so leaving the current one doesn't shift the nav; hidden while on it. */}
      <Button
        variant="outline"
        size="sm"
        className={cn(current && 'invisible')}
        aria-hidden={current || undefined}
        tabIndex={current ? -1 : undefined}
        onClick={() => onChange(undefined)}
      >
        {t('this')}
      </Button>
    </div>
  );
}
