import { ConfirmModal } from '@parallelworks/ui';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { controlClass, Field, textareaClass } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { ProjectSelect } from '@/components/project-select';
import { type Entry, useSaveEntry } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, at, type Day, dayOf, hoursMinutes, timeInput } from '@/lib/time';

/**
 * Adds or edits a stretch of time. Times are in the organization's time
 * zone. An end at or before the start is the next day, so a night shift is
 * one entry.
 */
export function EntryDialog({
  open,
  onClose,
  entry,
  day,
  personId,
}: {
  open: boolean;
  onClose: () => void;
  /** The entry to edit; absent adds one. */
  entry?: Entry;
  /** The day a new entry starts on. */
  day: Day;
  /** Whose time a new entry is; absent is the caller's. */
  personId?: string;
}) {
  // A fresh form per entry: remounting on the key resets every field.
  return open ? (
    <Form key={entry?.id ?? `new-${day}`} onClose={onClose} entry={entry} day={day} personId={personId} />
  ) : null;
}

function Form({ onClose, entry, day, personId }: { onClose: () => void; entry?: Entry; day: Day; personId?: string }) {
  const t = useTranslations('entry');
  const tc = useTranslations('common');
  const { settings } = useSession();
  const zone = settings.timezone;
  const save = useSaveEntry();

  const [date, setDate] = useState(entry ? dayOf(entry.startedAt, zone) : day);
  const [start, setStart] = useState(entry ? timeInput(entry.startedAt, zone) : '09:00');
  const [end, setEnd] = useState(entry?.endedAt ? timeInput(entry.endedAt, zone) : entry ? '' : '17:00');
  const [projectId, setProjectId] = useState(entry?.projectId ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [invalid, setInvalid] = useState(false);

  const running = !!entry && !entry.endedAt;
  const startedAt = at(date, start, zone);
  const overnight = end !== '' && end <= start;
  const endedAt = end === '' ? null : at(overnight ? addDays(date, 1) : date, end, zone);
  const length = startedAt && endedAt ? hoursMinutes(Date.parse(endedAt) - Date.parse(startedAt)) : null;

  const submit = async () => {
    if (!startedAt || (!endedAt && !running)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    try {
      await save.mutateAsync({
        id: entry?.id,
        personId: entry ? undefined : personId,
        projectId: projectId || undefined,
        startedAt,
        endedAt: endedAt ?? undefined,
        note,
      });
      onClose();
    } catch {
      // Shown below from save.error; the dialog stays open to fix it.
    }
  };

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={entry ? t('editTitle') : t('addTitle')}
      confirmLabel={tc('save')}
      onConfirm={submit}
      closeOnConfirm={false}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('day')} className="col-span-2">
          <input type="date" className={controlClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('start')}>
          <input type="time" className={controlClass} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field
          label={running ? t('endRunning') : t('end')}
          hint={
            length && (
              <>
                {t('length', length)}
                {overnight && ` · ${t('nextDay')}`}
              </>
            )
          }
        >
          <input type="time" className={controlClass} value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label={tc('project.label')} className="col-span-2">
          <ProjectSelect value={projectId} onChange={setProjectId} required={settings.requireProject} />
        </Field>
        <Field label={tc('note')} className="col-span-2">
          <textarea
            className={textareaClass}
            rows={2}
            value={note}
            placeholder={t('notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
      {invalid && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {t('invalid')}
        </p>
      )}
      {save.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={save.error} />}
    </ConfirmModal>
  );
}
