import { AddIcon, StartIcon, StopSolidIcon } from '@parallelworks/ui/icons';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { DayTimeline } from '@/components/day-timeline';
import { EntryDialog } from '@/components/entry-dialog';
import { EntryList } from '@/components/entry-list';
import { controlClass } from '@/components/field';
import { Hours } from '@/components/hours';
import { Empty, ErrorNote, Loading, Page, Panel } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { ProjectSelect, useProjectName } from '@/components/project-select';
import { SheetStatus } from '@/components/status';
import { useClockIn, useClockOut, useEntries, useTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { dayToDate, elapsed, msToHours, stopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';

export const Route = createFileRoute('/')({ component: TodayPage });

/** The clock: the one thing most people come here to do. */
function Clock({ locked }: { locked: boolean }) {
  const t = useTranslations('today.clock');
  const format = useFormatter();
  const { running, settings } = useSession();
  const projectName = useProjectName();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const now = useNow(1000, !!running);

  if (running) {
    return (
      <Panel>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="tabular text-4xl font-semibold tracking-tight" role="timer">
            {stopwatch(Math.max(0, now - Date.parse(running.startedAt)))}
          </div>
          <div className="order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-auto">
            <div className="truncate text-sm font-medium">{projectName(running.projectId)}</div>
            <div className="text-sm text-muted-foreground">
              {t('since', {
                time: format.dateTime(new Date(running.startedAt), {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: settings.timezone,
                }),
              })}
              {running.note && ` · ${running.note}`}
            </div>
          </div>
          <Button
            variant="primary"
            className="ml-auto h-10 px-5 text-base"
            loading={clockOut.isPending}
            icon={<StopSolidIcon aria-hidden />}
            onClick={() => clockOut.mutate()}
          >
            {t('out')}
          </Button>
        </div>
        {clockOut.isError && <ErrorNote className="mt-3" context={t('outFailed')} error={clockOut.error} />}
      </Panel>
    );
  }

  return (
    <Panel>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          clockIn.mutate({ projectId: projectId || undefined, note }, { onSuccess: () => setNote('') });
        }}
      >
        <ProjectSelect
          value={projectId}
          onChange={setProjectId}
          required={settings.requireProject}
          disabled={locked}
          className="h-10 w-full sm:w-64"
        />
        <input
          className={`${controlClass} h-10 min-w-40 flex-1`}
          value={note}
          placeholder={t('notePlaceholder')}
          aria-label={t('notePlaceholder')}
          disabled={locked}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="submit"
          className={buttonClass('primary', 'md', 'h-10 px-5 text-base')}
          disabled={locked || clockIn.isPending}
        >
          <StartIcon aria-hidden />
          {t('in')}
        </button>
      </form>
      {locked && <p className="mt-3 text-sm text-muted-foreground">{t('locked')}</p>}
      {clockIn.isError && <ErrorNote className="mt-3" context={t('inFailed')} error={clockIn.error} />}
    </Panel>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-24">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg">{children}</div>
    </div>
  );
}

function TodayPage() {
  const t = useTranslations('today');
  const te = useTranslations('entry');
  const format = useFormatter();
  const periodLabel = usePeriodLabel();
  const { today, running } = useSession();
  const entries = useEntries(today, today);
  const sheet = useTimesheet();
  const [adding, setAdding] = useState(false);
  useNow(30_000, !!running); // keeps today's total current while the clock runs

  const locked = sheet.data?.timesheet?.status === 'submitted' || sheet.data?.timesheet?.status === 'approved';
  // Today's total counts the running clock; the period's figures don't until it stops.
  const todayHours = msToHours((entries.data ?? []).reduce((sum, e) => sum + elapsed(e.startedAt, e.endedAt), 0));

  return (
    <Page
      title={t('title')}
      description={format.dateTime(dayToDate(today), { weekday: 'long', month: 'long', day: 'numeric' })}
    >
      <div className="space-y-4">
        <Clock locked={locked} />

        <Panel>
          {sheet.isError ? (
            <ErrorNote context={t('summary.loadFailed')} error={sheet.error} />
          ) : (
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <Stat label={t('summary.today')}>
                <Hours value={todayHours} strong />
              </Stat>
              <Stat label={t('summary.period')}>
                <Hours value={(sheet.data?.regular ?? 0) + (sheet.data?.overtime ?? 0)} strong />
              </Stat>
              <Stat label={t('summary.overtime')}>
                <Hours value={sheet.data?.overtime ?? 0} strong />
              </Stat>
              <Stat label={t('summary.timeOff')}>
                <Hours value={(sheet.data?.vacation ?? 0) + (sheet.data?.sick ?? 0)} strong />
              </Stat>
              <div className="ml-auto flex items-center gap-3">
                {sheet.data && <span className="text-sm text-muted-foreground">{periodLabel(sheet.data.period)}</span>}
                <SheetStatus timesheet={sheet.data?.timesheet} />
                <Link to="/timesheet" className={buttonClass('outline', 'sm')}>
                  {t('summary.open')}
                </Link>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          flush
          title={t('entries.title')}
          actions={
            <Button size="sm" icon={<AddIcon aria-hidden />} disabled={locked} onClick={() => setAdding(true)}>
              {te('add')}
            </Button>
          }
        >
          {entries.isError ? (
            <ErrorNote className="m-4" context={t('entries.loadFailed')} error={entries.error} />
          ) : entries.isPending ? (
            <Loading />
          ) : (
            <>
              <div className="p-4">
                <DayTimeline day={today} entries={entries.data} readOnly={locked} />
              </div>
              <div className="border-t border-border">
                {entries.data.length === 0 ? <Empty>{t('entries.empty')}</Empty> : <EntryList entries={entries.data} />}
              </div>
            </>
          )}
        </Panel>
      </div>
      <EntryDialog open={adding} onClose={() => setAdding(false)} day={today} />
    </Page>
  );
}
