import { ConfirmModal, TOOLTIP_ID } from '@parallelworks/ui';
import { EditIcon, LockIcon, TrashIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { EntryDialog } from '@/components/entry-dialog';
import { ErrorNote } from '@/components/page';
import { useProjectName } from '@/components/project-select';
import { type Entry, useDeleteEntry } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { dayOf, elapsed, hoursMinutes } from '@/lib/time';
import { useNow } from '@/lib/use-now';

/**
 * A day's entries, oldest first: when, on what, for how long. Each can be
 * edited or deleted unless its day is in a submitted timesheet.
 */
export function EntryList({ entries, readOnly }: { entries: Entry[]; readOnly?: boolean }) {
  const t = useTranslations('entry');
  const tc = useTranslations('common');
  const format = useFormatter();
  const { settings } = useSession();
  const zone = settings.timezone;
  const projectName = useProjectName();
  const remove = useDeleteEntry();
  const [editing, setEditing] = useState<Entry | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  useNow(
    30_000,
    entries.some((e) => !e.endedAt),
  ); // keeps a running entry's length current

  const time = (iso: string) => format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const range = (e: Entry) =>
    e.endedAt
      ? t('range', { start: time(e.startedAt), end: time(e.endedAt) })
      : t('rangeRunning', { start: time(e.startedAt) });

  return (
    <>
      <ul className="divide-y divide-border">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="tabular w-36 shrink-0 text-sm">{range(e)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{projectName(e.projectId)}</span>
              {e.note && <span className="block truncate text-xs text-muted-foreground">{e.note}</span>}
            </span>
            <span className="tabular shrink-0 text-sm font-medium">
              {tc('duration', hoursMinutes(elapsed(e.startedAt, e.endedAt)))}
            </span>
            {!readOnly &&
              (e.locked ? (
                <span
                  className="flex w-16 justify-end text-muted-foreground"
                  role="img"
                  aria-label={t('locked')}
                  data-tooltip-id={TOOLTIP_ID}
                  data-tooltip-content={t('locked')}
                >
                  <LockIcon className="size-3.5" aria-hidden />
                </span>
              ) : (
                <span className="flex w-16 justify-end gap-0.5">
                  <Button variant="ghost" size="sm" aria-label={t('edit')} onClick={() => setEditing(e)}>
                    <EditIcon aria-hidden />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={t('delete')} onClick={() => setDeleting(e)}>
                    <TrashIcon aria-hidden />
                  </Button>
                </span>
              ))}
          </li>
        ))}
      </ul>
      <EntryDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        entry={editing ?? undefined}
        day={editing ? dayOf(editing.startedAt, zone) : ''}
      />
      <ConfirmModal
        open={!!deleting}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
        title={t('deleteTitle')}
        description={
          deleting ? t('deleteDescription', { range: range(deleting), project: projectName(deleting.projectId) }) : null
        }
        confirmLabel={t('delete')}
        destructive
        closeOnConfirm={false}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            setDeleting(null);
          } catch {
            // Shown below from remove.error.
          }
        }}
      >
        {remove.isError ? <ErrorNote context={t('deleteFailed')} error={remove.error} /> : null}
      </ConfirmModal>
    </>
  );
}
