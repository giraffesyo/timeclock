import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { Empty, ErrorNote, Loading, Page, Panel } from '@/components/page';
import { PeriodNav, usePeriodLabel } from '@/components/period-nav';
import { PendingTimeOff, pendingRuns } from '@/components/team/pending-time-off';
import { TeamTable } from '@/components/team/team-table';
import { type PeriodSummary, usePendingTimeOff, usePeople, useTeam } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, type Day, dayToDate } from '@/lib/time';

export const Route = createFileRoute('/team')({
  component: TeamPage,
  validateSearch: (search: Record<string, unknown>): { day?: Day } => ({
    day: typeof search.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.day) ? search.day : undefined,
  }),
});

function Stat({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-36">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-0.5 text-lg font-semibold">{children}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** A count that asks for attention only when there is something to do. */
function Count({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-muted-foreground/60">–</span>;
  return <span className={value === 0 ? 'text-muted-foreground/60' : undefined}>{value}</span>;
}

function TeamPage() {
  const t = useTranslations('team');
  const { admin, manager } = useSession();
  if (!admin && !manager) {
    return (
      <Page title={t('title')}>
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t('notApprover')}</p>
            <Link to="/timesheet" className={buttonClass('outline', 'sm')}>
              {t('ownTimesheet')}
            </Link>
          </div>
        </Panel>
      </Page>
    );
  }
  return <Approvals />;
}

function Approvals() {
  const t = useTranslations('team');
  const format = useFormatter();
  const periodLabel = usePeriodLabel();
  const { person: me, admin, today } = useSession();
  const { day } = Route.useSearch();
  const navigate = Route.useNavigate();
  const team = useTeam(day);
  const pending = usePendingTimeOff();
  const people = usePeople();

  const show = (next: Day | undefined) => navigate({ search: (prev) => ({ ...prev, day: next }), replace: true });

  const period = team.data?.period;
  const members = team.data?.members ?? [];
  const ended = period ? period.end < today : false;
  // While the shown period is still open, the one before it is where late timesheets are.
  const previous = useTeam(period ? addDays(period.start, -1) : undefined, !!period && !ended);

  // A manager's own timesheet waits for someone else.
  const mine = (m: PeriodSummary) => admin || m.person.id !== me.id;
  const waitingIn = (list: PeriodSummary[]) =>
    list.filter((m) => m.timesheet?.status === 'submitted' && mine(m)).length;
  const missingIn = (list: PeriodSummary[]) =>
    list.filter((m) => !m.timesheet || m.timesheet.status === 'rejected').length;

  const runs = pendingRuns(pending.data ?? []);
  const names = new Map<string, string>();
  for (const p of people.data ?? []) names.set(p.id, p.name);
  for (const m of members) names.set(m.person.id, m.person.name);

  const shortDay = (d: Day) => format.dateTime(dayToDate(d), { month: 'short', day: 'numeric' });
  const previousMembers = previous.data?.members ?? [];
  const previousWaiting = waitingIn(previousMembers);
  const previousMissing = missingIn(previousMembers);

  return (
    <Page wide title={t('title')} actions={period && <PeriodNav period={period} today={today} onChange={show} />}>
      <div className="space-y-4">
        <Panel>
          <div className="flex flex-wrap gap-x-10 gap-y-3">
            <Stat label={t('needs.sheets')} hint={t('needs.sheetsHint')}>
              <Count value={team.data ? waitingIn(members) : undefined} />
            </Stat>
            <Stat
              label={t('needs.timeOff')}
              hint={pending.data ? t('needs.timeOffHint', { count: pending.data.length }) : undefined}
            >
              <Count value={pending.data ? runs.length : undefined} />
            </Stat>
            <Stat
              label={t('needs.missing')}
              hint={
                period &&
                (ended
                  ? t('needs.missingEnded', { date: shortDay(period.end) })
                  : t('needs.missingOpen', { date: shortDay(period.end) }))
              }
            >
              <Count value={team.data && ended ? missingIn(members) : undefined} />
            </Stat>
          </div>
          {previous.data && (previousWaiting > 0 || previousMissing > 0) && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <p className="text-sm">
                {t('needs.previous', {
                  period: periodLabel(previous.data.period),
                  waiting: previousWaiting,
                  missing: previousMissing,
                })}
              </p>
              <Button size="sm" onClick={() => show(previous.data.period.start)}>
                {t('needs.openPrevious')}
              </Button>
            </div>
          )}
        </Panel>

        <Panel flush title={t('timeOff.title')}>
          {pending.isError ? (
            <ErrorNote className="m-4" context={t('timeOff.loadFailed')} error={pending.error} />
          ) : pending.isPending ? (
            <Loading />
          ) : runs.length === 0 ? (
            <Empty>{t('timeOff.empty')}</Empty>
          ) : (
            <PendingTimeOff runs={runs} nameOf={(id) => names.get(id)} />
          )}
        </Panel>

        <Panel flush title={period ? periodLabel(period) : t('table.title')}>
          {team.isError ? (
            <ErrorNote className="m-4" context={t('loadFailed')} error={team.error} />
          ) : team.isPending ? (
            <Loading />
          ) : members.length === 0 ? (
            <Empty>{t('table.empty')}</Empty>
          ) : (
            <TeamTable members={members} />
          )}
        </Panel>
      </div>
    </Page>
  );
}
