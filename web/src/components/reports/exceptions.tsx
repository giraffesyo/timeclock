import { Avatar } from '@parallelworks/ui';
import { AlertCircleIcon, WarningTriangleIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { buttonClass } from '@/components/button';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { PeriodNav } from '@/components/period-nav';
import { Chip, type Tone } from '@/components/status';
import { cn } from '@/lib/cn';
import { type Exception, useExceptions, usePeople } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, dayToDate } from '@/lib/time';
import { TimesheetLink, useStickyPeriod } from './shared';

type Kind = Exception['kind'];
type Severity = 'blocking' | 'check';

/** Most pressing first: what keeps a person out of payroll, then what to check. Overtime is pay, not a problem, so it is not here. */
const order: Kind[] = [
  'clock_running',
  'rejected',
  'not_submitted',
  'awaiting_approval',
  'time_off_pending',
  'long_entry',
  'no_time',
];

const severity: Record<Kind, Severity> = {
  clock_running: 'blocking',
  rejected: 'blocking',
  not_submitted: 'blocking',
  awaiting_approval: 'blocking',
  time_off_pending: 'blocking',
  long_entry: 'check',
  no_time: 'check',
};

const tones: Record<Severity, Tone> = { blocking: 'danger', check: 'warning' };
const icons = { blocking: AlertCircleIcon, check: WarningTriangleIcon };

const rank = (kind: Kind) => order.indexOf(kind);

interface Group {
  id: string;
  name: string;
  items: Exception[];
}

/** One group per person, each sorted by severity; people with the most pressing exception first. */
function byPerson(exceptions: Exception[]): Group[] {
  const groups = new Map<string, Group>();
  for (const e of exceptions) {
    const g = groups.get(e.personId) ?? { id: e.personId, name: e.personName, items: [] };
    g.items.push(e);
    groups.set(e.personId, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => rank(a.kind) - rank(b.kind));
  const top = (g: Group) => rank(g.items[0]?.kind ?? 'no_time');
  return out.sort((a, b) => top(a) - top(b) || a.name.localeCompare(b.name));
}

/** What payroll should look at in a pay period, as sentences with what to do about each. */
export function ExceptionsReport({ day, onDay }: { day?: Day; onDay: (day: Day | undefined) => void }) {
  const t = useTranslations('reports.exceptions');
  const tr = useTranslations('reports');
  const format = useFormatter();
  const { today, period: current, admin, manager } = useSession();
  const exceptions = useExceptions(day);
  const people = usePeople(admin || manager);
  const avatarOf = (id: string) => people.data?.find((p) => p.id === id)?.avatarUrl;
  const period = useStickyPeriod(exceptions.data?.period ?? (day ? undefined : current));
  const [chosen, setChosen] = useState<Kind | 'all'>('all');

  const all = exceptions.data?.exceptions ?? [];
  const counts = new Map<Kind, number>();
  for (const e of all) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const kinds = order.filter((k) => counts.has(k));
  // A kind chosen in one period may not occur in the next.
  const filter = chosen !== 'all' && counts.has(chosen) ? chosen : 'all';
  const groups = byPerson(filter === 'all' ? all : all.filter((e) => e.kind === filter));
  const linkDay = period?.start ?? day ?? today;

  const sentence = (e: Exception) =>
    t(`sentence.${e.kind}`, {
      hours: format.number(e.hours ?? 0, { maximumFractionDigits: 2 }),
      day: e.day ? format.dateTime(dayToDate(e.day), { weekday: 'short', month: 'short', day: 'numeric' }) : '',
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {period && <PeriodNav period={period} today={today} onChange={onDay} />}
        <p className="text-sm text-muted-foreground">{admin ? t('scopeAll') : t('scopeReports')}</p>
      </div>

      {exceptions.isError ? (
        <ErrorNote context={t('loadFailed')} error={exceptions.error} />
      ) : exceptions.isPending ? (
        <Loading />
      ) : all.length === 0 ? (
        <Panel flush>
          <Empty>{t('empty')}</Empty>
        </Panel>
      ) : (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset's legend can't sit in this wrapping row */}
          <div role="group" aria-label={t('filter.label')} className="flex flex-wrap gap-1.5">
            <FilterChip pressed={filter === 'all'} count={all.length} onClick={() => setChosen('all')}>
              {t('filter.all')}
            </FilterChip>
            {kinds.map((k) => (
              <FilterChip
                key={k}
                pressed={filter === k}
                count={counts.get(k) ?? 0}
                onClick={() => setChosen(filter === k ? 'all' : k)}
              >
                {t(`kind.${k}`)}
              </FilterChip>
            ))}
          </div>

          <div className="space-y-3">
            {groups.map((g) => (
              <Panel
                key={g.id}
                flush
                title={
                  <span className="flex items-center gap-2">
                    <Avatar src={avatarOf(g.id)} name={g.name} size="sm" className="shrink-0" />
                    {g.name}
                  </span>
                }
                actions={
                  <>
                    <span className="text-xs text-muted-foreground">{t('count', { count: g.items.length })}</span>
                    <TimesheetLink
                      person={g.id}
                      day={linkDay}
                      className={buttonClass('outline', 'sm')}
                      label={tr('openTimesheetFor', { name: g.name })}
                    >
                      {tr('openTimesheet')}
                    </TimesheetLink>
                  </>
                }
              >
                <ul className="divide-y divide-border">
                  {g.items.map((e) => {
                    const level = severity[e.kind];
                    const Icon = icons[level];
                    return (
                      <li
                        key={`${e.kind}-${e.entryId ?? ''}`}
                        className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                      >
                        <div className="min-w-0 flex-1 basis-64">
                          <p>{sentence(e)}</p>
                          <p className="text-muted-foreground">{t(`action.${e.kind}`)}</p>
                        </div>
                        <Chip tone={tones[level]}>
                          <Icon className="size-3" aria-hidden />
                          {t(`severity.${level}`)}
                        </Chip>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FilterChip({
  pressed,
  count,
  onClick,
  children,
}: {
  pressed: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
        pressed
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
      <span className="tabular">{count}</span>
    </button>
  );
}
