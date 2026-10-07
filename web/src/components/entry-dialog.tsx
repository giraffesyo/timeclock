import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { BareModal, modalPanelClasses } from '@parallelworks/ui';
import { ArrowRightIcon, CloseIcon, CopyIcon, MenuIcon, StartIcon, TrashIcon } from '@parallelworks/ui/icons';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { useContinue } from '@/components/clock-bar';
import { ErrorNote } from '@/components/page';
import { ProjectSelect, useProjectName } from '@/components/project-select';
import { cn } from '@/lib/cn';
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
  const { settings, person: me } = useSession();
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
  const actionsButton = useRef<HTMLButtonElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (deleting) cancelDelete.current?.focus({ preventScroll: true });
  }, [deleting]);
  // What you worked on comes first, as the field to type into. A frame
  // later, once the popover shows and the modal has noted what to return
  // focus to on close.
  useEffect(() => {
    const frame = requestAnimationFrame(() => noteField.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const time = (iso: string) => format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const range = (e: Entry) =>
    e.endedAt
      ? t('range', { start: time(e.startedAt), end: time(e.endedAt) })
      : t('rangeRunning', { start: time(e.startedAt) });

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

  const actions = entry && (
    <>
      {/* Starting again runs your clock, so only from your own time. */}
      {entry.endedAt && entry.personId === me.id && (
        <Button
          variant="primary"
          className="!size-9 !rounded-full !p-0"
          aria-label={t('continue')}
          title={t('continue')}
          icon={<StartIcon aria-hidden className="!size-5" />}
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
              /* The panel stays open and shows the error. */
            }
          }}
        />
      )}
      <Menu as="div" className="relative">
        <MenuButton
          ref={actionsButton}
          className={buttonClass('ghost', 'md', '!size-9 !p-0')}
          aria-label={t('actions')}
          title={t('actions')}
          disabled={deleting || save.isPending || duplicate.isPending}
        >
          <MenuIcon aria-hidden className="!size-5" />
        </MenuButton>
        <MenuItems modal={false} className="popover absolute left-0 top-full z-10 mt-1 min-w-40 p-1 focus:outline-none">
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
    </>
  );

  const requireNote = settings.requireDescription && (!running || !!end);

  const content = (
    <>
      <div className="mb-2 flex min-h-8 items-center gap-1">
        {actions}
        <span className="flex-1" />
        <Button
          variant="ghost"
          className="!size-8 !p-0"
          aria-label={t('close')}
          title={t('close')}
          icon={<CloseIcon aria-hidden className="!size-4" />}
          onClick={onClose}
        />
      </div>
      {deleting && entry ? (
        <section aria-labelledby="entry-delete-title">
          <h2 id="entry-delete-title" className="text-base font-semibold">
            {t('deleteTitle')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('deleteDescription', { range: range(entry), project: projectName(entry.projectId) })}
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
                requestAnimationFrame(() => actionsButton.current?.focus({ preventScroll: true }));
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
          // The server's own reasons are shown, as on the clock, rather than the browser's.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={noteField}
            className="entry-note"
            aria-label={tc('note')}
            rows={1}
            required={requireNote}
            maxLength={2000}
            value={note}
            placeholder={requireNote ? t('notePlaceholderRequired') : t('notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Enter saves, as in a one-line field; Shift+Enter breaks the line.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <ProjectSelect
              className="min-w-0 max-w-[65%]"
              value={projectId}
              onChange={setProjectId}
              required={settings.requireProject && (!running || !!end)}
            />
            <span className="flex-1" />
            <input
              type="date"
              className="entry-day"
              aria-label={t('day')}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-3">
            <div className="flex items-center gap-2">
              <input
                type="time"
                className="entry-time"
                aria-label={t('start')}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
              <ArrowRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <input
                type="time"
                className="entry-time"
                aria-label={running ? t('endRunning') : t('end')}
                title={running ? t('endRunning') : undefined}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
            <span className="flex min-w-0 flex-1 flex-col px-1 leading-tight">
              <span className="text-sm font-medium whitespace-nowrap tabular-nums">
                {length ? t('length', length) : ''}
              </span>
              {overnight && <span className="text-xs text-muted-foreground">{t('nextDay')}</span>}
            </span>
            <Button type="submit" variant="primary" className="!h-10 !px-5" loading={save.isPending}>
              {tc('save')}
            </Button>
          </div>
          {invalid && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {t('invalid')}
            </p>
          )}
          {save.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={save.error} />}
          {duplicate.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={duplicate.error} />}
        </form>
      )}
    </>
  );

  const title = entry ? t('editTitle') : t('addTitle');
  if (anchor) {
    return (
      <EntryPopover anchor={anchor} onClose={onClose} title={title}>
        {content}
      </EntryPopover>
    );
  }
  return (
    <BareModal
      open
      onClose={onClose}
      ariaLabel={title}
      preventClose={save.isPending || remove.isPending}
      className={cn(modalPanelClasses, 'w-[27rem] max-w-full px-4 pt-3 pb-4')}
    >
      {content}
    </BareModal>
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
