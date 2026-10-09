import { CalendarOffIcon, ClockIcon } from '@parallelworks/ui/icons';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { ErrorNote, Loading, Page, Refreshing } from '@/components/page';
import { PeriodNav, usePeriod } from '@/components/period-nav';
import { DayTable } from '@/components/timesheet/day-table';
import { standing } from '@/components/timesheet/sheet';
import { SheetPanel } from '@/components/timesheet/sheet-panel';
import { cn } from '@/lib/cn';
import { useTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { decimalHours } from '@/lib/time';

interface Search {
  /** Any day in the pay period to show; absent is the current one. */
  day?: string;
  /** Whose timesheet; absent is the caller's. */
  person?: string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const Route = createFileRoute('/timesheet')({
  component: TimesheetPage,
  validateSearch: (search: Record<string, unknown>): Search => ({
    day: isDay(search.day) ? search.day : undefined,
    person: typeof search.person === 'string' && search.person !== '' ? search.person : undefined,
  }),
});

/** One line above the table about time the totals leave out. */
function Banner({ tone, icon, children }: { tone: 'info' | 'warning'; icon: ReactNode; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md px-3 py-2 text-sm [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0',
        tone === 'info' ? 'bg-info-subtle text-info' : 'bg-warning-subtle text-warning',
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}

function TimesheetPage() {
  const t = useTranslations('timesheet');
  const tc = useTranslations('common');
  const me = useSession();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const personId = search.person && search.person !== me.person.id ? search.person : undefined;
  const sheet = useTimesheet(search.day, personId, true);
  const summary = sheet.data;
  const period = usePeriod(search.day);
  // The last period's sheet stays, dimmed, while this one loads.
  const stale = sheet.isPlaceholderData;

  const s = summary ? standing(summary, me) : null;

  return (
    <Page
      title={summary && s && !s.own ? t('titleFor', { name: summary.person.name }) : t('title')}
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {personId && (
            <Link to="/team" className="underline underline-offset-2 hover:text-foreground">
              {t('backToTeam')}
            </Link>
          )}
          {/* The same person's week, entry by entry. */}
          <Link
            to="/"
            search={{ person: personId, day: search.day }}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t('openTimer')}
          </Link>
        </span>
      }
      actions={
        <PeriodNav
          period={period}
          today={me.today}
          ahead={me.settings.allowPlannedTime}
          onChange={(day) => navigate({ search: (prev) => ({ ...prev, day }), replace: true })}
        />
      }
    >
      {sheet.isError ? (
        <ErrorNote context={t('loadFailed')} error={sheet.error} />
      ) : !summary || !s ? (
        <Loading />
      ) : (
        <Refreshing stale={stale} className="space-y-4">
          <SheetPanel summary={summary} standing={s} />

          {(summary.running || summary.pendingTimeOff > 0) && (
            <div className="space-y-2">
              {summary.running && (
                <Banner tone="info" icon={<ClockIcon aria-hidden />}>
                  {s.own ? t('banner.runningOwn') : t('banner.runningOther', { name: summary.person.name })}
                </Banner>
              )}
              {summary.pendingTimeOff > 0 && (
                <Banner tone="warning" icon={<CalendarOffIcon aria-hidden />}>
                  {t('banner.pending', { hours: tc('hours', { hours: decimalHours(summary.pendingTimeOff) }) })}{' '}
                  {s.own && (
                    <Link to="/time-off" className="font-medium underline underline-offset-2">
                      {t('banner.pendingLink')}
                    </Link>
                  )}
                </Banner>
              )}
            </div>
          )}

          <DayTable
            key={`${summary.person.id}:${summary.period.start}`}
            summary={summary}
            personId={personId}
            readOnly={s.locked || !s.writer}
          />
        </Refreshing>
      )}
    </Page>
  );
}
