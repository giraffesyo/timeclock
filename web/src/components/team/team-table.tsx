import { TOOLTIP_ID } from '@parallelworks/ui';
import { ClockIcon } from '@parallelworks/ui/icons';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { Hours } from '@/components/hours';
import { usePeriodLabel } from '@/components/period-nav';
import { SheetStatus } from '@/components/status';
import { useHoursText } from '@/components/time-off/runs';
import { type PeriodSummary, useDecideTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { DecisionDialog } from './decision-dialog';

/** Worked and approved time off hours: what the timesheet states. */
export function totalHours(m: PeriodSummary): number {
  return m.regular + m.overtime + m.vacation + m.sick;
}

const th = 'px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground';
const num = 'px-3 py-2 text-right';

/**
 * One pay period, a row per person: their hours, where their timesheet
 * stands, and the decision when it waits for the caller.
 */
export function TeamTable({ members }: { members: PeriodSummary[] }) {
  const t = useTranslations('team.table');
  const ts = useTranslations('team.sheet');
  const tn = useTranslations('team.note');
  const tc = useTranslations('common.columns');
  const periodLabel = usePeriodLabel();
  const hoursText = useHoursText();
  const { person: me, admin } = useSession();
  const decide = useDecideTimesheet();
  const [target, setTarget] = useState<{ member: PeriodSummary; approve: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  const ask = (member: PeriodSummary, approve: boolean) => {
    setTarget({ member, approve });
    setOpen(true);
  };

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-3xl border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className={`${th} pl-4`}>
                {t('person')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {tc('regular')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {tc('overtime')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {tc('vacation')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {tc('sick')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {tc('total')}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t('pendingTimeOff')}
              </th>
              <th scope="col" className={th}>
                {t('status')}
              </th>
              <th scope="col" className={`${th} pr-4 text-right`}>
                {t('decide')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => {
              const own = m.person.id === me.id;
              const waiting = m.timesheet?.status === 'submitted';
              return (
                <tr key={m.person.id} className="hover:bg-muted/50">
                  <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Link
                        to="/timesheet"
                        search={{ person: m.person.id, day: m.period.start }}
                        aria-label={t('openSheet', { name: m.person.name })}
                        className="rounded-sm font-medium hover:underline"
                      >
                        {m.person.name}
                      </Link>
                      {own && <span className="text-xs text-muted-foreground">{t('you')}</span>}
                      {m.running && (
                        <span
                          className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-success"
                          data-tooltip-id={TOOLTIP_ID}
                          data-tooltip-content={t('runningHint')}
                        >
                          <ClockIcon className="size-3.5" aria-hidden />
                          {t('running')}
                        </span>
                      )}
                    </div>
                  </th>
                  <td className={num}>
                    <Hours value={m.regular} />
                  </td>
                  <td className={num}>
                    <Hours value={m.overtime} />
                  </td>
                  <td className={num}>
                    <Hours value={m.vacation} />
                  </td>
                  <td className={num}>
                    <Hours value={m.sick} />
                  </td>
                  <td className={num}>
                    <Hours value={totalHours(m)} strong />
                  </td>
                  <td className={num}>
                    <Hours value={m.pendingTimeOff} />
                  </td>
                  <td className="px-3 py-2">
                    <SheetStatus timesheet={m.timesheet} reportsOnly={!m.person.submitsTimesheets} />
                    {m.timesheet?.status === 'rejected' && m.timesheet.decisionNote && (
                      <div className="mt-1 max-w-56 truncate text-xs text-muted-foreground">
                        {t('sentBackNote', { note: m.timesheet.decisionNote })}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-4 pl-3">
                    {waiting &&
                      (own && !admin ? (
                        <p className="text-right text-xs text-muted-foreground">{t('own')}</p>
                      ) : (
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="primary" onClick={() => ask(m, true)}>
                            {t('approve')}
                          </Button>
                          <Button size="sm" onClick={() => ask(m, false)}>
                            {t('sendBack')}
                          </Button>
                        </div>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={target ? ts(target.approve ? 'approveTitle' : 'sendBackTitle', { name: target.member.person.name }) : ''}
        description={
          target
            ? target.approve
              ? ts('approveDescription', {
                  period: periodLabel(target.member.period),
                  total: hoursText(totalHours(target.member)),
                })
              : ts('sendBackDescription', { period: periodLabel(target.member.period) })
            : null
        }
        confirmLabel={target?.approve ? t('approve') : t('sendBack')}
        destructive={target ? !target.approve : false}
        note={target?.approve ? 'none' : 'required'}
        notePlaceholder={tn('sendBackPlaceholder')}
        errorContext={ts('failed')}
        onConfirm={async (note) => {
          const id = target?.member.timesheet?.id;
          if (!target || !id) return;
          await decide.mutateAsync({ id, approve: target.approve, note: note || undefined });
        }}
      />
    </>
  );
}
