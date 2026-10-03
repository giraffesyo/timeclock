import { useErrorMessage } from '@parallelworks/problem/react';
import { StartIcon, StopSolidIcon } from '@parallelworks/ui/icons';
import { type FocusEvent, type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { ErrorNote } from '@/components/page';
import { ProjectSelect, useProjectName } from '@/components/project-select';
import { cn } from '@/lib/cn';
import { type Entry, useClockIn, useClockOut, useSaveEntry, useSwitchClock } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { stopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';

/** The round button that starts or stops the clock. */
function ClockButton({
  running,
  label,
  disabled,
  onClick,
  submit,
}: {
  running: boolean;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  submit?: boolean;
}) {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-[scale,opacity] hover:enabled:opacity-90 active:enabled:scale-95 disabled:cursor-not-allowed disabled:opacity-50',
        running ? 'bg-danger text-background' : 'bg-primary text-primary-foreground',
      )}
    >
      {running ? <StopSolidIcon aria-hidden className="size-4" /> : <StartIcon aria-hidden className="size-7" />}
    </button>
  );
}

function Bar({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-2 text-card-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{children}</div>
      {below}
    </section>
  );
}

const noteClass =
  'h-10 min-w-0 flex-1 basis-full rounded-md border border-transparent bg-transparent px-3 text-base placeholder:text-muted-foreground hover:border-border focus-visible:border-border sm:basis-48';
const elapsedClass = 'tabular ml-auto w-28 text-right text-2xl font-semibold tracking-tight';

/**
 * The clock, the one thing most people come here to do: say what you are
 * working on, pick its project, and start. While it runs, the same bar
 * changes it in place: the note is the running stretch's own, and another
 * project moves the clock to it without stopping.
 */
export function ClockBar({ locked }: { locked: boolean }) {
  const { running } = useSession();
  return running ? <Running key={running.id} entry={running} locked={locked} /> : <Idle locked={locked} />;
}

function Idle({ locked }: { locked: boolean }) {
  const t = useTranslations('clock');
  const { settings } = useSession();
  const clockIn = useClockIn();
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        clockIn.mutate({ projectId: projectId || undefined, note });
      }}
    >
      <Bar
        below={
          <>
            {locked && <p className="px-3 pt-2 pb-1 text-sm text-muted-foreground">{t('locked')}</p>}
            {clockIn.isError && <ErrorNote className="mt-2" context={t('inFailed')} error={clockIn.error} />}
          </>
        }
      >
        <input
          className={noteClass}
          value={note}
          placeholder={t('notePlaceholder')}
          aria-label={t('noteLabel')}
          disabled={locked}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
        <ProjectSelect
          value={projectId}
          onChange={setProjectId}
          required={settings.requireProject}
          disabled={locked}
          className="h-10 min-w-0 flex-1 sm:w-60 sm:flex-none"
        />
        <span className={cn(elapsedClass, 'hidden text-muted-foreground/60 sm:block')} aria-hidden>
          {stopwatch(0)}
        </span>
        <ClockButton running={false} label={t('in')} disabled={locked || clockIn.isPending} submit />
      </Bar>
    </form>
  );
}

function Running({ entry, locked }: { entry: Entry; locked: boolean }) {
  const t = useTranslations('clock');
  const format = useFormatter();
  const { settings } = useSession();
  const projectName = useProjectName();
  const clockOut = useClockOut();
  const switchTo = useSwitchClock();
  const save = useSaveEntry();
  const now = useNow(1000);
  const bar = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState(entry.note);

  const time = (iso: string) =>
    format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: settings.timezone });
  const edited = note.trim() !== entry.note;
  // A note typed just before choosing a project describes the work being
  // moved to, so it goes with the new stretch.
  const change = (projectId: string) =>
    switchTo.mutate(
      { projectId: projectId || undefined, note: edited ? note : '' },
      {
        onSuccess: (next) =>
          toast.success(t('switched', { project: projectName(next.projectId), time: time(next.startedAt) })),
      },
    );
  const saveNote = (e: FocusEvent) => {
    // Moving on to the project picker isn't done with the note yet.
    if (!edited || bar.current?.contains(e.relatedTarget)) return;
    save.mutate({ id: entry.id, projectId: entry.projectId, startedAt: entry.startedAt, note });
  };

  return (
    <div ref={bar}>
      <Bar
        below={
          <>
            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
              {t('since', { time: time(entry.startedAt) })} {t('switchHint')}
            </p>
            {switchTo.isError && <ErrorNote className="mt-2" context={t('switchFailed')} error={switchTo.error} />}
            {save.isError && <ErrorNote className="mt-2" context={t('noteFailed')} error={save.error} />}
            {clockOut.isError && <ErrorNote className="mt-2" context={t('outFailed')} error={clockOut.error} />}
          </>
        }
      >
        <input
          className={noteClass}
          value={note}
          placeholder={t('notePlaceholder')}
          aria-label={t('noteLabel')}
          disabled={locked}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <ProjectSelect
          value={entry.projectId ?? ''}
          onChange={change}
          required={settings.requireProject}
          disabled={locked || switchTo.isPending}
          label={t('switchLabel')}
          className="h-10 min-w-0 flex-1 sm:w-60 sm:flex-none"
        />
        <span className={elapsedClass} role="timer">
          {stopwatch(Math.max(0, now - Date.parse(entry.startedAt)))}
        </span>
        <ClockButton running label={t('out')} disabled={clockOut.isPending} onClick={() => clockOut.mutate()} />
      </Bar>
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
  const { running } = useSession();
  const clockIn = useClockIn();
  const switchTo = useSwitchClock();
  return {
    pending: clockIn.isPending || switchTo.isPending,
    start: (entry: Entry) =>
      (running ? switchTo : clockIn).mutate(
        { projectId: entry.projectId, note: entry.note },
        { onError: (err) => toast.error(`${t('inFailed')} ${errorMessage(err)}`) },
      ),
  };
}
