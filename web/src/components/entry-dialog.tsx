import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { ConfirmModal } from '@parallelworks/ui';
import { CloseIcon, CopyIcon, MenuIcon, StartIcon, TrashIcon } from '@parallelworks/ui/icons';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { useContinue } from '@/components/clock-bar';
import { controlClass, Field, textareaClass } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { ProjectSelect, useProjectName } from '@/components/project-select';
import { type Entry, useDeleteEntry, useSaveEntry } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, at, type Day, dayOf, hoursMinutes, timeInput } from '@/lib/time';
import { useZone } from '@/lib/zone';

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
  start,
  end,
  anchor,
}: {
  open: boolean;
  onClose: () => void;
  /** The entry to edit; absent adds one. */
  entry?: Entry;
  /** The day a new entry starts on. */
  day: Day;
  /** Whose time a new entry is; absent is the caller's. */
  personId?: string;
  /** The HH:mm a new entry starts and ends at, when the caller already knows. */
  start?: string;
  end?: string;
  /** Calendar entries edit beside their block, without interrupting the page. */
  anchor?: HTMLElement | null;
}) {
  // A fresh form per entry: remounting on the key resets every field.
  return open ? (
    <Form
      key={entry?.id ?? `new-${day}-${start}-${end}`}
      onClose={onClose}
      entry={entry}
      day={day}
      personId={personId}
      from={start ?? '09:00'}
      to={end ?? '17:00'}
      anchor={anchor}
    />
  ) : null;
}

function Form({
  onClose,
  entry,
  day,
  personId,
  from,
  to,
  anchor,
}: {
  onClose: () => void;
  entry?: Entry;
  day: Day;
  personId?: string;
  from: string;
  to: string;
  anchor?: HTMLElement | null;
}) {
  const t = useTranslations('entry');
  const tc = useTranslations('common');
  const format = useFormatter();
  const projectName = useProjectName();
  const { settings } = useSession();
  const zone = useZone(entry?.personId ?? personId);
  const save = useSaveEntry();
  const duplicate = useSaveEntry();
  const remove = useDeleteEntry();
  const again = useContinue();

  const [date, setDate] = useState(entry ? dayOf(entry.startedAt, zone) : day);
  const [start, setStart] = useState(entry ? timeInput(entry.startedAt, zone) : from);
  const [end, setEnd] = useState(entry?.endedAt ? timeInput(entry.endedAt, zone) : entry ? '' : to);
  const [projectId, setProjectId] = useState(entry?.projectId ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [invalid, setInvalid] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (deleting) cancelDelete.current?.focus({ preventScroll: true });
  }, [deleting]);

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

  const fields = (
    <>
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
          <ProjectSelect
            value={projectId}
            onChange={setProjectId}
            required={settings.requireProject && (!running || !!end)}
          />
        </Field>
        <Field
          label={tc('note')}
          hint={settings.requireDescription && (!running || !!end) ? t('descriptionRequired') : undefined}
          className="col-span-2"
        >
          <textarea
            className={textareaClass}
            rows={2}
            required={settings.requireDescription && (!running || !!end)}
            maxLength={2000}
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
      {duplicate.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={duplicate.error} />}
    </>
  );

  if (anchor && entry) {
    const time = (iso: string) =>
      format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
    const range = entry.endedAt
      ? t('range', { start: time(entry.startedAt), end: time(entry.endedAt) })
      : t('rangeRunning', { start: time(entry.startedAt) });
    return (
      <EntryPopover anchor={anchor} onClose={onClose} title={t('editTitle')}>
        <div className="mb-3 flex items-center gap-2">
          {entry.endedAt && (
            <Button
              variant="primary"
              className="!size-10 !rounded-full !p-0"
              aria-label={t('continue')}
              title={t('continue')}
              icon={<StartIcon aria-hidden className="!size-6" />}
              disabled={deleting}
              onClick={() => {
                void again.start(entry);
                onClose();
              }}
            />
          )}
          {entry.endedAt && (
            <Button
              variant="ghost"
              className="!size-9 !p-0"
              aria-label={t('duplicate')}
              title={t('duplicate')}
              icon={<CopyIcon aria-hidden className="!size-5" />}
              loading={duplicate.isPending}
              disabled={deleting}
              onClick={async () => {
                if (!startedAt || !endedAt) {
                  setInvalid(true);
                  return;
                }
                try {
                  await duplicate.mutateAsync({ projectId: projectId || undefined, startedAt, endedAt, note });
                  onClose();
                } catch {
                  /* The popover stays open and shows the error. */
                }
              }}
            />
          )}
          <Menu as="div" className="relative">
            <MenuButton
              ref={actions}
              className={buttonClass('ghost', 'md', '!size-9 !p-0')}
              aria-label={t('actions')}
              title={t('actions')}
              disabled={deleting || save.isPending || duplicate.isPending}
            >
              <MenuIcon aria-hidden className="!size-5" />
            </MenuButton>
            <MenuItems
              modal={false}
              className="popover absolute left-0 top-full z-10 mt-1 min-w-40 p-1 focus:outline-none"
            >
              <MenuItem>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger data-focus:bg-danger-subtle"
                  onClick={() => setDeleting(true)}
                >
                  <TrashIcon aria-hidden className="size-4" />
                  {t('delete')}
                </button>
              </MenuItem>
            </MenuItems>
          </Menu>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" aria-label={t('close')} onClick={onClose}>
            <CloseIcon aria-hidden />
          </Button>
        </div>
        {deleting ? (
          <section aria-labelledby="entry-delete-title">
            <h2 id="entry-delete-title" className="text-base font-semibold">
              {t('deleteTitle')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('deleteDescription', { range, project: projectName(entry.projectId) })}
            </p>
            {remove.isError && <ErrorNote className="mt-3" context={t('deleteFailed')} error={remove.error} />}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={buttonClass()}
                ref={cancelDelete}
                disabled={remove.isPending}
                onClick={() => {
                  setDeleting(false);
                  remove.reset();
                  requestAnimationFrame(() => actions.current?.focus({ preventScroll: true }));
                }}
              >
                {tc('cancel')}
              </button>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(entry.id);
                    onClose();
                  } catch {
                    // Keep the confirmation open so deletion can be retried.
                  }
                }}
              >
                {t('delete')}
              </Button>
            </div>
          </section>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {fields}
            <div className="mt-3 flex justify-end">
              <Button type="submit" variant="primary" loading={save.isPending}>
                {tc('save')}
              </Button>
            </div>
          </form>
        )}
      </EntryPopover>
    );
  }

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={entry ? t('editTitle') : t('addTitle')}
      confirmLabel={tc('save')}
      onConfirm={submit}
      closeOnConfirm={false}
    >
      {fields}
    </ConfirmModal>
  );
}

function EntryPopover({
  anchor,
  onClose,
  title,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    el.showPopover();
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const left = rect.right + width + 12 < window.innerWidth ? rect.right + 8 : rect.left - width - 8;
      el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(el);
    window.addEventListener('resize', position);
    const followScroll = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target)) position();
    };
    window.addEventListener('scroll', followScroll, true);
    el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', followScroll, true);
      anchor.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={panel}
      popover="auto"
      role="dialog"
      aria-label={title}
      className="popover entry-popover"
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.newState === 'closed') onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
