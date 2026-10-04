import { type Entry as ClockEntry, clockFor } from '@giraffesyo/timeclock';
import { ClockBar as Bar, type ClockAction } from '@giraffesyo/timeclock/react';
import { fromResponseBody } from '@parallelworks/problem';
import { useErrorMessage } from '@parallelworks/problem/react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { useProjectName } from '@/components/project-select';
import { basePath } from '@/lib/base';
import type { Entry } from '@/lib/queries';
import { useZone } from '@/lib/zone';

/** The page's clock: the same one a host application shows. */
export const clock = clockFor(basePath);

/** What the API answered a refused clock request with, as the app's own error. */
const asApiError = (err: unknown) =>
  err && typeof err === 'object' && 'body' in err && 'status' in err
    ? fromResponseBody((err as { body: unknown }).body, (err as { status: number }).status)
    : err;

/**
 * The clock, across the top of every page. It is @giraffesyo/timeclock's
 * bar, the one host applications use, given this app's words and toasts.
 * Whatever it does, the rest of the page reads again.
 */
export function ClockBar() {
  const t = useTranslations('clock');
  const tp = useTranslations('common.project');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const projectName = useProjectName();
  const zone = useZone();
  const client = useQueryClient();

  const failures: Record<ClockAction, string> = {
    start: t('inFailed'),
    stop: t('outFailed'),
    switch: t('switchFailed'),
    note: t('noteFailed'),
  };
  const time = (iso: string) => format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  return (
    <div className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="min-h-14 px-3 py-2">
        <Bar
          store={clock}
          labels={{
            clock: t('label'),
            notePlaceholder: t('notePlaceholder'),
            noteLabel: t('noteLabel'),
            start: t('in'),
            stop: t('out'),
            switchProject: t('switchLabel'),
            locked: t('locked'),
            since: (at) => t('since', { time: at }),
            project: tp('label'),
            none: tp('none'),
            choose: tp('choose'),
            search: tp('search'),
            noMatch: tp('noMatch'),
          }}
          onError={(err, action) => toast.error(failures[action], { description: errorMessage(asApiError(err)) })}
          onSwitched={(next: ClockEntry) =>
            toast.success(t('switched', { project: projectName(next.projectId), time: time(next.startedAt) }))
          }
          onChanged={() => client.invalidateQueries()}
        />
      </div>
    </div>
  );
}

/**
 * Starts the clock on what an entry was about: its project and note. A clock
 * already running moves to it.
 */
export function useContinue() {
  const t = useTranslations('clock');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  return {
    start: (entry: Entry) => {
      clock.resume(entry).then(
        () => client.invalidateQueries(),
        (err) => toast.error(t('inFailed'), { description: errorMessage(asApiError(err)) }),
      );
    },
  };
}
