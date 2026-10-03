import { AddIcon, CalendarIcon, SchedulerIcon } from '@parallelworks/ui/icons';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { EntryDialog } from '@/components/entry-dialog';
import { EntryList } from '@/components/entry-list';
import { Hours } from '@/components/hours';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { Segmented } from '@/components/segmented';
import { SheetStatus } from '@/components/status';
import { WeekCalendar } from '@/components/week-calendar';
import { useWeek, WeekNav } from '@/components/week-nav';
import { ZoneBanner } from '@/components/zone';
import { type Entry, useEntries, useTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, dayOf, dayToDate, hoursMinutes } from '@/lib/time';
import { covered } from '@/lib/timeline';
import { useNow } from '@/lib/use-now';
import { useZone } from '@/lib/zone';

type View = 'calendar' | 'list';

interface Search {
  /** Any day in the week to show; absent is this week. */
  day?: string;
  view?: View;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const Route = createFileRoute('/')({
  component: TimerPage,
  validateSearch: (search: Record<string, unknown>): Search => ({
    day: isDay(search.day) ? search.day : undefined,
    view: search.view === 'list' ? 'list' : undefined,
  }),
});

/** The week's entries a day at a time, newest day first. */
function WeekList({ week, entries, locked }: { week: Day[]; entries: Entry[]; locked: boolean }) {
  const t = useTranslations('timer');
  const tc = useTranslations('common');
  const format = useFormatter();
  const { today } = useSession();
  const zone = useZone();
  const days = [...week]
    .reverse()
    .map((day) => ({ day, entries: entries.filter((e) => dayOf(e.startedAt, zone) === day) }))
    .filter((d) => d.entries.length > 0);
  if (days.length === 0) return <Empty>{t('empty')}</Empty>;
  return (
    <div className="divide-y divide-border">
      {days.map((d) => (
        <section key={d.day}>
          <div className="flex items-baseline justify-between gap-3 bg-muted/60 px-4 py-2">
            <h3 className="text-sm font-semibold">
              {d.day === today
                ? t('today')
                : format.dateTime(dayToDate(d.day), { weekday: 'long', month: 'short', day: 'numeric' })}
            </h3>
            <span className="tabular text-sm font-medium">
              {tc(
                'duration',
                hoursMinutes(
                  covered(
                    d.entries.map((e) => ({
                      start: Date.parse(e.startedAt),
                      end: e.endedAt ? Date.parse(e.endedAt) : Date.now(),
                    })),
                  ),
                ),
              )}
            </span>
          </div>
          <EntryList entries={d.entries} readOnly={locked} />
        </section>
      ))}
    </div>
  );
}

function TimerPage() {
  const t = useTranslations('timer');
  const te = useTranslations('entry');
  const tc = useTranslations('common');
  const periodLabel = usePeriodLabel();
  const { today, running } = useSession();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const week = useWeek(search.day);
  const first = week[0] ?? today;
  const last = week[6] ?? today;
  const view: View = search.view ?? 'calendar';
  const entries = useEntries(first, last);
  const sheet = useTimesheet();
  const [adding, setAdding] = useState(false);
  const now = useNow(30_000, !!running); // keeps the week's total current while the clock runs

  // The clock, and this period's days, are off while its timesheet is in.
  const period = sheet.data?.period;
  const submitted = sheet.data?.timesheet?.status === 'submitted' || sheet.data?.timesheet?.status === 'approved';
  const lockedDay = (day: Day) => submitted && !!period && day >= period.start && day <= period.end;
  const worked = covered(
    (entries.data ?? []).map((e) => ({
      start: Date.parse(e.startedAt),
      end: e.endedAt ? Date.parse(e.endedAt) : now,
    })),
  );

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
      <h1 className="sr-only">{t('title')}</h1>
      <div className="space-y-4">
        <ZoneBanner />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <WeekNav week={week} onChange={(day) => navigate({ search: (s) => ({ ...s, day }), replace: true })} />
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">{t('weekTotal')}</span>
            <span className="tabular text-lg font-semibold">{tc('duration', hoursMinutes(worked))}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Segmented<View>
              label={t('view.label')}
              value={view}
              onChange={(v) =>
                navigate({ search: (s) => ({ ...s, view: v === 'list' ? v : undefined }), replace: true })
              }
              options={[
                { value: 'calendar', label: t('view.calendar'), icon: <CalendarIcon aria-hidden /> },
                { value: 'list', label: t('view.list'), icon: <SchedulerIcon aria-hidden /> },
              ]}
            />
            <Button
              size="sm"
              className="h-8"
              icon={<AddIcon aria-hidden />}
              disabled={lockedDay(today)}
              onClick={() => setAdding(true)}
            >
              {te('add')}
            </Button>
          </div>
        </div>

        <Panel flush>
          {entries.isError ? (
            <ErrorNote className="m-4" context={t('loadFailed')} error={entries.error} />
          ) : entries.isPending ? (
            <Loading />
          ) : view === 'calendar' ? (
            <WeekCalendar week={week} entries={entries.data} readOnly={lockedDay} />
          ) : (
            <WeekList week={week} entries={entries.data} locked={lockedDay(first) && lockedDay(last)} />
          )}
        </Panel>

        {/* Where this stands for payroll. */}
        {sheet.isError ? (
          <ErrorNote context={t('period.loadFailed')} error={sheet.error} />
        ) : (
          sheet.data && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
              <span className="font-medium">{t('period.title')}</span>
              <span className="tabular text-muted-foreground">{periodLabel(sheet.data.period)}</span>
              <span className="flex items-baseline gap-1.5">
                <Hours value={sheet.data.regular + sheet.data.overtime} strong />
                <span className="text-xs text-muted-foreground">{t('period.worked')}</span>
              </span>
              {sheet.data.overtime > 0 && (
                <span className="flex items-baseline gap-1.5">
                  <Hours value={sheet.data.overtime} strong />
                  <span className="text-xs text-muted-foreground">{t('period.overtime')}</span>
                </span>
              )}
              {sheet.data.vacation + sheet.data.sick > 0 && (
                <span className="flex items-baseline gap-1.5">
                  <Hours value={sheet.data.vacation + sheet.data.sick} strong />
                  <span className="text-xs text-muted-foreground">{t('period.timeOff')}</span>
                </span>
              )}
              <span className="ml-auto flex items-center gap-3">
                <SheetStatus timesheet={sheet.data.timesheet} />
                <Link to="/timesheet" className={buttonClass('outline', 'sm')}>
                  {t('period.open')}
                </Link>
              </span>
            </div>
          )
        )}
      </div>
      <EntryDialog open={adding} onClose={() => setAdding(false)} day={today} />
    </main>
  );
}
