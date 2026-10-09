import { ChevronLeftIcon, ChevronRightIcon } from '@parallelworks/ui/icons';
import { createFileRoute } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { Empty, ErrorNote, Loading, Page, Panel } from '@/components/page';
import { RequestForm } from '@/components/time-off/request-form';
import { TimeOffList } from '@/components/time-off/time-off-list';
import { type TimeOff, useTimeOff } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, decimalHours } from '@/lib/time';

interface Search {
  /** The calendar year whose past time off to show; absent is this year. */
  year?: number;
}

export const Route = createFileRoute('/time-off')({
  component: TimeOffPage,
  validateSearch: (search: Record<string, unknown>): Search => {
    const year = Number(search.year);
    return { year: Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : undefined };
  },
});

/** Hours of each kind, leaving out what was rejected: it wasn't taken. */
function totals(items: TimeOff[]) {
  const sums = new Map<TimeOff['kind'], number>();
  for (const item of items) {
    if (item.status !== 'rejected') sums.set(item.kind, (sums.get(item.kind) ?? 0) + item.hours);
  }
  return [...sums].sort(([a], [b]) => a.localeCompare(b));
}

function TimeOffPage() {
  const t = useTranslations('timeOff');
  const tc = useTranslations('common');
  const { today } = useSession();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const thisYear = Number(today.slice(0, 4));
  const year = search.year && search.year < thisYear ? search.year : thisYear;
  const isThisYear = year === thisYear;
  const showYear = (y: number) => navigate({ search: { year: y === thisYear ? undefined : y }, replace: true });

  // What's planned, six months out whatever year it falls in; and one calendar
  // year's days before today, since that's what an allowance is counted against.
  const upcoming = useTimeOff(today, addDays(today, 183));
  const yearOff = useTimeOff(`${year}-01-01`, isThisYear ? today : `${year}-12-31`);

  const yearItems = (yearOff.data ?? []).filter((item) => item.day < today);
  const yearTotals = totals(yearItems);

  const yearNav = (
    <div className="flex items-center gap-1">
      {/* Before the arrows, so they stay put as it comes and goes. */}
      {!isThisYear && (
        <Button variant="outline" size="sm" onClick={() => showYear(thisYear)}>
          {t('list.thisYear')}
        </Button>
      )}
      <Button variant="ghost" size="sm" aria-label={t('list.previousYear')} onClick={() => showYear(year - 1)}>
        <ChevronLeftIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('list.nextYear')}
        disabled={isThisYear}
        onClick={() => showYear(year + 1)}
      >
        <ChevronRightIcon aria-hidden />
      </Button>
    </div>
  );

  return (
    <Page title={t('title')} description={t('description')}>
      <div className="space-y-4">
        <RequestForm />

        <Panel flush title={t('list.upcoming')}>
          {upcoming.isError ? (
            <ErrorNote className="m-4" context={t('list.loadFailed')} error={upcoming.error} />
          ) : upcoming.isPending ? (
            <Loading />
          ) : upcoming.data.length === 0 ? (
            <Empty>{t('list.emptyUpcoming')}</Empty>
          ) : (
            <TimeOffList items={upcoming.data} />
          )}
        </Panel>

        <Panel
          flush
          title={<span className="tabular">{isThisYear ? t('list.soFar', { year }) : t('list.year', { year })}</span>}
          actions={yearNav}
        >
          {yearOff.isError ? (
            <ErrorNote className="m-4" context={t('list.loadFailed')} error={yearOff.error} />
          ) : yearOff.isPending ? (
            <Loading />
          ) : yearItems.length === 0 ? (
            <Empty>{isThisYear ? t('list.emptySoFar') : t('list.emptyYear', { year })}</Empty>
          ) : (
            <>
              {yearTotals.length > 0 && (
                <dl className="flex flex-wrap gap-x-6 gap-y-1 border-b border-border px-4 py-2.5 text-sm">
                  {yearTotals.map(([kind, hours]) => (
                    <div key={kind} className="flex gap-2">
                      <dt className="text-muted-foreground">{tc(`kind.${kind}`)}</dt>
                      <dd className="tabular font-medium">{tc('hours', { hours: decimalHours(hours) })}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <TimeOffList items={yearItems} newestFirst />
            </>
          )}
        </Panel>
      </div>
    </Page>
  );
}
