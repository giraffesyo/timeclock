// The clock for React: useClock() is the logic with no look, and ClockBar
// and ProjectPicker are a look for it, styled by "@giraffesyo/timeclock/styles.css".
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type ClockError,
  type ClockState,
  type ClockStore,
  clockFor,
  type Entry,
  type Project,
  projectHue,
  projectLabel,
  stopwatch,
} from './index.js';

export interface UseClockOptions {
  /** Where Timeclock is mounted, such as "/timeclock". Ignored when `store` is given. */
  basePath?: string;
  /** A store made with createClock(), instead of the page's shared one. */
  store?: ClockStore;
}

/** The clock without a look: what is running, what is being typed, and what can be done about it. */
export interface Clock extends ClockState {
  /** The note in the field: the running stretch's, or the one to start with. */
  note: string;
  setNote: (note: string) => void;
  /** Whether the note differs from what is saved on the running stretch. */
  noteEdited: boolean;
  /** The project in the picker: the running stretch's, or the one to start on. */
  projectId: string;
  /** Picks a project. While the clock runs this moves the clock to it, and answers with the new stretch. */
  chooseProject: (projectId: string) => Promise<Entry | null>;
  /** Saves an edited note onto the running stretch. */
  saveNote: () => Promise<void>;
  start: () => Promise<Entry>;
  /** Stops the clock, saving an edited note first. */
  stop: () => Promise<Entry>;
  /** Starts the clock on what an entry was about; a running clock moves to it. */
  resume: (entry: Pick<Entry, 'projectId' | 'note'>) => Promise<Entry>;
  /** The store underneath, for anything else. */
  store: ClockStore;
}

/** The clock of the Timeclock at a base path, kept current while the component is mounted. */
export function useClock(options: UseClockOptions = {}): Clock {
  const store = options.store ?? clockFor(options.basePath);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { running } = state;

  // What is typed belongs to one stretch (or to none yet): when the running
  // stretch changes, the field starts over from the new one's note.
  const stretch = running?.id ?? '';
  const [draft, setDraft] = useState({ stretch, note: running?.note ?? '', projectId: '' });
  const current = draft.stretch === stretch ? draft : { stretch, note: running?.note ?? '', projectId: '' };
  const note = current.note;
  const noteEdited = !!running && note.trim() !== running.note;

  const saveNote = async () => {
    if (running && noteEdited) await store.saveNote(note);
  };
  return {
    ...state,
    store,
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
      return store.switchTo({ projectId, note: noteEdited ? note : '' });
    },
    saveNote,
    start: () => store.start({ projectId: current.projectId, note }),
    stop: async () => {
      await saveNote();
      return store.stop();
    },
    resume: (entry) => store.resume(entry),
  };
}

/** The current time, refreshed every second while enabled. */
function useSecond(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

// --- The project picker ---

export interface ProjectPickerLabels {
  /** What the control is: "Project". */
  project: string;
  /** Shown when nothing is chosen and nothing has to be. */
  none: string;
  /** Shown when a project must be chosen and none is. */
  choose: string;
  search: string;
  noMatch: string;
}

const pickerLabels: ProjectPickerLabels = {
  project: 'Project',
  none: 'No project',
  choose: 'Choose a project',
  search: 'Search projects',
  noMatch: 'No project matches.',
};

/** A project's color, as a dot: the same hue its time has everywhere. */
export function ProjectDot({ projectId, className }: { projectId?: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('tc-dot', !projectId && 'tc-dot-none', className)}
      style={projectId ? ({ '--tc-hue': projectHue(projectId) } as CSSProperties) : undefined}
    />
  );
}

/**
 * Picks the project time is recorded on: a button that opens a list to
 * search, grouped by customer.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  required = false,
  disabled,
  className,
  id,
  label,
  labels: given,
}: {
  /** The projects to choose from. One that is the value but not among them is still shown as chosen. */
  projects: Project[];
  value: string;
  onChange: (projectId: string) => void;
  /** A project must be chosen: there is no "no project" choice. */
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** What the control is for, when it isn't simply the project. */
  label?: string;
  labels?: Partial<ProjectPickerLabels>;
}) {
  const labels = { ...pickerLabels, ...given };
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const current = value ? projects.find((p) => p.id === value) : undefined;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const options = [
    ...(required ? [] : [{ id: '', name: labels.none, group: '' }]),
    ...projects.map((p) => ({ id: p.id, name: p.name, group: p.customerName })),
  ].filter((o) => words.every((w) => `${o.group} ${o.name}`.toLowerCase().includes(w)));
  const at = Math.min(cursor, Math.max(options.length - 1, 0));

  // A press outside closes the list.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const show = () => {
    setQuery('');
    setCursor(
      Math.max(
        0,
        options.findIndex((o) => o.id === value),
      ),
    );
    setOpen(true);
  };
  const pick = (projectId: string) => {
    setOpen(false);
    trigger.current?.focus();
    if (projectId !== value) onChange(projectId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setCursor(Math.min(at + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setCursor(Math.max(at - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const o = options[at];
        if (o) pick(o.id);
        break;
      }
      case 'Escape':
        // The list closes; a dialog around it stays.
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        setOpen(false);
        trigger.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const shown = current ? projectLabel(current) : required ? labels.choose : labels.none;
  return (
    <div ref={root} className={cx('tc-picker', className)}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="tc-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label ?? labels.project}: ${shown}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            show();
          }
        }}
      >
        <ProjectDot projectId={current?.id} />
        <span className={cx('tc-picker-value', !current && 'tc-muted')}>{shown}</span>
        <svg
          aria-hidden
          className="tc-chevron"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="tc-popover">
          <input
            className="tc-search"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options[at] ? `${listId}-${at}` : undefined}
            aria-label={labels.search}
            placeholder={labels.search}
            value={query}
            // biome-ignore lint/a11y/noAutofocus: opening the list is asking to search it
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div id={listId} role="listbox" aria-label={label ?? labels.project} className="tc-options">
            {options.length === 0 && <p className="tc-empty">{labels.noMatch}</p>}
            {options.map((o, i) => (
              <div key={o.id}>
                {o.group !== (options[i - 1]?.group ?? '') && <div className="tc-group">{o.group}</div>}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the search field above holds focus and drives the list with the arrow keys */}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={o.id === value}
                  className={cx('tc-option', i === at && 'tc-option-active')}
                  onPointerMove={() => setCursor(i)}
                  onClick={() => pick(o.id)}
                >
                  <ProjectDot projectId={o.id} />
                  <span className="tc-option-name">{o.name}</span>
                  {o.id === value && (
                    <svg
                      aria-hidden
                      className="tc-check"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="m2.5 6.5 2.5 2.5 4.5-5.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- The bar ---

export interface ClockBarLabels extends ProjectPickerLabels {
  /** The bar's name, for assistive tech. */
  clock: string;
  notePlaceholder: string;
  noteLabel: string;
  start: string;
  stop: string;
  /** What the picker is for while the clock runs. */
  switchProject: string;
  /** Replaces the note's placeholder when the pay period's timesheet is in. */
  locked: string;
  /** When the running stretch started, given the time as text. */
  since: (time: string) => string;
}

const barLabels: ClockBarLabels = {
  ...pickerLabels,
  clock: 'Clock',
  notePlaceholder: 'What are you working on?',
  noteLabel: 'What you are working on',
  start: 'Start the clock',
  stop: 'Stop the clock',
  switchProject: 'Project the clock is running on',
  locked: 'This pay period’s timesheet is submitted, so the clock is off.',
  since: (time) => `Running since ${time}`,
};

/** What the person was doing when something was refused. */
export type ClockAction = 'start' | 'stop' | 'switch' | 'note';

/**
 * The clock as a bar: say what you are working on, pick its project, and
 * start. While it runs the same bar changes it in place: the note is the
 * running stretch's own, and another project moves the clock to it without
 * stopping. It draws nothing until Timeclock has answered, and nothing for
 * someone Timeclock doesn't know.
 */
export function ClockBar({
  basePath,
  store,
  labels: given,
  className,
  onError,
  onSwitched,
  onChanged,
}: UseClockOptions & {
  labels?: Partial<ClockBarLabels>;
  className?: string;
  /** Called when Timeclock refuses something, to tell the person. */
  onError?: (error: ClockError | unknown, action: ClockAction) => void;
  /** Called when the running clock moved to another project, with the new stretch. */
  onSwitched?: (entry: Entry) => void;
  /** Called after anything the bar did took effect, for a host that shows the same time elsewhere. */
  onChanged?: () => void;
}) {
  const labels = { ...barLabels, ...given };
  const clock = useClock({ basePath, store });
  const { running } = clock;
  const now = useSecond(!!running);
  const bar = useRef<HTMLFormElement>(null);
  // Whether a press that began inside the bar is under way.
  const pressed = useRef(false);

  if (clock.status !== 'ready') return null;

  const failed = (action: ClockAction) => (err: unknown) => onError?.(err, action);
  const choose = (projectId: string) => {
    clock
      .chooseProject(projectId)
      .then((next) => {
        if (next) {
          onSwitched?.(next);
          onChanged?.();
        }
      })
      .catch(failed('switch'));
  };
  const leaveNote = (e: FocusEvent) => {
    // Moving on to the project picker isn't done with the note yet. Safari
    // doesn't focus a button that is clicked, so the press is noted as well.
    if (pressed.current || bar.current?.contains(e.relatedTarget)) return;
    clock.saveNote().then(onChanged, failed('note'));
  };
  const since = running
    ? labels.since(
        new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: clock.timeZone }).format(
          new Date(running.startedAt),
        ),
      )
    : undefined;

  return (
    <form
      ref={bar}
      aria-label={labels.clock}
      className={cx('tc-bar', className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (running) clock.stop().then(onChanged, failed('stop'));
        else clock.start().then(onChanged, failed('start'));
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
      <input
        className="tc-note"
        value={clock.note}
        placeholder={clock.locked ? labels.locked : labels.notePlaceholder}
        aria-label={labels.noteLabel}
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
      <ProjectPicker
        className="tc-bar-picker"
        projects={clock.projects}
        value={clock.projectId}
        onChange={choose}
        required={clock.requireProject}
        disabled={clock.locked || (!!running && clock.busy)}
        label={running ? labels.switchProject : undefined}
        labels={labels}
      />
      {running ? (
        <span className="tc-time" role="timer" title={since}>
          {stopwatch(now - Date.parse(running.startedAt))}
        </span>
      ) : (
        <span aria-hidden className="tc-time tc-time-idle">
          {stopwatch(0)}
        </span>
      )}
      <button
        type="submit"
        aria-label={running ? labels.stop : labels.start}
        disabled={clock.locked || clock.busy}
        className={cx('tc-go', !!running && 'tc-go-stop')}
      >
        <svg aria-hidden viewBox="0 0 16 16" fill="currentColor">
          {running ? <rect x="4" y="4" width="8" height="8" rx="1" /> : <path d="M5.5 3.5v9l7-4.5z" />}
        </svg>
      </button>
    </form>
  );
}
