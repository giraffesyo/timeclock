import { ConfirmModal } from '@parallelworks/ui';
import { CheckIcon, DownloadIcon, WarningTriangleIcon } from '@parallelworks/ui/icons';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { apiUrl } from '@/api/client';
import { Button, buttonClass } from '@/components/button';
import { Hours } from '@/components/hours';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { PeriodNav } from '@/components/period-nav';
import { Chip, SheetStatus } from '@/components/status';
import { type PayrollRow, usePayroll } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { Day } from '@/lib/time';
import { ReportTable, rowLine, TimesheetLink, td, tdNum, textLink, th, thNum, useStickyPeriod } from './shared';

const total = (r: PayrollRow) => r.regular + r.overtime + r.vacation + r.sick + r.holiday;

/** Who is ready to be paid for a pay period, and the file that pays them. */
export function PayrollReport({ day, onDay }: { day?: Day; onDay: (day: Day | undefined) => void }) {
  const t = useTranslations('reports.payroll');
  const tr = useTranslations('reports');
  const tc = useTranslations('common');
  const format = useFormatter();
  const { today, period: current, settings } = useSession();
  const payroll = usePayroll(day);
  const period = useStickyPeriod(payroll.data?.period ?? (day ? undefined : current));
  const [confirming, setConfirming] = useState(false);

  const rows = payroll.data?.rows ?? [];
  const waiting = rows.filter((r) => !r.ready);
  const ready = rows.length - waiting.length;
  const noId = rows.filter((r) => !r.person.payrollId);
  const exportDay = payroll.data?.period.start;
  const sum = (pick: (r: PayrollRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const names = (list: PayrollRow[]) => format.list(list.map((r) => r.person.name));

  return (
    <div className="space-y-4">
      {period && <PeriodNav period={period} today={today} onChange={onDay} />}

      {payroll.isError ? (
        <ErrorNote context={t('loadFailed')} error={payroll.error} />
      ) : payroll.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Panel flush>
          <Empty>{t('empty')}</Empty>
        </Panel>
      ) : (
        <>
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="min-w-0 flex-1 basis-80 space-y-1.5 text-sm">
                {waiting.length === 0 ? (
                  <p className="text-base font-semibold">{t('allReady', { total: rows.length })}</p>
                ) : (
                  <>
                    <p className="text-base font-semibold">{t('ready', { ready, total: rows.length })}</p>
                    <div>
                      <span>{t('leftOut', { count: waiting.length })}</span>
                      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        {waiting.map((r) => (
                          <li key={r.person.id} className="flex items-center gap-1.5">
                            <TimesheetLink person={r.person.id} day={r.period.start}>
                              {r.person.name}
                            </TimesheetLink>
                            <span className="text-muted-foreground">
                              {tc(`sheet.${r.timesheet?.status ?? 'open'}`)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
                <p className="text-muted-foreground">
                  {settings.approveTimesheets ? t('readyApproved') : t('readySubmitted')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {waiting.length > 0 && (
                  <Button variant="ghost" onClick={() => setConfirming(true)}>
                    {t('export.everyone')}
                  </Button>
                )}
                {ready > 0 ? (
                  <a
                    href={apiUrl('/reports/payroll.csv', { day: exportDay })}
                    download
                    className={buttonClass('primary')}
                  >
                    <DownloadIcon aria-hidden />
                    {t('export.gusto')}
                  </a>
                ) : (
                  <Button variant="primary" disabled icon={<DownloadIcon aria-hidden />}>
                    {t('export.gusto')}
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              {ready === 0 ? t('export.noneReady') : t('export.explain')}
            </p>
            {noId.length > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                <WarningTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {t.rich('missingIds', {
                    count: noId.length,
                    names: names(noId),
                    link: (chunks) => (
                      <Link to="/settings" className={textLink}>
                        {chunks}
                      </Link>
                    ),
                  })}
                </span>
              </p>
            )}
          </Panel>

          <Panel flush>
            <ReportTable>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    {t('columns.person')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.payrollId')}
                  </th>
                  <th scope="col" className={thNum}>
                    {tc('columns.regular')}
                  </th>
                  <th scope="col" className={thNum}>
                    {tc('columns.overtime')}
                  </th>
                  <th scope="col" className={thNum}>
                    {tc('columns.vacation')}
                  </th>
                  <th scope="col" className={thNum}>
                    {tc('columns.sick')}
                  </th>
                  <th scope="col" className={thNum}>
                    {tc('columns.holiday')}
                  </th>
                  <th scope="col" className={thNum}>
                    {tc('columns.total')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.status')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.ready')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.person.id} className={rowLine}>
                    <th scope="row" className={`${td} text-left font-normal`}>
                      <TimesheetLink
                        person={r.person.id}
                        day={r.period.start}
                        label={tr('openTimesheetFor', { name: r.person.name })}
                        className="font-medium whitespace-nowrap hover:underline"
                      >
                        {r.person.name}
                      </TimesheetLink>
                      {(r.running || r.pendingTimeOff > 0) && (
                        <div className="mt-0.5 space-x-2 text-xs whitespace-nowrap text-muted-foreground">
                          {r.running && <span>{t('clockRunning')}</span>}
                          {r.pendingTimeOff > 0 && (
                            <span>{t('pendingTimeOff', { hours: format.number(r.pendingTimeOff) })}</span>
                          )}
                        </div>
                      )}
                    </th>
                    <td className={`${td} whitespace-nowrap`}>
                      {r.person.payrollId ? (
                        <span className="tabular">{r.person.payrollId}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-warning">
                          <WarningTriangleIcon className="size-3.5" aria-hidden />
                          {t('noPayrollId')}
                        </span>
                      )}
                    </td>
                    <td className={tdNum}>
                      <Hours value={r.regular} />
                    </td>
                    <td className={tdNum}>
                      <Hours value={r.overtime} />
                    </td>
                    <td className={tdNum}>
                      <Hours value={r.vacation} />
                    </td>
                    <td className={tdNum}>
                      <Hours value={r.sick} />
                    </td>
                    <td className={tdNum}>
                      <Hours value={r.holiday} />
                    </td>
                    <td className={tdNum}>
                      <Hours value={total(r)} strong />
                    </td>
                    <td className={td}>
                      <SheetStatus timesheet={r.timesheet} reportsOnly={!r.person.submitsTimesheets} />
                    </td>
                    <td className={td}>
                      {r.ready ? (
                        <Chip tone="success">
                          <CheckIcon className="size-3" aria-hidden />
                          {t('isReady')}
                        </Chip>
                      ) : (
                        <Chip tone="warning">{t('notReady')}</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/50 font-medium">
                  <th scope="row" colSpan={2} className={`${td} text-left font-medium`}>
                    {t('totals')}
                  </th>
                  <td className={tdNum}>
                    <Hours value={sum((r) => r.regular)} />
                  </td>
                  <td className={tdNum}>
                    <Hours value={sum((r) => r.overtime)} />
                  </td>
                  <td className={tdNum}>
                    <Hours value={sum((r) => r.vacation)} />
                  </td>
                  <td className={tdNum}>
                    <Hours value={sum((r) => r.sick)} />
                  </td>
                  <td className={tdNum}>
                    <Hours value={sum((r) => r.holiday)} />
                  </td>
                  <td className={tdNum}>
                    <Hours value={sum(total)} strong />
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </ReportTable>
          </Panel>
        </>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('export.confirmTitle')}
        description={t('export.confirmDescription', { count: waiting.length, names: names(waiting) })}
        confirmLabel={t('export.confirm')}
        cancelLabel={tc('cancel')}
        destructive
        onConfirm={() => {
          // The response is an attachment, so the browser saves it and stays on this page.
          window.location.assign(apiUrl('/reports/payroll.csv', { day: exportDay, all: 'true' }));
        }}
      />
    </div>
  );
}
