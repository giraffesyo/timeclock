import { ChevronLeftIcon, ChevronRightIcon } from '@parallelworks/ui/icons';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { cn } from '@/lib/cn';
import type { Period } from '@/lib/queries';
import { addDays, type Day, dayToDate } from '@/lib/time';

/** A pay period's dates, as "Sep 28 – Oct 11, 2026". */
export function usePeriodLabel() {
  const format = useFormatter();
  const t = useTranslations('common.period');
  return (period: Period) =>
    t('range', {
      start: format.dateTime(dayToDate(period.start), { month: 'short', day: 'numeric' }),
      end: format.dateTime(dayToDate(period.end), { month: 'short', day: 'numeric', year: 'numeric' }),
    });
}

/**
 * Steps through pay periods. It names a period by any day in it, which is
 * what the API takes, so it needn't know the pay cycle: the day before this
 * period starts is in the previous one, the day after it ends in the next.
 */
export function PeriodNav({
  period,
  today,
  onChange,
  ahead,
}: {
  period: Period;
  today: Day;
  /** Periods ahead can be shown, up to a year out: where planned time is allowed. */
  ahead?: boolean;
  /** Called with a day in the period to show, or undefined for the current one. */
  onChange: (day: Day | undefined) => void;
}) {
  const t = useTranslations('common.period');
  const label = usePeriodLabel();
  const isCurrent = today >= period.start && today <= period.end;
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" aria-label={t('previous')} onClick={() => onChange(addDays(period.start, -1))}>
        <ChevronLeftIcon aria-hidden />
      </Button>
      <span className="tabular min-w-44 text-center text-sm font-medium">{label(period)}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('next')}
        disabled={ahead ? period.end >= addDays(today, 366) : period.end >= today}
        onClick={() => onChange(addDays(period.end, 1))}
      >
        <ChevronRightIcon aria-hidden />
      </Button>
      {/* Always there, so leaving the current one doesn't shift the nav; hidden while on it. */}
      <Button
        variant="outline"
        size="sm"
        className={cn(isCurrent && 'invisible')}
        aria-hidden={isCurrent || undefined}
        tabIndex={isCurrent ? -1 : undefined}
        onClick={() => onChange(undefined)}
      >
        {t('current')}
      </Button>
    </div>
  );
}
