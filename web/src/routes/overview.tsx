import { createFileRoute } from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Tooltip } from 'react-tooltip';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { Empty, ErrorNote, Loading, Page, Panel } from '@/components/page';
import { PersonIdentity } from '@/components/person-identity';
import { ProjectDot, useProjectName } from '@/components/project-select';
import { Segmented } from '@/components/segmented';
import { useWeek, WeekNav } from '@/components/week-nav';
import { cn } from '@/lib/cn';
import { type Activity, type DayProjectHours, type Person, useActivity, useHoursByDay, usePeople } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, dayToDate, decimalHours, stopwatch } from '@/lib/time';
import { projectHue } from '@/lib/timeline';
import { useNow } from '@/lib/use-now';

type Scope = 'mine' | 'team';

interface Search {
  /** Any day in the week to show; absent is this week. */
  day?: string;
  scope?: Scope;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const Route = createFileRoute('/overview')({
  component: OverviewPage,
  validateSearch: (search: Record<string, unknown>): Search => ({
    day: isDay(search.day) ? search.day : undefined,
    scope: search.scope === 'mine' ? 'mine' : undefined,
  }),
});

const DAY_TOOLTIP = 'day-chart';

const fill = (projectId: string) => (projectId ? ({ '--hue': projectHue(projectId) } as CSSProperties) : undefined);

/** A round number of hours at or above n, for the top of the chart. */
function ceiling(n: number): number {
  for (const step of [2, 4, 8, 10, 12, 16, 20, 24, 40, 60, 80, 100, 150, 200, 300, 400, 600, 800, 1000]) {
    if (n <= step) return step;
  }
  return Math.ceil(n / 500) * 500;
}

/** Hours per day, each bar stacked by project, largest project at the bottom. */
function DayChart({ week, rows, order }: { week: Day[]; rows: DayProjectHours[]; order: string[] }) {
  const t = useTranslations('overview.chart');
  const format = useFormatter();
  const { today } = useSession();
  const projectName = useProjectName();
  const days = week.map((day) => {
    const own = rows
      .filter((r) => r.day === day)
      .sort((a, b) => order.indexOf(a.projectId) - order.indexOf(b.projectId));
    return { day, rows: own, total: own.reduce((sum, r) => sum + r.hours, 0) };
  });
  const top = ceiling(Math.max(...days.map((d) => d.total), 1));
  const lines = [1, 0.75, 0.5, 0.25];
  // The project under the pointer: it stands out in every bar and in the tooltip.
  const [hovered, setHovered] = useState<string | null>(null);
  // Pointer only, so listened for natively: screen readers get each day in words below.
  const plot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const over = (e: MouseEvent) => {
      const slice = (e.target as Element).closest('[data-project]');
      setHovered(slice ? slice.getAttribute('data-project') : null);
    };
    const leave = () => setHovered(null);
    el.addEventListener('mouseover', over);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mouseover', over);
      el.removeEventListener('mouseleave', leave);
    };
  }, []);
  return (
    <figure className="m-0 flex flex-1 flex-col">
      <figcaption className="sr-only">{t('caption')}</figcaption>
      {/* Fills the panel, which its row may stretch past the chart's own height. */}
      <div className="grid min-h-56 flex-1 grid-cols-[2.25rem_minmax(0,1fr)] grid-rows-[minmax(14rem,1fr)_auto] gap-x-2">
        <div className="relative" aria-hidden>
          {lines.map((f) => (
            <span
              key={f}
              className="tabular absolute right-0 -translate-y-1/2 text-[0.6875rem] text-muted-foreground"
              style={{ top: `${(1 - f) * 100}%` }}
            >
              {Math.round(top * f * 10) / 10}
            </span>
          ))}
        </div>
        <div ref={plot} className="relative border-b border-border">
          {lines.map((f) => (
            <span
              key={f}
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-border/70"
              style={{ top: `${(1 - f) * 100}%` }}
            />
          ))}
          <ul className="relative grid h-full grid-cols-7 items-end gap-2 px-1 sm:gap-4 sm:px-3">
            {days.map((d) => (
              <li
                key={d.day}
                className="flex h-full flex-col justify-end"
                data-tooltip-id={d.total > 0 ? DAY_TOOLTIP : undefined}
                data-day={d.day}
              >
                <span className="sr-only">
                  {t('day', {
                    date: format.dateTime(dayToDate(d.day), { weekday: 'long', month: 'long', day: 'numeric' }),
                    hours: decimalHours(d.total),
                  })}
                </span>
                {d.total > 0 && (
                  <span aria-hidden className="tabular mb-1 text-center text-xs font-medium">
                    {decimalHours(d.total)}
                  </span>
                )}
                <div
                  aria-hidden
                  className="flex flex-col-reverse overflow-hidden rounded-t-md"
                  style={{ height: `${(d.total / top) * 100}%` }}
                >
                  {d.rows.map((r) => (
                    <span
                      key={r.projectId}
                      data-project={r.projectId}
                      data-highlighted={hovered === r.projectId || undefined}
                      className={cn(
                        'project-fill min-h-px w-full transition-opacity duration-150 ease-out',
                        !r.projectId && 'project-fill-none',
                        hovered !== null && hovered !== r.projectId && 'opacity-35',
                      )}
                      style={{ ...fill(r.projectId), flexGrow: r.hours, flexBasis: 0 }}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <span />
        <div className="grid grid-cols-7 gap-2 px-1 pt-1.5 sm:gap-4 sm:px-3" aria-hidden>
          {days.map((d) => (
            <span
              key={d.day}
              className={cn(
                'text-center text-xs',
                d.day === today ? 'font-semibold text-primary' : 'text-muted-foreground',
              )}
            >
              <span className="block">{format.dateTime(dayToDate(d.day), { weekday: 'short' })}</span>
              <span className="tabular block">
                {format.dateTime(dayToDate(d.day), { month: 'numeric', day: 'numeric' })}
              </span>
            </span>
          ))}
        </div>
      </div>
      <Tooltip
        id={DAY_TOOLTIP}
        className="config-tips z-[10000] text-left normal-case"
        opacity={1}
        place="right"
        render={({ activeAnchor }) => {
          const d = days.find((x) => x.day === activeAnchor?.getAttribute('data-day'));
          if (!d) return null;
          return (
            <div className="min-w-44 space-y-1.5">
              <p className="flex justify-between gap-4 font-medium">
                <span>{format.dateTime(dayToDate(d.day), { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                <span className="tabular">{t('total', { hours: decimalHours(d.total) })}</span>
              </p>
              <ul className="space-y-1">
                {[...d.rows].reverse().map((r) => (
                  <li
                    key={r.projectId}
                    data-highlighted={hovered === r.projectId || undefined}
                    className={cn(
                      '-mx-1.5 flex items-center gap-2 rounded px-1.5 transition-opacity duration-150',
                      hovered === r.projectId && 'bg-white/12 font-medium',
                      hovered !== null && hovered !== r.projectId && 'opacity-55',
                    )}
                  >
                    <ProjectDot projectId={r.projectId} />
                    <span className="min-w-0 flex-1 truncate">{projectName(r.projectId)}</span>
                    <span className="tabular">{t('total', { hours: decimalHours(r.hours) })}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      />
    </figure>
  );
}

/** How many projects show before the rest fold away, so the panel keeps to the chart's height. */
const PROJECTS_SHOWN = 8;

/** Projects by hours in the week, with each one's share. */
function ProjectShares({ totals, total }: { totals: { projectId: string; hours: number }[]; total: number }) {
  const t = useTranslations('overview.projects');
  const projectName = useProjectName();
  const format = useFormatter();
  const [all, setAll] = useState(false);
  const hidden = totals.length - PROJECTS_SHOWN;
  const shown = all || hidden <= 0 ? totals : totals.slice(0, PROJECTS_SHOWN);
  return (
    <>
      <ul className="space-y-3">
        {shown.map((p) => (
          <li key={p.projectId}>
            <div className="flex items-baseline gap-2 text-sm">
              <ProjectDot projectId={p.projectId} className="translate-y-[-1px]" />
              <span className="min-w-0 flex-1 truncate">{projectName(p.projectId)}</span>
              <span className="tabular font-medium">{decimalHours(p.hours)}</span>
              <span className="tabular w-10 text-right text-xs text-muted-foreground">
                {format.number(total ? p.hours / total : 0, { style: 'percent', maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className={cn('project-fill h-full rounded-full', !p.projectId && 'project-fill-none')}
                style={{ ...fill(p.projectId), width: `${total ? (p.hours / total) * 100 : 0}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="mt-3 -ml-2.5" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t('fewer') : t('more', { count: hidden })}
        </Button>
      )}
    </>
  );
}

/** Who is on the clock now, and on what. */
function Tracking({ people, directory }: { people: Activity[]; directory: Person[] }) {
  const t = useTranslations('overview.tracking');
  const projectName = useProjectName();
  const now = useNow(1000, people.length > 0);
  return (
    <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3">
      {people.map((p) => (
        <li key={p.person.id} className="flex items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1">
            <PersonIdentity person={p.person} people={directory} status="online" />
            {p.running && (
              <span className="flex items-center gap-1.5 pl-8 text-xs text-muted-foreground">
                <ProjectDot projectId={p.running.projectId} />
                <span className="truncate">{p.running.note || projectName(p.running.projectId)}</span>
              </span>
            )}
          </span>
          <span className="text-right">
            {p.running && (
              <span className="tabular block text-sm font-semibold text-success" role="timer">
                {stopwatch(Math.max(0, now - Date.parse(p.running.startedAt)))}
              </span>
            )}
            <span className="tabular block text-xs text-muted-foreground">
              {t('hours', { today: decimalHours(p.today), week: decimalHours(p.week) })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function OverviewPage() {
  const t = useTranslations('overview');
  const me = useSession();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const week = useWeek(search.day);
  const leads = me.admin || me.manager;
  const scope: Scope = leads ? (search.scope ?? 'team') : 'mine';
  const rows = useHoursByDay(week[0] ?? me.today, week[6] ?? me.today, scope === 'mine');
  const activity = useActivity();
  // The people the profile cards can name as managers.
  const people = usePeople(leads);
  const directory = [...(people.data ?? []), ...(activity.data ?? []).map((a) => a.person)];

  const byProject = new Map<string, number>();
  for (const r of rows.data ?? []) byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + r.hours);
  const totals = [...byProject].map(([projectId, hours]) => ({ projectId, hours })).sort((a, b) => b.hours - a.hours);
  const total = totals.reduce((sum, p) => sum + p.hours, 0);
  const running = (activity.data ?? []).filter((p) => p.running);
  // Who is on the clock is about now, so it shows with this week only.
  const thisWeek = week.includes(me.today);

  return (
    <Page
      wide
      title={t('title')}
      description={scope === 'team' ? t('descriptionTeam') : t('descriptionMine')}
      actions={
        <>
          {leads && (
            <Segmented<Scope>
              label={t('scope.label')}
              value={scope}
              onChange={(v) =>
                navigate({ search: (s) => ({ ...s, scope: v === 'mine' ? v : undefined }), replace: true })
              }
              options={[
                { value: 'team', label: t('scope.team') },
                { value: 'mine', label: t('scope.mine') },
              ]}
            />
          )}
          <WeekNav week={week} onChange={(day) => navigate({ search: (s) => ({ ...s, day }), replace: true })} />
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="flex flex-col lg:col-span-2"
          bodyClassName="flex flex-1 flex-col"
          title={t('chart.title')}
          actions={
            <span className="tabular text-sm font-semibold">{t('chart.total', { hours: decimalHours(total) })}</span>
          }
        >
          {rows.isError ? (
            <ErrorNote context={t('loadFailed')} error={rows.error} />
          ) : rows.isPending ? (
            <Loading />
          ) : (
            <DayChart week={week} rows={rows.data} order={totals.map((p) => p.projectId)} />
          )}
        </Panel>
        <Panel title={t('projects.title')}>
          {rows.isPending ? (
            <Loading />
          ) : totals.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('projects.empty')}</p>
          ) : (
            <ProjectShares totals={totals} total={total} />
          )}
        </Panel>
        {leads && thisWeek && (
          <Panel
            flush
            className="lg:col-span-3"
            title={t('tracking.title')}
            actions={
              activity.data && (
                <span className="text-xs text-muted-foreground">
                  {t('tracking.count', { tracking: running.length, people: activity.data.length })}
                </span>
              )
            }
          >
            {activity.isError ? (
              <ErrorNote className="m-4" context={t('tracking.loadFailed')} error={activity.error} />
            ) : activity.isPending ? (
              <Loading />
            ) : running.length === 0 ? (
              <Empty>{t('tracking.empty')}</Empty>
            ) : (
              <Tracking people={running} directory={directory} />
            )}
          </Panel>
        )}
      </div>
    </Page>
  );
}
