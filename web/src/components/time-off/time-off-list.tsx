import { ConfirmModal, TOOLTIP_ID } from '@parallelworks/ui';
import { LockIcon, TrashIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { ErrorNote } from '@/components/page';
import { TimeOffStatus } from '@/components/status';
import { type TimeOff, useCancelTimeOff } from '@/lib/queries';
import { decimalHours } from '@/lib/time';
import { groupRuns, type Run, useDayLabel, useHoursText } from './runs';

/** Days belong to one run when they'd read the same: kind, status and both notes. */
const alike = (t: TimeOff) => [t.kind, t.status, t.note, t.decisionNote ?? ''].join('\u0000');

/**
 * The caller's time off as runs of consecutive days. A run states its kind,
 * status and notes once; each day in it keeps its own hours and can be removed
 * on its own, since each is its own record.
 */
export function TimeOffList({ items, newestFirst }: { items: TimeOff[]; newestFirst?: boolean }) {
  const t = useTranslations('timeOff.list');
  const tc = useTranslations('common');
  const label = useDayLabel();
  const hoursText = useHoursText();
  const cancel = useCancelTimeOff();
  const [removing, setRemoving] = useState<TimeOff | null>(null);

  const runs = groupRuns(items, alike);
  if (newestFirst) runs.reverse();

  const removeButton = (item: TimeOff) =>
    item.locked ? (
      <span
        className="flex w-7 justify-center text-muted-foreground"
        role="img"
        aria-label={t('locked')}
        data-tooltip-id={TOOLTIP_ID}
        data-tooltip-content={t('locked')}
      >
        <LockIcon className="size-3.5" aria-hidden />
      </span>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('removeDay', { day: label.day(item.day) })}
        onClick={() => setRemoving(item)}
      >
        <TrashIcon aria-hidden />
      </Button>
    );

  const runItem = (run: Run) => {
    const multi = run.days.length > 1;
    const { first } = run;
    return (
      <li key={run.id} className="px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="tabular text-sm font-medium sm:min-w-52">{label.range(first.day, run.last.day)}</span>
          <span className="text-sm">{tc(`kind.${first.kind}`)}</span>
          <TimeOffStatus status={first.status} />
          {multi && <span className="text-sm text-muted-foreground">{t('days', { count: run.days.length })}</span>}
          <span className="tabular ml-auto text-sm font-medium">{tc('hours', { hours: decimalHours(run.hours) })}</span>
          {!multi && removeButton(first)}
        </div>
        {first.note && <p className="mt-1 text-xs text-muted-foreground">{first.note}</p>}
        {first.decisionNote && (
          <p className="mt-1 text-xs">
            <span className="font-medium">{t('decisionNote')}</span> {first.decisionNote}
          </p>
        )}
        {multi && (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {run.days.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-1 pr-1 pl-3 text-sm">
                <span className="tabular min-w-0 flex-1">{label.day(item.day)}</span>
                <span className="tabular text-muted-foreground">
                  {tc('hours', { hours: decimalHours(item.hours) })}
                </span>
                {removeButton(item)}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <ul className="divide-y divide-border">{runs.map(runItem)}</ul>
      <ConfirmModal
        open={!!removing}
        onClose={() => {
          setRemoving(null);
          cancel.reset();
        }}
        title={t('removeTitle')}
        description={
          removing
            ? t('removeDescription', {
                hours: hoursText(removing.hours),
                kind: tc(`kind.${removing.kind}`),
                day: label.day(removing.day),
              })
            : null
        }
        confirmLabel={t('remove')}
        destructive
        closeOnConfirm={false}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await cancel.mutateAsync(removing.id);
            setRemoving(null);
          } catch {
            // Shown below from cancel.error: a day in a submitted timesheet is locked.
          }
        }}
      >
        {cancel.isError ? <ErrorNote context={t('removeFailed')} error={cancel.error} /> : null}
      </ConfirmModal>
    </>
  );
}
