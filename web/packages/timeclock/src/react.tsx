// The clock for React: useClock() is the logic with no look, and ClockBar
// and ProjectPicker are a look for it, styled by "@giraffesyo/timeclock/styles.css".
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
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
  type RecentWork,
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
  /** Moves when the running stretch started, or stops it at `endedAt`, with the note as typed. */
  saveTimes: (times: { startedAt: string; endedAt?: string }) => Promise<Entry>;
  start: () => Promise<Entry>;
  /** Stops the clock, saving an edited note first. */
  stop: () => Promise<Entry>;
  /** Starts the clock on what an entry was about; a running clock moves to it. */
  resume: (entry: Pick<Entry, 'projectId' | 'note'>) => Promise<Entry>;
  /**
   * What the person tracked before that fits the note so far, the latest
   * first: only work on projects that still take time, and not what the
   * note and project already are.
   */
  suggestions: RecentWork[];
  /**
   * Takes a suggestion's note and project. While the clock runs they become
   * the running stretch's, in place, and this answers with it.
   */
  suggest: (work: RecentWork) => Promise<Entry | null>;
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
  const projectId = running ? (running.projectId ?? '') : current.projectId;
  const words = note.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const open = new Map(state.projects.map((p) => [p.id, p]));
  const suggestions = state.recent
    .filter((w) => !w.projectId || open.has(w.projectId))
    .filter((w) => !(w.note === note.trim() && (w.projectId ?? '') === projectId))
    .filter((w) => {
      const project = w.projectId ? open.get(w.projectId) : undefined;
      const text = `${w.note} ${project ? projectLabel(project) : ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 8);
  return {
    ...state,
    store,
    note,
    setNote: (next) => setDraft({ ...current, note: next }),
    noteEdited,
    projectId,
    chooseProject: async (projectId) => {
      if (!running) {
        setDraft({ ...current, projectId });
        return null;
      }
      // A note typed just before choosing a project describes the work being
      // moved to, so it goes with the new stretch.
      return store.switchTo({
        projectId,
        note: noteEdited || state.requireDescription || !running.projectId ? note : '',
      });
    },
    saveNote,
    saveTimes: (times) => store.saveTimes({ ...times, note: noteEdited ? note : undefined }),
    start: () => store.start({ projectId: current.projectId, note }),
    stop: async () => {
      await saveNote();
      return store.stop();
    },
    resume: (entry) => store.resume(entry),
    suggestions,
    suggest: async (work) => {
      setDraft({ ...current, note: work.note, projectId: work.projectId ?? '' });
      return running ? store.describe(work) : null;
    },
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

// --- Wall-clock time in a zone, without a date library ---

/** A calendar day (YYYY-MM-DD) and a time of day (HH:mm). */
interface Wall {
  day: string;
  time: string;
}

/** What a clock on the wall in the zone reads at an instant. */
function wallClock(ms: number, timeZone: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms))
    parts[p.type] = p.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** A YYYY-MM-DD day's year, month (1–12) and day of the month. */
const ymd = (day: string) => [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))] as const;

const utcOf = ({ day, time }: Wall) => {
  const [y, m, d] = ymd(day);
  return Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
};

/** The instant a wall clock in the zone reads a day and time. */
function instant(wall: Wall, timeZone: string): number {
  const guess = utcOf(wall);
  const offset = (ms: number) => utcOf(wallClock(ms, timeZone)) - Math.floor(ms / 60_000) * 60_000;
  // Twice, for a day whose offset changes between the guess and the answer.
  return guess - offset(guess - offset(guess));
}

const addDays = (day: string, n: number) => {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** The first day of the week where the person is: 0 for Sunday. */
function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    return info ? info.firstDay % 7 : 1;
  } catch {
    return 1;
  }
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
  const menu = useRef<HTMLDivElement>(null);
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

  // A nested native popover escapes a dialog's scrolling/clipping bounds while
  // remaining its descendant, so selecting a project keeps the editor open.
  useLayoutEffect(() => {
    const el = menu.current;
    const button = trigger.current;
    if (!open || !el || !button) return;
    el.showPopover();
    const position = () => {
      const rect = button.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      el.style.maxHeight = `${Math.max(0, Math.max(below, above))}px`;
      const height = el.offsetHeight;
      const down = below >= height || below >= above;
      el.style.maxHeight = `${Math.max(0, down ? below : above)}px`;
      el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${down ? rect.bottom + 4 : Math.max(8, rect.top - el.offsetHeight - 4)}px`;
    };
    position();
    el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(el);
    const follow = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target)) position();
    };
    window.addEventListener('resize', position);
    window.addEventListener('scroll', follow, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', follow, true);
    };
  }, [open]);

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
        e.preventDefault();
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
        <div
          ref={menu}
          popover="auto"
          className="tc-popover"
          onToggle={(e) => {
            if (e.target === e.currentTarget && e.newState === 'closed') setOpen(false);
          }}
        >
          <input
            className="tc-search"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options[at] ? `${listId}-${at}` : undefined}
            aria-label={labels.search}
            placeholder={labels.search}
            value={query}
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
                  onClick={(e) => {
                    // A picker can sit inside a field label. Selecting its row
                    // must not activate the labelled trigger and reopen the menu.
                    e.preventDefault();
                    pick(o.id);
                  }}
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

// --- When the running stretch started ---

/** A month of days to pick one from; days after `max` can't be picked. */
function MonthCalendar({
  value,
  max,
  onChange,
  labels,
}: {
  value: string;
  max: string;
  onChange: (day: string) => void;
  labels: Pick<ClockBarLabels, 'startDay' | 'previousMonth' | 'nextMonth'>;
}) {
  const [month, setMonth] = useState(value.slice(0, 7));
  const [y, m] = ymd(`${month}-01`);
  const weekStart = firstWeekday();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() - weekStart + 7) % 7;
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const step = (n: number) => setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7));
  const utc = (day: string) => new Date(`${day}T12:00:00Z`);
  const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    utc(`${month}-01`),
  );
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
  const named = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' });
  const days = Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  return (
    <fieldset className="tc-calendar" aria-label={labels.startDay}>
      <div className="tc-calendar-head">
        <span className="tc-calendar-title">{title}</span>
        <button type="button" className="tc-calendar-step" aria-label={labels.previousMonth} onClick={() => step(-1)}>
          <svg aria-hidden viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M7.5 2.5 4 6l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="tc-calendar-step"
          aria-label={labels.nextMonth}
          disabled={month >= max.slice(0, 7)}
          onClick={() => step(1)}
        >
          <svg aria-hidden viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M4.5 2.5 8 6 4.5 9.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="tc-calendar-grid">
        {Array.from({ length: 7 }, (_, i) =>
          weekday.format(new Date(Date.UTC(2024, 0, 7 + ((weekStart + i) % 7), 12))),
        ).map((name) => (
          <span key={name} aria-hidden className="tc-calendar-weekday">
            {name}
          </span>
        ))}
        {days.map((day, i) => (
          <button
            key={day}
            type="button"
            className="tc-calendar-day"
            style={i === 0 ? { gridColumnStart: lead + 1 } : undefined}
            aria-label={named.format(utc(day))}
            aria-pressed={day === value}
            aria-current={day === max ? 'date' : undefined}
            disabled={day > max}
            onClick={() => onChange(day)}
          >
            {Number(day.slice(8))}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** What is typed in the start and stop panel. */
interface TimesDraft {
  day: string;
  start: string;
  stop: string;
  /** The stop was changed: the stretch ends there instead of running on. */
  stopping: boolean;
}

/**
 * When the running stretch started, and when it should stop: a time and a
 * day for the start, and a stop that, once changed, ends the stretch then.
 */
function TimesFields({
  draft,
  onChange,
  today,
  onDone,
  labels,
}: {
  draft: TimesDraft;
  onChange: (draft: TimesDraft) => void;
  today: string;
  onDone: () => void;
  labels: ClockBarLabels;
}) {
  const startId = useId();
  const stopId = useId();
  const day =
    draft.day === today
      ? labels.today
      : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${draft.day}T12:00:00Z`),
        );
  // Enter is done: the panel closes and saves.
  const enter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onDone();
    }
  };
  return (
    <>
      <div className="tc-times-fields">
        <div className="tc-times-field">
          <label className="tc-times-label" htmlFor={startId}>
            {labels.startTime}
          </label>
          <span className="tc-times-box">
            <input
              id={startId}
              type="time"
              required
              className="tc-times-input"
              value={draft.start}
              onChange={(e) => onChange({ ...draft, start: e.target.value })}
              onKeyDown={enter}
            />
            <span className="tc-times-day">{day}</span>
          </span>
        </div>
        <div className="tc-times-field">
          <label className="tc-times-label" htmlFor={stopId}>
            {labels.stopTime}
          </label>
          <span className="tc-times-box">
            <input
              id={stopId}
              type="time"
              className="tc-times-input"
              value={draft.stop}
              onChange={(e) => onChange({ ...draft, stop: e.target.value, stopping: true })}
              onKeyDown={enter}
            />
          </span>
        </div>
      </div>
      <MonthCalendar value={draft.day} max={today} onChange={(d) => onChange({ ...draft, day: d })} labels={labels} />
    </>
  );
}

// --- The bar ---

export interface ClockBarLabels extends ProjectPickerLabels {
  /** The bar's name, for assistive tech. */
  clock: string;
  notePlaceholder: string;
  noteLabel: string;
  /** The list of earlier work that opens under the note. */
  suggestions: string;
  start: string;
  stop: string;
  /** What the picker is for while the clock runs. */
  switchProject: string;
  /** Replaces the note's placeholder when the pay period's timesheet is in. */
  locked: string;
  /** When the running stretch started, given the time as text. */
  since: (time: string) => string;
  missingDescription: string;
  missingProject: string;
  missingDescriptionAndProject: string;
  /** The running time's button, which changes when the stretch started or stops it earlier. */
  editTimes: string;
  /** The panel the button opens. */
  times: string;
  startTime: string;
  stopTime: string;
  /** The calendar the start's day is picked from. */
  startDay: string;
  today: string;
  previousMonth: string;
  nextMonth: string;
}

const barLabels: ClockBarLabels = {
  ...pickerLabels,
  clock: 'Clock',
  notePlaceholder: 'What are you working on?',
  noteLabel: 'What you are working on',
  suggestions: 'Previously tracked',
  start: 'Start the clock',
  stop: 'Stop the clock',
  switchProject: 'Project the clock is running on',
  locked: 'This pay period’s timesheet is submitted, so the clock is off.',
  since: (time) => `Running since ${time}`,
  missingDescription: 'Add a description to stop the clock and save this time entry.',
  missingProject: 'Choose a project to stop the clock and save this time entry.',
  missingDescriptionAndProject: 'Add a description and choose a project to stop the clock and save this time entry.',
  editTimes: 'Change the start or stop time',
  times: 'Start and stop',
  startTime: 'Start',
  stopTime: 'Stop',
  startDay: 'Day it started',
  today: 'Today',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
};

/** What the person was doing when something was refused. */
export type ClockAction = 'start' | 'stop' | 'switch' | 'note' | 'times';

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
  const [stopAttempt, setStopAttempt] = useState<string | null>(null);
  const errorId = useId();
  // Whether a press that began inside the bar is under way.
  const pressed = useRef(false);
  const timesId = useId();
  const timeButton = useRef<HTMLButtonElement>(null);
  const timesPanel = useRef<HTMLDivElement>(null);
  // What the start and stop panel holds while it is open.
  const [times, setTimes] = useState<TimesDraft | null>(null);
  // Escape leaves the panel without saving.
  const cancelTimes = useRef(false);
  const noteField = useRef<HTMLInputElement>(null);
  const suggestionsList = useRef<HTMLDivElement>(null);
  const suggestionsId = useId();
  // Earlier work opens under the note while it is being written; the cursor
  // is on none of it until the arrow keys move it.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState(-1);

  // The running time is the panel's invoker, so the browser opens and closes
  // it, and a press on the time doesn't count as one outside.
  useLayoutEffect(() => {
    timeButton.current?.setAttribute('popovertarget', timesId);
  });
  const timesOpen = !!times;
  useLayoutEffect(() => {
    const el = timesPanel.current;
    const button = timeButton.current;
    if (!timesOpen || !el || !button) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${rect.bottom + 6}px`;
    };
    position();
    el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [timesOpen]);

  const suggestionsShown = suggesting && clock.status === 'ready' && clock.suggestions.length > 0;
  useLayoutEffect(() => {
    const el = suggestionsList.current;
    const field = noteField.current;
    if (!suggestionsShown || !el || !field) return;
    el.showPopover();
    const position = () => {
      const rect = field.getBoundingClientRect();
      el.style.width = `${Math.max(rect.width, 288)}px`;
      el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${rect.bottom + 4}px`;
    };
    position();
    const follow = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target)) position();
    };
    window.addEventListener('resize', position);
    window.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', follow, true);
    };
  }, [suggestionsShown]);

  if (clock.status !== 'ready') return null;

  const missingDescription = clock.requireDescription && !clock.note.trim();
  const missingProject = clock.requireProject && !clock.projectId;
  const missing =
    missingDescription && missingProject
      ? labels.missingDescriptionAndProject
      : missingDescription
        ? labels.missingDescription
        : missingProject
          ? labels.missingProject
          : null;
  const stopError = running && stopAttempt === running.id ? missing : null;

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
    // While a suggestion is being saved, the note is already on its way.
    if (pressed.current || clock.busy || bar.current?.contains(e.relatedTarget)) return;
    clock.saveNote().then(onChanged, failed('note'));
  };
  const closeSuggestions = () => {
    setSuggesting(false);
    setSuggestion(-1);
  };
  const takeSuggestion = (work: RecentWork) => {
    closeSuggestions();
    clock.suggest(work).then((next) => {
      if (next) onChanged?.();
    }, failed('note'));
  };
  const shownSuggestions = suggestionsShown ? clock.suggestions : [];
  const activeSuggestion = shownSuggestions[suggestion];
  const projectOf = (id?: string) => (id ? clock.projects.find((p) => p.id === id) : undefined);
  const startWall = running ? wallClock(Date.parse(running.startedAt), clock.timeZone) : null;
  const saveTimes = (draft: TimesDraft) => {
    if (!running || !startWall) return;
    const moved = draft.start && (draft.day !== startWall.day || draft.start !== startWall.time);
    const startedAt = moved
      ? new Date(instant({ day: draft.day, time: draft.start }, clock.timeZone)).toISOString()
      : running.startedAt;
    const start = moved ? draft.start : startWall.time;
    // A stop at or before the start is the next day, so a night's work is one stretch.
    const endedAt =
      draft.stopping && draft.stop
        ? new Date(
            instant({ day: draft.stop <= start ? addDays(draft.day, 1) : draft.day, time: draft.stop }, clock.timeZone),
          ).toISOString()
        : undefined;
    if (startedAt === running.startedAt && !endedAt) return;
    if (endedAt && missing) {
      setStopAttempt(running.id);
      return;
    }
    clock.saveTimes({ startedAt, endedAt }).then(onChanged, failed('times'));
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
        if (running && missing) {
          setStopAttempt(running.id);
          return;
        }
        setStopAttempt(null);
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
        ref={noteField}
        className="tc-note"
        value={clock.note}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestionsShown}
        aria-controls={suggestionsShown ? suggestionsId : undefined}
        aria-activedescendant={activeSuggestion ? `${suggestionsId}-${suggestion}` : undefined}
        autoComplete="off"
        placeholder={clock.locked ? labels.locked : labels.notePlaceholder}
        aria-label={labels.noteLabel}
        disabled={clock.locked}
        aria-required={!!running && clock.requireDescription}
        aria-invalid={!!stopError && missingDescription}
        aria-describedby={stopError && missingDescription ? errorId : undefined}
        maxLength={2000}
        onChange={(e) => {
          clock.setNote(e.target.value);
          setSuggesting(true);
          setSuggestion(-1);
        }}
        // A stopped clock offers what was tracked before as soon as the note
        // is chosen; a running one waits until its note is changed.
        onFocus={running ? undefined : () => setSuggesting(true)}
        onBlur={(e) => {
          closeSuggestions();
          if (running) leaveNote(e);
        }}
        onKeyDown={(e) => {
          const count = shownSuggestions.length;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!suggestionsShown) {
              setSuggesting(true);
              return;
            }
            // Past either end is back on the note itself.
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setSuggestion((at) => ((at + 1 + step + count + 1) % (count + 1)) - 1);
            return;
          }
          if (e.key === 'Escape' && suggestionsShown) {
            // The list closes; a panel around the bar stays.
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            closeSuggestions();
            return;
          }
          if (e.key === 'Enter' && activeSuggestion) {
            e.preventDefault();
            takeSuggestion(activeSuggestion);
            return;
          }
          if (e.key === 'Tab') closeSuggestions();
          // While the clock runs, Enter is done with the note; it doesn't stop the clock.
          if (running && e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {suggestionsShown && (
        <div
          ref={suggestionsList}
          popover="manual"
          className="tc-popover tc-suggestions"
          // The note keeps focus while a suggestion is pressed.
          onPointerDown={(e) => e.preventDefault()}
        >
          <div id={suggestionsId} role="listbox" aria-label={labels.suggestions} className="tc-options">
            <div aria-hidden className="tc-group">
              {labels.suggestions}
            </div>
            {shownSuggestions.map((work, i) => {
              const project = projectOf(work.projectId);
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the note keeps focus and drives the list with the arrow keys
                <div
                  key={`${work.projectId ?? ''}:${work.note}`}
                  id={`${suggestionsId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === suggestion}
                  className={cx('tc-option', 'tc-suggestion', i === suggestion && 'tc-option-active')}
                  onPointerMove={() => setSuggestion(i)}
                  onClick={() => takeSuggestion(work)}
                >
                  <span className="tc-suggestion-note">{work.note}</span>
                  {project && (
                    <span className="tc-suggestion-project">
                      <ProjectDot projectId={project.id} />
                      <span className="tc-suggestion-project-name">{project.name}</span>
                      {project.customerName && <span className="tc-muted">· {project.customerName}</span>}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
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
      {running && startWall ? (
        <>
          <button
            ref={timeButton}
            type="button"
            className="tc-time tc-time-button"
            title={since}
            aria-label={labels.editTimes}
            aria-expanded={timesOpen}
            aria-controls={timesId}
            disabled={clock.locked || clock.busy}
          >
            <span role="timer">{stopwatch(now - Date.parse(running.startedAt))}</span>
          </button>
          <div
            ref={timesPanel}
            id={timesId}
            popover="auto"
            role="dialog"
            aria-label={labels.times}
            className="tc-popover tc-times"
            onKeyDownCapture={(e) => {
              if (e.key === 'Escape') cancelTimes.current = true;
            }}
            onToggle={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.newState === 'open') {
                cancelTimes.current = false;
                setTimes({
                  day: startWall.day,
                  start: startWall.time,
                  stop: wallClock(Date.now(), clock.timeZone).time,
                  stopping: false,
                });
                return;
              }
              if (times && !cancelTimes.current) saveTimes(times);
              setTimes(null);
            }}
          >
            {times && (
              <TimesFields
                draft={times}
                onChange={setTimes}
                today={wallClock(now, clock.timeZone).day}
                onDone={() => timesPanel.current?.hidePopover()}
                labels={labels}
              />
            )}
          </div>
        </>
      ) : (
        <span aria-hidden className="tc-time tc-time-idle">
          {stopwatch(0)}
        </span>
      )}
      <button
        type="submit"
        aria-describedby={stopError ? errorId : undefined}
        aria-label={running ? labels.stop : labels.start}
        disabled={clock.locked || clock.busy}
        className={cx('tc-go', !!running && 'tc-go-stop')}
      >
        <svg aria-hidden viewBox="0 0 16 16" fill="currentColor">
          {running ? <rect x="4" y="4" width="8" height="8" rx="1" /> : <path d="M5.5 3.5v9l7-4.5z" />}
        </svg>
      </button>
      {stopError && (
        <p id={errorId} role="alert" className="tc-stop-error">
          {stopError}
        </p>
      )}
    </form>
  );
}

// --- The clock as a button ---

export interface ClockButtonLabels extends ClockBarLabels {
  /** The button's text while the clock is stopped. */
  clockIn: string;
  /** The button's name while stopped, for assistive tech. */
  stopped: string;
  /** The button's name while running, given the project's name (or noProject). */
  running: (project: string) => string;
  noProject: string;
  /** The link to the full Timeclock under the bar, when there is one. */
  open: string;
}

const buttonLabels: ClockButtonLabels = {
  ...barLabels,
  clockIn: 'Clock in',
  stopped: 'Timeclock: clock stopped',
  running: (project) => `Timeclock: clock running on ${project}`,
  noProject: 'no project',
  open: 'Open Timeclock',
};

/**
 * The clock as a small button for a host's header: it shows whether the
 * clock runs and for how long, and opens the ClockBar beneath it to start,
 * stop or move it. Until Timeclock answers it holds its place, so the
 * header doesn't move when it appears; it draws nothing for someone
 * Timeclock doesn't know, or when Timeclock can't be reached.
 */
export function ClockButton({
  basePath,
  store,
  labels: given,
  className,
  href,
  onError,
  onSwitched,
  onChanged,
}: UseClockOptions & {
  labels?: Partial<ClockButtonLabels>;
  /** Added to the button, to match the host's other header buttons. */
  className?: string;
  /** The full Timeclock, linked beneath the bar. */
  href?: string;
  onError?: (error: ClockError | unknown, action: ClockAction) => void;
  onSwitched?: (entry: Entry) => void;
  onChanged?: () => void;
}) {
  const labels = { ...buttonLabels, ...given };
  const clock = useClock({ basePath, store });
  const { running } = clock;
  // Minutes only: the bar inside shows the seconds, on its own clock.
  const now = useSecond(!!running);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // The button is the popover's invoker, so the browser toggles it, and
  // Escape or a press elsewhere closes it, without the press on the button
  // counting as one outside. (Set here: React 18 and 19 spell it differently.)
  useLayoutEffect(() => {
    trigger.current?.setAttribute('popovertarget', panelId);
  });
  useLayoutEffect(() => {
    const el = panel.current;
    const button = trigger.current;
    if (!open || !el || !button) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${rect.bottom + 6}px`;
    };
    position();
    el.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(el);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [open]);

  if (clock.status === 'loading') {
    return (
      <span aria-hidden className={cx('tc-clock-button', 'tc-clock-button-loading', className)}>
        <svg viewBox="0 0 16 16" className="tc-clock-icon" />
        <span className="tc-clock-label">{labels.clockIn}</span>
      </span>
    );
  }
  if (clock.status !== 'ready') return null;
  const project = running && clock.projects.find((p) => p.id === running.projectId);
  const minutes = running ? Math.max(0, Math.floor((now - Date.parse(running.startedAt)) / 60000)) : 0;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={running ? labels.running(project ? projectLabel(project) : labels.noProject) : labels.stopped}
        className={cx('tc-clock-button', running ? 'tc-clock-button-running' : undefined, className)}
      >
        {running ? (
          <>
            <span
              className={cx('tc-clock-pulse', !running.projectId && 'tc-clock-pulse-none')}
              style={running.projectId ? ({ '--tc-hue': projectHue(running.projectId) } as CSSProperties) : undefined}
              aria-hidden
            >
              <ProjectDot projectId={running.projectId} />
            </span>
            <span className="tc-clock-elapsed">{`${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`}</span>
          </>
        ) : (
          <>
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="tc-clock-icon"
            >
              <circle cx="8" cy="8" r="6.25" />
              <path d="M8 4.5V8l2.25 1.5" strokeLinecap="round" />
            </svg>
            <span className="tc-clock-label">{labels.clockIn}</span>
          </>
        )}
      </button>
      <div
        ref={panel}
        id={panelId}
        popover="auto"
        role="dialog"
        aria-label={labels.clock}
        className="tc-clock-panel"
        onToggle={(e) => {
          // The project picker inside is a popover of its own.
          if (e.target === e.currentTarget) setOpen(e.newState === 'open');
        }}
      >
        {open && (
          <ClockBar
            store={clock.store}
            labels={labels}
            onError={onError}
            onSwitched={onSwitched}
            onChanged={onChanged}
          />
        )}
        {href && (
          <div className="tc-clock-footer">
            <a href={href} className="tc-clock-open">
              {labels.open}
            </a>
          </div>
        )}
      </div>
    </>
  );
}
