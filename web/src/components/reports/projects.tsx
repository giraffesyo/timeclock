import { DownloadIcon } from '@parallelworks/ui/icons';
import { Fragment } from 'react';
import { useTranslations } from 'use-intl';
import { apiUrl } from '@/api/client';
import { Button, buttonClass } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { Hours } from '@/components/hours';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { type ProjectHours, useProjectReport } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, type Day, daysBetween } from '@/lib/time';
import { ReportTable, rowLine, td, tdNum, th, thNum } from './shared';

interface ProjectGroup {
  id: string;
  name: string;
  code: string;
  billable: boolean;
  hours: number;
  people: ProjectHours[];
}

interface CustomerGroup {
  /** Time with no project is its own group, apart from any customer. */
  noProject: boolean;
  name: string;
  hours: number;
  projects: ProjectGroup[];
}

/** Customer, then project, then person, in the order the API sends; time with no project goes last. */
function group(rows: ProjectHours[]): CustomerGroup[] {
  const customers = new Map<string, CustomerGroup>();
  for (const r of rows) {
    const noProject = r.projectId === '';
    const key = noProject ? '' : `c:${r.customerName}`;
    let c = customers.get(key);
    if (!c) {
      c = { noProject, name: r.customerName, hours: 0, projects: [] };
      customers.set(key, c);
    }
    let p = c.projects.find((x) => x.id === r.projectId);
    if (!p) {
      p = { id: r.projectId, name: r.projectName, code: r.projectCode, billable: r.billable, hours: 0, people: [] };
      c.projects.push(p);
    }
    p.people.push(r);
    p.hours += r.hours;
    c.hours += r.hours;
  }
  return [...customers.values()].sort((a, b) => Number(a.noProject) - Number(b.noProject));
}

const monthStart = (day: Day): Day => `${day.slice(0, 7)}-01`;

/** Hours by customer, project and person over a range of days. */
export function ProjectsReport({ from, to, onRange }: { from: Day; to: Day; onRange: (from: Day, to: Day) => void }) {
  const t = useTranslations('reports.projects');
  const tc = useTranslations('common');
  const { today, period, admin, manager } = useSession();
  const report = useProjectReport(from, to);

  const length = daysBetween(period.start, period.end).length;
  const thisMonth = monthStart(today);
  const lastMonthEnd = addDays(thisMonth, -1);
  const quick: { label: string; from: Day; to: Day }[] = [
    { label: t('quick.thisPeriod'), from: period.start, to: period.end },
    // The same number of days, right before this period.
    { label: t('quick.lastPeriod'), from: addDays(period.start, -length), to: addDays(period.start, -1) },
    { label: t('quick.thisMonth'), from: thisMonth, to: addDays(monthStart(addDays(thisMonth, 32)), -1) },
    { label: t('quick.lastMonth'), from: monthStart(lastMonthEnd), to: lastMonthEnd },
  ];

  const rows = report.data ?? [];
  const groups = group(rows);
  const total = rows.reduce((n, r) => n + r.hours, 0);
  const billable = rows.reduce((n, r) => n + (r.billable ? r.hours : 0), 0);

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field label={t('from')}>
            <input
              type="date"
              className={controlClass}
              value={from}
              // A range never runs backwards: moving one end past the other brings the other along.
              onChange={(e) => e.target.value && onRange(e.target.value, e.target.value > to ? e.target.value : to)}
            />
          </Field>
          <Field label={t('to')}>
            <input
              type="date"
              className={controlClass}
              value={to}
              onChange={(e) => e.target.value && onRange(e.target.value < from ? e.target.value : from, e.target.value)}
            />
          </Field>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset's legend can't sit in this wrapping row */}
          <div role="group" aria-label={t('quick.label')} className="flex flex-wrap gap-1.5">
            {quick.map((q) => (
              <Button
                key={q.label}
                aria-pressed={q.from === from && q.to === to}
                className="aria-pressed:bg-muted"
                onClick={() => onRange(q.from, q.to)}
              >
                {q.label}
              </Button>
            ))}
          </div>
          <a
            href={apiUrl('/reports/projects.csv', { from, to })}
            download
            className={buttonClass('outline', 'md', 'ml-auto')}
          >
            <DownloadIcon aria-hidden />
            {t('export')}
          </a>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {admin ? t('scopeAll') : manager ? t('scopeReports') : t('scopeOwn')}
        </p>
      </Panel>

      {report.isError ? (
        <ErrorNote context={t('loadFailed')} error={report.error} />
      ) : report.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Panel flush>
          <Empty>{t('empty')}</Empty>
        </Panel>
      ) : (
        <Panel flush>
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-border px-4 py-3">
            <Stat label={t('total')} value={total} />
            <Stat label={t('billable')} value={billable} />
            <Stat label={t('notBillable')} value={total - billable} />
          </div>
          <ReportTable>
            <thead>
              <tr>
                <th scope="col" className={th}>
                  {t('columns.name')}
                </th>
                <th scope="col" className={th}>
                  {t('columns.billable')}
                </th>
                <th scope="col" className={thNum}>
                  {t('columns.hours')}
                </th>
              </tr>
            </thead>
            {groups.map((c) => (
              <tbody key={c.noProject ? '' : `c:${c.name}`}>
                <tr className="border-t border-border bg-muted/50">
                  <th scope="rowgroup" colSpan={2} className={`${td} text-left font-semibold`}>
                    {c.noProject ? tc('project.none') : c.name || t('noCustomer')}
                  </th>
                  <td className={tdNum}>
                    <Hours value={c.hours} strong />
                  </td>
                </tr>
                {c.projects.map((p) => (
                  <Fragment key={p.id}>
                    {!c.noProject && (
                      <tr className={rowLine}>
                        <th scope="row" className={`${td} pl-8 text-left font-medium`}>
                          {p.name}
                          {p.code && <span className="ml-2 text-xs font-normal text-muted-foreground">{p.code}</span>}
                        </th>
                        <td className={`${td} whitespace-nowrap text-muted-foreground`}>
                          {p.billable ? t('billable') : t('notBillable')}
                        </td>
                        <td className={tdNum}>
                          <Hours value={p.hours} strong />
                        </td>
                      </tr>
                    )}
                    {p.people.map((r) => (
                      <tr key={r.personId} className={rowLine}>
                        <td className={`${td} ${c.noProject ? 'pl-8' : 'pl-12'}`}>{r.personName}</td>
                        <td className={`${td} whitespace-nowrap text-muted-foreground`}>
                          {c.noProject ? t('notBillable') : null}
                        </td>
                        <td className={tdNum}>
                          <Hours value={r.hours} />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr className="border-t border-border font-medium">
                <th scope="row" colSpan={2} className={`${td} text-left font-semibold`}>
                  {t('total')}
                </th>
                <td className={tdNum}>
                  <Hours value={total} strong />
                </td>
              </tr>
            </tfoot>
          </ReportTable>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-24">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg">
        <Hours value={value} strong />
      </div>
    </div>
  );
}
