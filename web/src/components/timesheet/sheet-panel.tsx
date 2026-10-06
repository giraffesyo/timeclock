import { CheckIcon, LockIcon, RollbackIcon, SendIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { ErrorNote, Panel } from '@/components/page';
import { SheetStatus } from '@/components/status';
import type { Standing } from '@/components/timesheet/sheet';
import { type SheetAction, SheetDialog } from '@/components/timesheet/sheet-dialog';
import { type PeriodSummary, usePeople, useReopenTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { useZone } from '@/lib/zone';

/** Who submitted or decided the sheet and when, in a sentence. */
function useHistory(summary: PeriodSummary): string | null {
  const t = useTranslations('timesheet.status');
  const format = useFormatter();
  const me = useSession();
  const zone = useZone();
  // Only admins and managers can list people; everyone else gets the general wording.
  const people = usePeople(me.admin || me.manager);
  const ts = summary.timesheet;
  if (!ts) return null;

  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    });
  const who = (id: string) =>
    id === me.person.id
      ? t('you')
      : id === summary.person.id
        ? summary.person.name
        : (people.data?.find((p) => p.id === id)?.name ?? (ts.decidedByName || t('someone')));

  if (ts.status === 'submitted') return t('submitted', { when: when(ts.submittedAt) });
  const decidedAt = when(ts.decidedAt ?? ts.submittedAt);
  if (ts.status === 'approved') {
    return ts.decidedBy
      ? t('approvedBy', { who: who(ts.decidedBy), when: decidedAt })
      : t('autoApproved', { when: when(ts.submittedAt) });
  }
  if (ts.decidedBy === summary.person.id) {
    return ts.decidedBy === me.person.id
      ? t('takenBackOwn', { when: decidedAt })
      : t('takenBack', { name: summary.person.name, when: decidedAt });
  }
  return t('sentBackBy', { who: ts.decidedBy ? who(ts.decidedBy) : t('someone'), when: decidedAt });
}

/** What the state means for the person looking, in words. */
function useHint(summary: PeriodSummary, s: Standing): string {
  const t = useTranslations('timesheet.hint');
  const { admin } = useSession();
  const name = summary.person.name;
  if (!s.writer && !s.locked) return t('inactive', { name });
  switch (s.status) {
    case 'submitted':
      return s.own ? t('submittedOwn') : s.decider ? t('submittedDecider', { name }) : t('submittedViewer');
    case 'approved':
      if (!s.own) return s.decider ? t('approvedDecider', { name }) : t('approvedViewer');
      if (admin) return t('approvedOwnAdmin');
      return summary.person.managerId ? t('approvedOwnManager') : t('approvedOwnNoManager');
    case 'rejected':
      if (s.notStarted) return t('notStarted');
      return s.own ? t('rejectedOwn') : t('rejectedOther', { name });
    default:
      if (!s.submits) return s.own ? t('reportsOnlyOwn') : t('reportsOnlyOther', { name });
      if (s.notStarted) return t('notStarted');
      return s.own ? t('openOwn') : t('openOther', { name });
  }
}

/**
 * Where the timesheet stands, who decided it, and what the caller can do
 * about it. The server enforces every rule; this offers only what it allows.
 */
export function SheetPanel({ summary, standing: s }: { summary: PeriodSummary; standing: Standing }) {
  const t = useTranslations('timesheet');
  const history = useHistory(summary);
  const hint = useHint(summary, s);
  const takeBack = useReopenTimesheet();
  const [action, setAction] = useState<SheetAction | null>(null);

  const ts = summary.timesheet;
  const name = summary.person.name;
  const unsubmitted = s.status === 'open' || s.status === 'rejected';
  const sentBack = s.status === 'rejected' && ts?.decidedBy !== summary.person.id;

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-72 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <SheetStatus timesheet={ts} reportsOnly={!s.submits} />
            {history && <span className="text-sm text-muted-foreground">{history}</span>}
          </div>
          {ts?.decisionNote && (sentBack || s.status === 'approved') && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              <span className="font-medium">{t('status.note')}</span> {ts.decisionNote}
            </p>
          )}
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            {s.locked && <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
            <span>{hint}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {unsubmitted && s.writer && s.submits && (
            <Button
              variant={s.own ? 'primary' : 'outline'}
              icon={<SendIcon aria-hidden />}
              disabled={s.notStarted}
              onClick={() => setAction('submit')}
            >
              {s.own ? t('actions.submit') : t('actions.submitFor', { name })}
            </Button>
          )}
          {s.status === 'submitted' && s.own && ts && (
            <Button
              icon={<RollbackIcon aria-hidden />}
              loading={takeBack.isPending}
              onClick={() => takeBack.mutate({ id: ts.id })}
            >
              {t('actions.takeBack')}
            </Button>
          )}
          {s.status === 'submitted' && !s.own && s.decider && (
            <>
              <Button icon={<RollbackIcon aria-hidden />} onClick={() => setAction('sendBack')}>
                {t('actions.sendBack')}
              </Button>
              <Button variant="primary" icon={<CheckIcon aria-hidden />} onClick={() => setAction('approve')}>
                {t('actions.approve')}
              </Button>
            </>
          )}
          {s.status === 'approved' && s.decider && (
            <Button icon={<RollbackIcon aria-hidden />} onClick={() => setAction('reopen')}>
              {t('actions.sendBack')}
            </Button>
          )}
        </div>
      </div>
      {takeBack.isError && <ErrorNote className="mt-3" context={t('actions.takeBackFailed')} error={takeBack.error} />}
      {action && <SheetDialog action={action} summary={summary} own={s.own} onClose={() => setAction(null)} />}
    </Panel>
  );
}
