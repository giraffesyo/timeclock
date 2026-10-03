import { useState } from 'react';
import { type Entry, useClockIn, useClockOut, useSaveEntry, useSwitchClock, useTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';

/**
 * The clock without a look: what is running, what is being typed, and what
 * can be done about it. Any bar, button or menu can be drawn on top of it.
 */
export interface Clock {
  /** The running stretch, if the clock is on. */
  running: Entry | null;
  /** The note in the field: the running stretch's, or the one to start with. */
  note: string;
  setNote: (note: string) => void;
  /** Whether the note differs from what is saved on the running stretch. */
  noteEdited: boolean;
  /** The project in the picker: the running stretch's, or the one to start on. */
  projectId: string;
  /** Picks a project. While the clock runs this moves the clock to it. */
  chooseProject: (projectId: string) => Promise<Entry | null>;
  /** Whether the organization requires a project on every entry. */
  requireProject: boolean;
  /** Saves an edited note onto the running stretch. */
  saveNote: () => Promise<void>;
  start: () => Promise<Entry>;
  /** Stops the clock, saving an edited note first. */
  stop: () => Promise<Entry>;
  /** Starts the clock on what an entry was about; a running clock moves to it. */
  resume: (entry: Pick<Entry, 'projectId' | 'note'>) => Promise<Entry>;
  /** The pay period's timesheet is in, so the clock is off. */
  locked: boolean;
  /** A change is on its way. */
  busy: boolean;
}

export function useClock(): Clock {
  const { running, settings } = useSession();
  const sheet = useTimesheet();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const switchTo = useSwitchClock();
  const save = useSaveEntry();

  // What is typed belongs to one stretch (or to none yet): when the running
  // stretch changes, the field starts over from the new one's note.
  const stretch = running?.id ?? '';
  const [draft, setDraft] = useState({ stretch, note: running?.note ?? '', projectId: '' });
  const current = draft.stretch === stretch ? draft : { stretch, note: running?.note ?? '', projectId: '' };
  const note = current.note;
  const noteEdited = !!running && note.trim() !== running.note;
  const status = sheet.data?.timesheet?.status;

  const saveNote = async () => {
    if (!running || !noteEdited) return;
    await save.mutateAsync({ id: running.id, projectId: running.projectId, startedAt: running.startedAt, note });
  };

  return {
    running: running ?? null,
    note,
    setNote: (next) => setDraft({ ...current, note: next }),
    noteEdited,
    projectId: running ? (running.projectId ?? '') : current.projectId,
    chooseProject: async (projectId) => {
      if (!running) {
        setDraft({ ...current, projectId });
        return null;
      }
      // A note typed just before choosing a project describes the work being
      // moved to, so it goes with the new stretch.
      return switchTo.mutateAsync({ projectId: projectId || undefined, note: noteEdited ? note : '' });
    },
    requireProject: settings.requireProject,
    saveNote,
    start: () => clockIn.mutateAsync({ projectId: current.projectId || undefined, note }),
    stop: async () => {
      await saveNote();
      return clockOut.mutateAsync();
    },
    resume: (entry) => (running ? switchTo : clockIn).mutateAsync({ projectId: entry.projectId, note: entry.note }),
    locked: status === 'submitted' || status === 'approved',
    busy: clockIn.isPending || clockOut.isPending || switchTo.isPending,
  };
}
