import { AddIcon, CalendarIcon, SchedulerIcon } from '@parallelworks/ui/icons';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { EntryDialog } from '@/components/entry-dialog';
import { EntryList } from '@/components/entry-list';
import { Hours } from '@/components/hours';
import { Empty, ErrorNote, Loading } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { Segmented } from '@/components/segmented';
import { SheetStatus } from '@/components/status';
import { standing } from '@/components/timesheet/sheet';
import { WeekCalendar } from '@/components/week-calendar';
import { useWeek, WeekNav } from '@/components/week-nav';
import { ZoneBanner } from '@/components/zone';
import { type Entry, useEntries, useTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, dayOf, dayToDate, hoursMinutes } from '@/lib/time';
import { workedAndPlanned } from '@/lib/timeline';
import { useNow } from '@/lib/use-now';
import { useZone } from '@/lib/zone';

type View = 'calendar' | 'list';

interface Search {
  /** Any day in the week to show; absent is this week. */
  day?: string;
  view?: View;
  /** Whose time; absent is the caller's. */
  person?: string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const Route = createFileRoute('/')({
  component: TimerPage,
  validateSearch: (search: Record<string, unknown>): Search => ({
    day: isDay(search.day) ? search.day : undefined,
    view: search.view === 'list' ? 'list' : undefined,
    person: typeof search.person === 'string' && search.person !== '' ? search.person : undefined,
  }),
});

/** The week's entries a day at a time, newest day first. */
function WeekList({
  week,
  entries,
  locked,
  personId,
}: {
  week: Day[];
  entries: Entry[];
  locked: boolean;
  /** Whose week; absent is the caller's. */
  personId?: string;
}) {
  const t = useTranslations('timer');
  const format = useFormatter();
  const { today } = useSession();
  const zone = useZone(personId);
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
            <DayHours entries={d.entries} />
          </div>
          <EntryList entries={d.entries} readOnly={locked} />
        </section>
      ))}
    </div>
  );
}

const spansOf = (entries: Entry[], now: number) =>
  entries.map((e) => ({ start: Date.parse(e.startedAt), end: e.endedAt ? Date.parse(e.endedAt) : now }));

/** A day's worked hours, and any still planned. */
function DayHours({ entries }: { entries: Entry[] }) {
  const tc = useTranslations('common');
  const tl = useTranslations('timeline');
  const now = Date.now();
  const { worked, planned } = workedAndPlanned(spansOf(entries, now), now);
  return (
    <span className="tabular text-sm font-medium">
      {tc('duration', hoursMinutes(worked))}
      {planned > 0 && (
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {tl('planned', { length: tc('duration', hoursMinutes(planned)) })}
        </span>
      )}
    </span>
  );
}

function TimerPage() {
  const t = useTranslations('timer');
  const te = useTranslations('entry');
  const tc = useTranslations('common');
  const periodLabel = usePeriodLabel();
  const me = useSession();
  const { today, running, settings } = me;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const week = useWeek(search.day);
  const first = week[0] ?? today;
  const last = week[6] ?? today;
  const view: View = search.view ?? 'calendar';
  // Someone else's week, for their manager or an admin; the server decides who may see it.
  const personId = search.person && search.person !== me.person.id ? search.person : undefined;
  const entries = useEntries(first, last, personId);
  const sheet = useTimesheet(undefined, personId);
  const [adding, setAdding] = useState(false);
  const now = useNow(30_000, !!running || (entries.data ?? []).some((e) => !e.endedAt)); // keeps the week's total current

  // The clock, and this period's days, are off while its timesheet is in.
  const period = sheet.data?.period;
  const s = sheet.data ? standing(sheet.data, me) : null;
  const submitted = sheet.data?.timesheet?.status === 'submitted' || sheet.data?.timesheet?.status === 'approved';
  // Someone else's time changes as their timesheet allows: not at all unless the caller may write it.
  const writable = !personId || !!s?.writer;
  const lockedDay = (day: Day) => !writable || (submitted && !!period && day >= period.start && day <= period.end);
  const { worked } = workedAndPlanned(spansOf(entries.data ?? [], now), now);
  const name = personId ? sheet.data?.person.name : undefined;

  return (
    <main className="flex min-h-full flex-col md:h-full md:min-h-0">
      <h1 className={personId ? 'px-4 pt-3 text-lg font-semibold' : 'sr-only'}>
        {name ? t('titleFor', { name }) : t('title')}
      </h1>
      {personId ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-2 text-sm text-muted-foreground">
          {/* The clock in the header stays the caller's; only the time below is theirs. */}
          {name && <span>{t('othersTime', { name })}</span>}
          <Link
            to="/"
            search={{ day: search.day, view: search.view }}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t('backToOwn')}
          </Link>
        </p>
      ) : (
        <ZoneBanner />
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <WeekNav
          week={week}
          ahead={settings.allowPlannedTime}
          onChange={(day) => navigate({ search: (s) => ({ ...s, day }), replace: true })}
        />
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-muted-foreground">{t('weekTotal')}</span>
          <span className="tabular text-base font-semibold">{tc('duration', hoursMinutes(worked))}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<View>
            label={t('view.label')}
            value={view}
            onChange={(v) => navigate({ search: (s) => ({ ...s, view: v === 'list' ? v : undefined }), replace: true })}
            options={[
              { value: 'calendar', label: t('view.calendar'), icon: <CalendarIcon aria-hidden /> },
              { value: 'list', label: t('view.list'), icon: <SchedulerIcon aria-hidden /> },
            ]}
          />
          <Button
            size="sm"
            className="h-8"
            icon={<AddIcon aria-hidden />}
            disabled={lockedDay(today) || (!!personId && !s)}
            onClick={() => setAdding(true)}
          >
            {te('add')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {entries.isError ? (
          <ErrorNote className="m-4" context={t('loadFailed')} error={entries.error} />
        ) : entries.isPending ? (
          <Loading />
        ) : view === 'calendar' ? (
          <WeekCalendar week={week} entries={entries.data} readOnly={lockedDay} personId={personId} />
        ) : (
          <WeekList
            week={week}
            entries={entries.data}
            locked={lockedDay(first) && lockedDay(last)}
            personId={personId}
          />
        )}
      </div>

      {/* Where this stands for payroll. */}
      {sheet.isError ? (
        <ErrorNote className="m-3" context={t('period.loadFailed')} error={sheet.error} />
      ) : (
        sheet.data && (
          <div className="bottom-0 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-t border-border bg-background px-4 py-2 text-sm md:sticky">
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
            {sheet.data.holiday > 0 && (
              <span className="flex items-baseline gap-1.5">
                <Hours value={sheet.data.holiday} strong />
                <span className="text-xs text-muted-foreground">{t('period.holiday')}</span>
              </span>
            )}
            <span className="ml-auto flex items-center gap-3">
              <SheetStatus timesheet={sheet.data.timesheet} reportsOnly={!sheet.data.person.submitsTimesheets} />
              <Link
                to="/timesheet"
                search={{ person: personId, day: search.day }}
                className={buttonClass('outline', 'sm')}
              >
                {t('period.open')}
              </Link>
            </span>
          </div>
        )
      )}
      <EntryDialog open={adding} onClose={() => setAdding(false)} day={today} personId={personId} />
    </main>
  );
}
