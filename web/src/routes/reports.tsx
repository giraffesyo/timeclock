import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Page } from '@/components/page';
import { ExceptionsReport } from '@/components/reports/exceptions';
import { PayrollReport } from '@/components/reports/payroll';
import { ProjectsReport } from '@/components/reports/projects';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';
import type { Day } from '@/lib/time';

const tabs = ['payroll', 'exceptions', 'projects'] as const;
type Tab = (typeof tabs)[number];

interface Search {
  tab?: Tab;
  /** Any day in the pay period the payroll and exceptions reports show. */
  day?: Day;
  /** The project report's range. */
  from?: Day;
  to?: Day;
}

const day = (v: unknown): Day | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

export const Route = createFileRoute('/reports')({
  component: ReportsPage,
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: tabs.find((t) => t === s.tab),
    day: day(s.day),
    from: day(s.from),
    to: day(s.to),
  }),
});

function ReportsPage() {
  const t = useTranslations('reports');
  const { admin, manager, period } = useSession();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  // The server scopes every report; the tabs only leave out what the caller can't open.
  const allowed: Tab[] = admin
    ? ['payroll', 'exceptions', 'projects']
    : manager
      ? ['exceptions', 'projects']
      : ['projects'];
  const tab = search.tab && allowed.includes(search.tab) ? search.tab : (allowed[0] ?? 'projects');

  const setDay = (next: Day | undefined) => navigate({ search: (prev) => ({ ...prev, day: next }), replace: true });

  return (
    <Page title={t('title')}>
      {allowed.length > 1 && (
        <nav aria-label={t('tabs.label')} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
          {allowed.map((name) => (
            <Link
              key={name}
              from="/reports"
              to="/reports"
              search={(prev) => ({ ...prev, tab: name })}
              aria-current={name === tab ? 'page' : undefined}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                name === tab
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`tabs.${name}`)}
            </Link>
          ))}
        </nav>
      )}

      {tab === 'payroll' && <PayrollReport day={search.day} onDay={setDay} />}
      {tab === 'exceptions' && <ExceptionsReport day={search.day} onDay={setDay} />}
      {tab === 'projects' && (
        <ProjectsReport
          from={search.from ?? period.start}
          to={search.to ?? period.end}
          onRange={(from, to) => navigate({ search: (prev) => ({ ...prev, from, to }), replace: true })}
        />
      )}
    </Page>
  );
}
