import { ConfirmModal } from '@parallelworks/ui';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Field, textareaClass } from '@/components/field';
import { Hours } from '@/components/hours';
import { ErrorNote } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { totalHours } from '@/components/timesheet/sheet';
import { type PeriodSummary, useDecideTimesheet, useReopenTimesheet, useSubmitTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { dayToDate } from '@/lib/time';

/**
 * What can be done to a timesheet behind a confirmation: submit it, approve
 * it, send a waiting one back, or reopen an approved one.
 */
export type SheetAction = 'submit' | 'approve' | 'sendBack' | 'reopen';

/** The hours the decision is about, so no one confirms blind. */
function Totals({ summary }: { summary: PeriodSummary }) {
  const t = useTranslations('timesheet.dialog');
  const tc = useTranslations('common.columns');
  const periodLabel = usePeriodLabel();
  const figures = [
    [tc('regular'), summary.regular],
    [tc('overtime'), summary.overtime],
    [tc('vacation'), summary.vacation],
    [tc('sick'), summary.sick],
    [tc('total'), totalHours(summary)],
  ] as const;
  return (
    <div className="rounded-md border border-border text-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="text-muted-foreground">{t('period')}</span>
        <span className="tabular font-medium">{periodLabel(summary.period)}</span>
      </div>
      <dl className="grid grid-cols-5 gap-2 px-3 py-2">
        {figures.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="truncate text-xs text-muted-foreground">{label}</dt>
            <dd>
              <Hours value={value} strong />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Confirms one action on a timesheet. Mount it only while it is open. */
export function SheetDialog({
  action,
  summary,
  own,
  onClose,
}: {
  action: SheetAction;
  summary: PeriodSummary;
  own: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('timesheet.dialog');
  const { settings, today } = useSession();
  const format = useFormatter();
  const submit = useSubmitTimesheet();
  const decide = useDecideTimesheet();
  const reopen = useReopenTimesheet();
  const [note, setNote] = useState('');

  const name = summary.person.name;
  const id = summary.timesheet?.id;
  const needsNote = action === 'sendBack' || (action === 'reopen' && !own);
  const showsNote = action === 'sendBack' || action === 'reopen';

  const run = async () => {
    try {
      if (action === 'submit') {
        await submit.mutateAsync({ day: summary.period.start, personId: own ? undefined : summary.person.id });
      } else if (!id) {
        return;
      } else if (action === 'approve') {
        await decide.mutateAsync({ id, approve: true });
      } else if (action === 'sendBack') {
        await decide.mutateAsync({ id, approve: false, note: note.trim() });
      } else {
        await reopen.mutateAsync({ id, note: note.trim() });
      }
      onClose();
    } catch {
      // Shown below from the mutation's error; the dialog stays open.
    }
  };

  const waits = settings.approveTimesheets;
  const copy = {
    submit: {
      title: own ? t('submitTitle') : t('submitForTitle', { name }),
      description: own
        ? waits
          ? t('submitWaits')
          : t('submitFinal')
        : waits
          ? t('submitForWaits', { name })
          : t('submitForFinal', { name }),
      confirm: t('submitConfirm'),
      failed: t('submitFailed'),
      error: submit.error,
    },
    approve: {
      title: t('approveTitle', { name }),
      description: t('approveDescription'),
      confirm: t('approveConfirm'),
      failed: t('approveFailed'),
      error: decide.error,
    },
    sendBack: {
      title: t('sendBackTitle', { name }),
      description: t('sendBackDescription', { name }),
      confirm: t('sendBackConfirm'),
      failed: t('sendBackFailed'),
      error: decide.error,
    },
    reopen: {
      title: t('reopenTitle'),
      description: t('reopenDescription', { own: String(own), name }),
      confirm: t('sendBackConfirm'),
      failed: t('sendBackFailed'),
      error: reopen.error,
    },
  }[action];

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      confirmDisabled={needsNote && note.trim() === ''}
      destructive={action === 'reopen'}
      closeOnConfirm={false}
      onConfirm={run}
    >
      <div className="space-y-3">
        <Totals summary={summary} />
        {action === 'submit' && summary.period.end >= today && (
          <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
            {t('submitEarly', {
              end: format.dateTime(dayToDate(summary.period.end), { weekday: 'long', month: 'short', day: 'numeric' }),
            })}
          </p>
        )}
        {showsNote && (
          <Field label={t('noteLabel')} hint={needsNote ? t('noteHint') : undefined}>
            <textarea
              className={textareaClass}
              rows={3}
              value={note}
              required={needsNote}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        )}
        {copy.error ? <ErrorNote context={copy.failed} error={copy.error} /> : null}
      </div>
    </ConfirmModal>
  );
}
