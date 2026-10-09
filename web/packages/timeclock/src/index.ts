// The Timeclock clock for a host application, with no look and no framework:
// a store that knows what is running and can start, stop and move the clock.
// It talks to a Timeclock mounted on the same origin, as the signed-in person.

/** A stretch of work. `endedAt` is absent while the clock is running. */
export interface Entry {
  id: string;
  personId: string;
  projectId?: string;
  startedAt: string;
  endedAt?: string;
  note: string;
}

/** A project time is recorded on. `customerName` is empty for internal work. */
export interface Project {
  id: string;
  name: string;
  customerName: string;
}

/** Something the person has tracked before: a note and the project it was on. */
export interface RecentWork {
  note: string;
  projectId?: string;
}

export interface ClockState {
  /**
   * `loading` until the first answer; `signed-out` when Timeclock doesn't
   * know the caller; `unavailable` when it can't be reached.
   */
  status: 'loading' | 'ready' | 'signed-out' | 'unavailable';
  /** The running stretch, if the clock is on. */
  running: Entry | null;
  /** The projects that take new time, internal ones first, then by customer. */
  projects: Project[];
  /** What the person has tracked before, each note and project once, the latest first. */
  recent: RecentWork[];
  /** Whether the organization requires a project on every entry. */
  requireProject: boolean;
  requireDescription: boolean;
  /** The pay period's timesheet is in, so the clock is off. */
  locked: boolean;
  /** The IANA time zone the person's times are shown in. */
  timeZone: string;
  /** A change is on its way. */
  busy: boolean;
}

export interface ClockOptions {
  /** Where Timeclock is mounted, such as "/timeclock". Empty at the site root. */
  basePath?: string;
  /** How to make requests; the page's own fetch by default. */
  fetch?: typeof fetch;
  /** How often to ask again while something is listening, in milliseconds. A clock can be stopped from another tab. */
  pollMs?: number;
}

/** What starts or moves the clock: a project and a note, both optional. */
export interface ClockInput {
  projectId?: string;
  note?: string;
}

/** A request Timeclock refused. `body` is the RFC 9457 problem it answered with. */
export class ClockError extends Error {
  constructor(
    readonly status: number,
    /** The problem's stable code, such as "project_required". */
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ClockError';
  }
}

export interface ClockStore {
  getState(): ClockState;
  /** Calls `listener` after every change. Listening keeps the store fresh; returns how to stop. */
  subscribe(listener: () => void): () => void;
  /** Asks Timeclock again. */
  refresh(): Promise<void>;
  start(input?: ClockInput): Promise<Entry>;
  stop(): Promise<Entry>;
  /**
   * Moves the running clock to other work without stopping it: the time so
   * far stays where it was, and the clock goes on from this instant.
   */
  switchTo(input: ClockInput): Promise<Entry>;
  /** Sets the running stretch's note. */
  saveNote(note: string): Promise<Entry>;
  /** Sets the running stretch's note and project, in place: the time so far goes with them. */
  describe(input: ClockInput): Promise<Entry>;
  /**
   * Moves when the running stretch started. With `endedAt` it stops there
   * instead of now. `note` defaults to the stretch's own.
   */
  saveTimes(times: { startedAt: string; endedAt?: string; note?: string }): Promise<Entry>;
  /** Starts the clock on what an entry was about; a running clock moves to it. */
  resume(entry: Pick<Entry, 'projectId' | 'note'>): Promise<Entry>;
}

const initial: ClockState = {
  status: 'loading',
  running: null,
  projects: [],
  recent: [],
  requireProject: false,
  requireDescription: false,
  locked: false,
  timeZone: 'UTC',
  busy: false,
};

/** Makes a clock store. Most hosts want {@link clockFor}, which shares one per base path. */
export function createClock(options: ClockOptions = {}): ClockStore {
  const base = `${(options.basePath ?? '').replace(/\/$/, '')}/api/v1`;
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const pollMs = options.pollMs ?? 60_000;
  const listeners = new Set<() => void>();
  let state = initial;
  let timer: ReturnType<typeof setInterval> | undefined;

  const set = (patch: Partial<ClockState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await request(base + path, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const problem = (json ?? {}) as { code?: string; detail?: string; title?: string };
      throw new ClockError(res.status, problem.code ?? '', problem.detail || problem.title || res.statusText, json);
    }
    return json as T;
  }

  const refresh = async () => {
    try {
      const [me, projects, sheet, recent] = await Promise.all([
        call<{
          person: { timezone: string };
          settings: { timezone: string; requireProject: boolean; requireDescription: boolean };
          running?: Entry;
        }>('GET', '/me'),
        call<{ projects: Project[] | null }>('GET', '/projects'),
        call<{ timesheet?: { status: string } }>('GET', '/timesheet'),
        // Suggestions are a nicety: a Timeclock without them still has a clock.
        call<{ recent: RecentWork[] | null }>('GET', '/entries/recent').catch(() => ({ recent: [] })),
      ]);
      const status = sheet.timesheet?.status;
      set({
        status: 'ready',
        running: me.running ?? null,
        projects: projects.projects ?? [],
        recent: recent.recent ?? [],
        requireProject: me.settings.requireProject,
        requireDescription: me.settings.requireDescription ?? false,
        locked: status === 'submitted' || status === 'approved',
        timeZone: me.person.timezone || me.settings.timezone,
      });
    } catch (err) {
      set({ status: err instanceof ClockError && err.status === 401 ? 'signed-out' : 'unavailable' });
    }
  };

  // One change at a time: the bar shows it is busy, then what is now true.
  const change = async (run: () => Promise<Entry>) => {
    set({ busy: true });
    try {
      const entry = await run();
      set({ running: entry.endedAt ? null : entry });
      return entry;
    } finally {
      set({ busy: false });
      void refresh();
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh();
  };

  const store: ClockStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(() => void refresh(), pollMs);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearInterval(timer);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        }
      };
    },
    refresh,
    start: (input = {}) =>
      change(() => call('POST', '/clock/in', { projectId: input.projectId || undefined, note: input.note ?? '' })),
    stop: () => change(() => call('POST', '/clock/out')),
    switchTo: (input) =>
      change(() => call('POST', '/clock/switch', { projectId: input.projectId || undefined, note: input.note ?? '' })),
    saveNote: (note) => {
      const running = state.running;
      if (!running)
        return Promise.reject(new ClockError(409, 'clock_not_running', 'the clock is not running', undefined));
      return change(() =>
        call('PUT', `/entries/${running.id}`, { projectId: running.projectId, startedAt: running.startedAt, note }),
      );
    },
    describe: ({ projectId, note }) => {
      const running = state.running;
      if (!running)
        return Promise.reject(new ClockError(409, 'clock_not_running', 'the clock is not running', undefined));
      return change(() =>
        call('PUT', `/entries/${running.id}`, {
          projectId: projectId || undefined,
          startedAt: running.startedAt,
          note: note ?? '',
        }),
      );
    },
    saveTimes: ({ startedAt, endedAt, note }) => {
      const running = state.running;
      if (!running)
        return Promise.reject(new ClockError(409, 'clock_not_running', 'the clock is not running', undefined));
      return change(() =>
        call('PUT', `/entries/${running.id}`, {
          projectId: running.projectId,
          startedAt,
          endedAt,
          note: note ?? running.note,
        }),
      );
    },
    resume: (entry) => (state.running ? store.switchTo(entry) : store.start(entry)),
  };
  return store;
}

const shared = new Map<string, ClockStore>();

/** The clock store for a Timeclock at a base path: one for the page, so everything showing the clock agrees. */
export function clockFor(basePath = ''): ClockStore {
  let store = shared.get(basePath);
  if (!store) {
    store = createClock({ basePath });
    shared.set(basePath, store);
  }
  return store;
}

/** "Customer / Project", or just the project for internal work. */
export function projectLabel(project: Project): string {
  return project.customerName ? `${project.customerName} / ${project.name}` : project.name;
}

/** A project's hue (0–359), the same wherever its time is shown. */
export function projectHue(projectId: string): number {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  // Steps of the golden angle keep any two projects' hues apart.
  return Math.round((h % 997) * 137.508) % 360;
}

/** Milliseconds as H:MM:SS, for a running clock. */
export function stopwatch(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
