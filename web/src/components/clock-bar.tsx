import { useErrorMessage } from '@parallelworks/problem/react';
import { TOOLTIP_ID } from '@parallelworks/ui';
import { StartIcon, StopSolidIcon } from '@parallelworks/ui/icons';
import { type FocusEvent, useRef } from 'react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { ProjectSelect, useProjectName } from '@/components/project-select';
import { cn } from '@/lib/cn';
import type { Entry } from '@/lib/queries';
import { stopwatch } from '@/lib/time';
import { useClock } from '@/lib/use-clock';
import { useNow } from '@/lib/use-now';
import { useZone } from '@/lib/zone';

/**
 * The clock, across the top of every page: say what you are working on, pick
 * its project, and start. While it runs, the same bar changes it in place:
 * the note is the running stretch's own, and another project moves the clock
 * to it without stopping. It draws lib/use-clock.ts, which holds the logic.
 */
export function ClockBar() {
  const t = useTranslations('clock');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const projectName = useProjectName();
  const zone = useZone();
  const clock = useClock();
  const { running } = clock;
  const now = useNow(1000, !!running);
  const bar = useRef<HTMLFormElement>(null);
  // Whether a press that began inside the bar is under way.
  const pressed = useRef(false);

  const time = (iso: string) => format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const failed = (context: string) => (err: unknown) => {
    toast.error(context, { description: errorMessage(err) });
  };
  const choose = (projectId: string) =>
    clock
      .chooseProject(projectId)
      .then((next: Entry | null) => {
        if (next) toast.success(t('switched', { project: projectName(next.projectId), time: time(next.startedAt) }));
      })
      .catch(failed(t('switchFailed')));
  const leaveNote = (e: FocusEvent) => {
    // Moving on to the project picker isn't done with the note yet. Safari
    // doesn't focus a button that is clicked, so the press is noted as well.
    if (pressed.current || bar.current?.contains(e.relatedTarget)) return;
    clock.saveNote().catch(failed(t('noteFailed')));
  };

  return (
    <form
      ref={bar}
      aria-label={t('label')}
      className="border-b border-border bg-card text-card-foreground"
      onSubmit={(e) => {
        e.preventDefault();
        if (running) clock.stop().catch(failed(t('outFailed')));
        else clock.start().catch(failed(t('inFailed')));
      }}
      onPointerDownCapture={() => {
        pressed.current = true;
      }}
      onPointerUpCapture={() => {
        pressed.current = false;
      }}
      onPointerCancelCapture={() => {
        pressed.current = false;
      }}
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:px-6">
        <input
          className="h-10 min-w-0 flex-1 basis-full rounded-md border border-transparent bg-transparent px-3 text-base placeholder:text-muted-foreground hover:border-border focus-visible:border-border sm:-ml-3 sm:basis-48"
          value={clock.note}
          placeholder={clock.locked ? t('locked') : t('notePlaceholder')}
          aria-label={t('noteLabel')}
          disabled={clock.locked}
          maxLength={2000}
          onChange={(e) => clock.setNote(e.target.value)}
          onBlur={running ? leaveNote : undefined}
          onKeyDown={(e) => {
            // While the clock runs, Enter is done with the note; it doesn't stop the clock.
            if (running && e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <ProjectSelect
          value={clock.projectId}
          onChange={choose}
          required={clock.requireProject}
          disabled={clock.locked || (!!running && clock.busy)}
          label={running ? t('switchLabel') : undefined}
          className="h-10 min-w-0 flex-1 sm:w-60 sm:flex-none"
        />
        {running ? (
          <span
            className="tabular w-24 text-right text-xl font-semibold tracking-tight"
            role="timer"
            data-tooltip-id={TOOLTIP_ID}
            data-tooltip-content={t('since', { time: time(running.startedAt) })}
          >
            {stopwatch(Math.max(0, now - Date.parse(running.startedAt)))}
          </span>
        ) : (
          <span
            aria-hidden
            className="tabular hidden w-24 text-right text-xl font-semibold tracking-tight text-muted-foreground/60 sm:block"
          >
            {stopwatch(0)}
          </span>
        )}
        <button
          type="submit"
          aria-label={running ? t('out') : t('in')}
          disabled={clock.locked || clock.busy}
          className={cn(
            'flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-[scale,opacity] hover:enabled:opacity-90 active:enabled:scale-95 disabled:cursor-not-allowed disabled:opacity-50',
            running ? 'bg-danger text-background' : 'bg-primary text-primary-foreground',
          )}
        >
          {running ? <StopSolidIcon aria-hidden className="size-3.5" /> : <StartIcon aria-hidden className="size-6" />}
        </button>
      </div>
    </form>
  );
}

/**
 * Starts the clock on what an entry was about: its project and note. A clock
 * already running moves to it.
 */
export function useContinue() {
  const t = useTranslations('clock');
  const errorMessage = useErrorMessage();
  const clock = useClock();
  return {
    pending: clock.busy,
    start: (entry: Entry) => {
      clock.resume(entry).catch((err) => toast.error(t('inFailed'), { description: errorMessage(err) }));
    },
  };
}
