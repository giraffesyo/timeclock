import { useErrorMessage } from '@parallelworks/problem/react';
import { TOOLTIP_ID } from '@parallelworks/ui';
import { ChevronLeftIcon, ChevronRightIcon, LockIcon } from '@parallelworks/ui/icons';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { CalendarEventPopover } from '@/components/calendar-event';
import { EntryDialog } from '@/components/entry-dialog';
import { useProjectName } from '@/components/project-select';
import { cn } from '@/lib/cn';
import { morph } from '@/lib/morph';
import { type CalendarEvent, type Entry, useAdjustEntry, useRememberMeeting, useSaveEntry } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, hoursMinutes, timeInput } from '@/lib/time';
import { clamp, dayBounds, HOUR, lanes, MINUTE, projectHue, rulerWindow, SNAP, type Span, snap } from '@/lib/timeline';
import { useMedia } from '@/lib/use-media';
import { useNow } from '@/lib/use-now';
import { useZone } from '@/lib/zone';

/** What a click or tap on empty time offers. */
const CLICKED = 15 * MINUTE;

/** A stretch being dragged: a new one, or an entry's start, end or whole. */
type Drag = Span & {
  kind: 'create' | 'start' | 'end' | 'move';
  /** The entry being changed; absent for a new stretch. */
  id?: string;
  /** How far the stretch may reach. */
  lo: number;
  hi: number;
  /** Where the pointer took hold: the fixed end of a new stretch, or the offset into a moved one. */
  grab: number;
  /** Whether the pointer has travelled, which tells a drag from a click. */
  moved: boolean;
  destination?: Day;
};

export type MovePreview = Span & { entry: Entry; day: Day };

type Block = Span & {
  entry: Entry;
  running: boolean;
  /** Wholly ahead of now: planned time, which counts once it passes. */
  planned: boolean;
  /** The entry reaches past this day's midnight on that side. */
  clippedStart: boolean;
  clippedEnd: boolean;
};

const iso = (ms: number) => new Date(ms).toISOString();
/** Allow normal hand movement during a click before picking up the entry. */
const DRAG_DISTANCE = 8;

/**
 * A day as a ruler: each entry is a block placed by the hour, and the running
 * clock's block grows as time passes. Dragging empty space adds time, dragging
 * a block moves it, and dragging an edge changes when it starts or ends; a
 * block opens for editing. Everything lands on five-minute marks (one-minute
 * with Shift) and stops at now. Entries that overlap sit side by side. The
 * edges are sliders for the keyboard.
 *
 * On its own the ruler runs left to right on a wide screen and top to bottom
 * on a narrow one. As a column of a week (`hours` given) it runs top to
 * bottom over hours its parent chose and labels, and can keep a strip on its
 * right for the caller's calendar: each event there opens to add its time.
 */
export function DayTimeline({
  day,
  entries,
  readOnly,
  personId,
  hours: shared,
  movePreview,
  onMovePreview,
  events,
  calendar,
}: {
  day: Day;
  /** The entries that touch the day. */
  entries: Entry[];
  /** Locked, or not the caller's to change: the day shows without controls. */
  readOnly?: boolean;
  /** Whose day, when it isn't the caller's. */
  personId?: string;
  /** The hours from midnight to show, as a column of a week that shows the same hours in every day. */
  hours?: { from: number; to: number };
  movePreview?: MovePreview | null;
  onMovePreview?: (preview: MovePreview | null) => void;
  /** The calendar events that touch the day, in a strip beside the time; absent keeps no strip. */
  events?: CalendarEvent[];
  /** Their calendar's name. */
  calendar?: string;
}) {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const { today, settings } = useSession();
  const planning = settings.allowPlannedTime;
  const zone = useZone(personId ?? entries[0]?.personId);
  const projectName = useProjectName();
  const adjust = useAdjustEntry();
  const wide = useMedia('(min-width: 40rem)');
  const column = !!shared;
  const across = !column && wide;

  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const keyTimer = useRef(0);
  const suppressClick = useRef(false);
  const press = useRef({ x: 0, y: 0 });
  // Pointer events can arrive before React paints; keep the current gesture
  // synchronously, and only render a drag preview once it becomes a drag.
  const gesture = useRef<Drag | null>(null);
  const touchTap = useRef<(Span & { x: number; y: number }) | null>(null);
  // A new stretch opens on the click that ends its press: opened sooner, the
  // browser takes that click for one outside the popover and closes it.
  const pendingNew = useRef<Span | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [tooltipEntries, setTooltipEntries] = useState<Set<string>>(new Set());
  const [earlier, setEarlier] = useState(0);
  const [later, setLater] = useState(0);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [adding, setAdding] = useState<Span | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addNote, setAddNote] = useState('');
  // The calendar meeting a new stretch was copied from, to remember its project.
  const [addMeeting, setAddMeeting] = useState('');
  // The open event by id: its details stay current as the calendar reads again.
  const [openEventId, setOpenEventId] = useState<string | null>(null);

  const isToday = day === today;
  const now = useNow(15_000, isToday);
  const bounds = dayBounds(day, zone);
  // Time can't be recorded in the future, unless the organization allows planned time.
  const cap = planning ? bounds.end : clamp(Math.floor(now / SNAP) * SNAP, bounds.start, bounds.end);
  const editable = !readOnly && (planning || day <= today);

  const blocks: Block[] = entries
    .map((entry) => {
      const start = Date.parse(entry.startedAt);
      const end = entry.endedAt ? Date.parse(entry.endedAt) : Math.max(now, start);
      const held = drag?.id === entry.id ? drag : null;
      return {
        entry,
        running: !entry.endedAt,
        // Wholly ahead: it counts once it passes.
        planned: !!entry.endedAt && start >= now,
        clippedStart: start < bounds.start,
        clippedEnd: end > bounds.end,
        start: held ? held.start : Math.max(start, bounds.start),
        end: held ? held.end : Math.min(end, bounds.end),
      };
    })
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const side = lanes(blocks);
  const suggestions = (column ? (events ?? []) : [])
    .map((event) => ({
      event,
      start: Math.max(Date.parse(event.startedAt), bounds.start),
      end: Math.min(Date.parse(event.endedAt), bounds.end),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const eventSide = lanes(suggestions);
  const openEvent = (openEventId && events?.find((e) => e.id === openEventId)) || null;

  const win = shared
    ? { start: bounds.start + shared.from * HOUR, end: Math.min(bounds.end, bounds.start + shared.to * HOUR) }
    : rulerWindow(bounds, isToday ? [...blocks, { start: now, end: now }] : blocks, earlier, later);
  const length = win.end - win.start;
  const at = (ms: number) => clamp((ms - win.start) / length, 0, 1);
  const place = (s: Span) => ({ '--s': at(s.start), '--w': at(s.end) - at(s.start) }) as CSSProperties;
  const marks: number[] = [];
  for (let h = win.start; h <= win.end; h += HOUR) marks.push(h);
  // Every hour is named until they crowd; then every other one.
  const labelEvery = across && marks.length > 17 ? 2 : 1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: remeasure the rendered blocks when their entries or ruler layout change.
  useLayoutEffect(() => {
    const bodies = root.current?.querySelectorAll<HTMLElement>('[data-entry] .tl-body');
    if (!bodies) return;
    const measure = () => {
      const next = new Set<string>();
      for (const body of bodies) {
        const id = body.parentElement?.dataset['entry'];
        if (id && needsTooltip(body)) next.add(id);
      }
      setTooltipEntries((previous) =>
        previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const body of bodies) observer.observe(body);
    return () => observer.disconnect();
  }, [entries, across, length]);

  const clock = (ms: number) => format.dateTime(new Date(ms), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const hourLabel = (ms: number) => format.dateTime(new Date(ms), { hour: 'numeric', timeZone: zone });
  const range = (s: Span) => t('range', { start: clock(s.start), end: clock(s.end) });
  const span = (s: Span) => tc('duration', hoursMinutes(s.end - s.start));

  const instant = (e: { clientX: number; clientY: number }) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return win.start;
    const f = across ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    return win.start + clamp(f, 0, 1) * length;
  };

  // An edge past this day's midnight isn't on the ruler, so it keeps its time.
  const save = (b: Block, next: Span) => {
    const startedAt = b.clippedStart ? b.entry.startedAt : iso(next.start);
    const endedAt = b.running ? undefined : b.clippedEnd ? b.entry.endedAt : iso(next.end);
    const same = (x?: string, y?: string) => (x ? Date.parse(x) : 0) === (y ? Date.parse(y) : 0);
    if (same(startedAt, b.entry.startedAt) && same(endedAt, b.entry.endedAt)) return;
    adjust.mutate(
      { entry: b.entry, startedAt, endedAt },
      { onError: (err) => toast.error(`${t('adjustFailed')} ${errorMessage(err)}`) },
    );
  };

  const blockEl = (id: string) => root.current?.querySelector<HTMLElement>(`[data-entry="${id}"]`) ?? null;
  const draftEl = () => root.current?.querySelector<HTMLElement>('[data-draft]') ?? null;
  const eventEl = (id: string) => root.current?.querySelector<HTMLElement>(`[data-event="${CSS.escape(id)}"]`) ?? null;
  const openEntry = (entry: Entry) => setEditing(entry);
  const activateEntry = (e: MouseEvent, entry: Entry) => {
    e.stopPropagation();
    // A completed pointer drag also emits a click. Every other activation,
    // including keyboard activation and clicks after lost capture, edits.
    if (e.detail > 0 && suppressClick.current) return;
    openEntry(entry);
  };
  const openNew = (s: Span, note = '', meeting = '') => {
    // The stretch is drawn first, so the editor can open beside it on the
    // calendar, or the dialog out of it on a narrow day.
    flushSync(() => {
      setDrag(null);
      setAdding(s);
      setAddNote(note);
      setAddMeeting(meeting);
    });
    if (column) setAddOpen(true);
    else morph(() => setAddOpen(true), draftEl);
  };
  const closeNew = () => {
    setAddOpen(false);
    setAdding(null);
  };
  // An event's time on this day, up to now unless time can be planned.
  const eventSpan = (event: CalendarEvent): Span => ({
    start: Math.max(Date.parse(event.startedAt), bounds.start),
    end: Math.min(Date.parse(event.endedAt), bounds.end, cap),
  });
  const saveEntry = useSaveEntry();
  const remember = useRememberMeeting();
  // A meeting copied before goes straight onto the week, to the project it
  // went to then. The first time, the form asks which, and remembers it.
  const copyEvent = (event: CalendarEvent, ask: boolean) => {
    const s = eventSpan(event);
    setOpenEventId(null);
    if (ask || !event.remembered) {
      openNew(s, event.title, event.meeting ?? '');
      return;
    }
    saveEntry.mutate(
      { projectId: event.projectId, startedAt: iso(s.start), endedAt: iso(s.end), note: event.title },
      {
        onSuccess: () => toast.success(t('eventCopied', { project: projectName(event.projectId) })),
        // Refused (a day since locked, say): the form shows why, to fix it there.
        onError: () => openNew(s, event.title, event.meeting ?? ''),
      },
    );
  };

  // --- Pointer ---

  const begin = (e: PointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    // Capture on the pressed control so the browser's click still reaches it.
    e.currentTarget.setPointerCapture(e.pointerId);
    suppressClick.current = false;
    pendingNew.current = null;
    press.current = { x: e.clientX, y: e.clientY };
    gesture.current = d;
    setHover(null);
  };

  const beginCreate = (e: PointerEvent) => {
    pendingNew.current = null;
    if (!editable || e.button !== 0 || adding) return;
    const ms = instant(e);
    if (ms > cap + SNAP || cap - bounds.start < SNAP) return;
    const anchor = clamp(snap(ms), bounds.start, cap);
    if (e.pointerType === 'touch') {
      // A touch scrolls the page; a tap adds a quarter hour here.
      const end = Math.min(anchor + CLICKED, cap);
      if (end - anchor >= SNAP) touchTap.current = { start: anchor, end, x: e.clientX, y: e.clientY };
      return;
    }
    begin(e, { kind: 'create', start: anchor, end: anchor, lo: bounds.start, hi: cap, grab: anchor, moved: false });
  };

  const beginEdge = (e: PointerEvent, b: Block, kind: 'start' | 'end') => {
    if (e.button !== 0) return;
    begin(e, { kind, id: b.entry.id, start: b.start, end: b.end, lo: bounds.start, hi: cap, grab: 0, moved: false });
  };

  const beginMove = (e: PointerEvent, b: Block) => {
    suppressClick.current = false;
    // The press is the block's: the track under it must not take it for a new stretch.
    e.stopPropagation();
    if (e.button !== 0 || e.pointerType === 'touch') return;
    // A running entry, or one that crosses midnight, opens but doesn't move.
    const fixed = b.running || b.clippedStart || b.clippedEnd;
    begin(e, {
      kind: 'move',
      id: b.entry.id,
      start: b.start,
      end: b.end,
      lo: fixed ? b.start : bounds.start,
      hi: fixed ? b.end : cap,
      grab: instant(e) - b.start,
      moved: false,
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    if (touchTap.current && Math.hypot(e.clientX - touchTap.current.x, e.clientY - touchTap.current.y) > 8)
      touchTap.current = null;
    const ms = instant(e);
    const drag = gesture.current;
    if (!drag) {
      if (e.pointerType !== 'mouse' || !editable) return;
      setHover(e.target === track.current && ms <= cap + SNAP ? clamp(snap(ms), bounds.start, cap) : null);
      return;
    }
    if (!drag.moved && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) < DRAG_DISTANCE) return;
    const step = e.shiftKey ? MINUTE : SNAP;
    const to = snap(ms, step);
    let next: Span;
    let destination: Day | undefined;
    switch (drag.kind) {
      case 'create': {
        const other = clamp(to, drag.lo, drag.hi);
        next = { start: Math.min(drag.grab, other), end: Math.max(drag.grab, other) };
        break;
      }
      case 'start':
        next = { start: clamp(to, drag.lo, drag.end - SNAP), end: drag.end };
        break;
      case 'end':
        next = { start: drag.start, end: clamp(to, drag.start + SNAP, drag.hi) };
        break;
      case 'move': {
        const size = drag.end - drag.start;
        const target = column
          ? document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('.tl-column .tl-track'))
          : null;
        const targetDay = target instanceof HTMLElement ? target.dataset['day'] : undefined;
        // Locked days, future days without planned time, and entries crossing midnight cannot be moved into another column.
        if (target && (targetDay !== day || drag.destination)) {
          const b = blocks.find((x) => x.entry.id === drag.id);
          if (
            !targetDay ||
            !(target instanceof HTMLElement) ||
            target.dataset['editable'] !== 'true' ||
            !b ||
            b.running ||
            b.clippedStart ||
            b.clippedEnd
          )
            return;
          const targetBounds = dayBounds(targetDay, zone);
          const targetCap = planning
            ? targetBounds.end
            : clamp(Math.floor(now / SNAP) * SNAP, targetBounds.start, targetBounds.end);
          if (targetCap - targetBounds.start < size) return;
          const r = target.getBoundingClientRect();
          const targetInstant =
            targetBounds.start +
            ((e.clientY - r.top) / r.height) *
              Math.min(targetBounds.end - targetBounds.start, (shared?.to ?? 24) * HOUR);
          const start = clamp(snap(targetInstant - drag.grab, step), targetBounds.start, targetCap - size);
          destination = targetDay === day ? undefined : targetDay;
          next = { start, end: start + size };
          onMovePreview?.(destination ? { ...next, entry: b.entry, day: destination } : null);
          break;
        }
        if (column && !target) return;
        const start = clamp(snap(ms - drag.grab, step), drag.lo, Math.max(drag.lo, drag.hi - size));
        next = { start, end: start + size };
        break;
      }
    }
    if (!drag.moved || next.start !== drag.start || next.end !== drag.end || destination !== drag.destination) {
      gesture.current = { ...drag, ...next, destination, moved: true };
      setDrag(gesture.current);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (touchTap.current) {
      const tap = touchTap.current;
      touchTap.current = null;
      pendingNew.current = { start: tap.start, end: tap.end };
      return;
    }
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = null;
    suppressClick.current = drag.moved;
    setDrag(null);
    onMovePreview?.(null);
    if (drag.kind === 'create') {
      // A click without a drag offers a quarter hour from there.
      const end = drag.moved ? drag.end : Math.min(drag.start + CLICKED, drag.hi);
      if (end - drag.start >= SNAP) pendingNew.current = { start: drag.start, end };
      return;
    }
    const b = blocks.find((x) => x.entry.id === drag.id);
    if (!b) return;
    if (column && drag.kind === 'move' && drag.moved) {
      const target = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('.tl-column .tl-track'));
      if (
        !(target instanceof HTMLElement) ||
        target.dataset['editable'] !== 'true' ||
        target.dataset['day'] !== (drag.destination ?? day)
      )
        return;
    }
    if (drag.moved) save(b, drag);
  };

  // --- Keyboard: an edge is a slider ---

  useEffect(() => () => window.clearTimeout(keyTimer.current), []);

  const nudge = (e: KeyboardEvent, b: Block, kind: 'start' | 'end') => {
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, PageUp: -6, PageDown: 6 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const delta = dir * (e.shiftKey ? MINUTE : SNAP);
    const next =
      kind === 'start'
        ? { start: clamp(b.start + delta, bounds.start, b.end - SNAP), end: b.end }
        : { start: b.start, end: clamp(b.end + delta, b.start + SNAP, cap) };
    setDrag({ kind, id: b.entry.id, ...next, lo: bounds.start, hi: cap, grab: 0, moved: true });
    // Saved once the keys rest, so a held arrow is one change.
    window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => {
      setDrag(null);
      save(b, next);
    }, 500);
  };

  const draft = drag?.kind === 'create' ? (drag.moved ? drag : null) : adding;
  const held = drag && drag.kind !== 'create' ? drag : null;
  // What the pointer is reading out: the stretch in hand, or the mark under it.
  const readout = drag?.moved ? drag : null;

  return (
    <div
      ref={root}
      className={cn(
        'tl',
        across && 'tl-across',
        column && 'tl-column',
        column && events && 'tl-aside',
        drag && 'tl-dragging',
        drag && (drag.kind === 'move' ? 'cursor-grabbing' : 'tl-resizing'),
      )}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        suppressClick.current = !!gesture.current?.moved;
        gesture.current = null;
        setDrag(null);
        touchTap.current = null;
        onMovePreview?.(null);
      }}
      onLostPointerCapture={() => {
        if (!gesture.current) return;
        suppressClick.current = gesture.current.moved;
        gesture.current = null;
        setDrag(null);
        onMovePreview?.(null);
      }}
      onPointerLeave={() => setHover(null)}
      style={{ '--tl-hours': length / HOUR } as CSSProperties}
    >
      {/* The hours. A column's are named by the week around it. */}
      {!column && (
        <div className="tl-scale" aria-hidden>
          {marks.map((h, i) => (
            <span key={h} className="tl-at tl-hour" style={{ '--s': at(h) } as CSSProperties}>
              {i % labelEvery === 0 && <span className="tl-hour-label tabular">{hourLabel(h)}</span>}
            </span>
          ))}
        </div>
      )}

      <div className="tl-row">
        {!column && win.start > bounds.start && (
          <button
            type="button"
            className="tl-more tl-more-start"
            aria-label={t('earlier')}
            data-tooltip-id={TOOLTIP_ID}
            data-tooltip-content={t('earlier')}
            onClick={() => setEarlier(earlier + 2)}
          >
            <ChevronLeftIcon aria-hidden className={cn('size-3.5', !across && 'rotate-90')} />
          </button>
        )}

        {/* Dragging here is the pointer's shortcut; the Add time button and each block's own controls are the keyboard's. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the click only finishes a pointer press begun here. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard adds time with the Add time button. */}
        <div
          ref={track}
          data-day={day}
          data-editable={editable}
          className={cn('tl-track', editable && 'tl-track-editable')}
          onPointerDown={beginCreate}
          onClick={() => {
            const s = pendingNew.current;
            pendingNew.current = null;
            if (s) openNew(s);
          }}
        >
          {marks.slice(1, -1).map((h) => (
            <span key={h} aria-hidden className="tl-at tl-grid" style={{ '--s': at(h) } as CSSProperties} />
          ))}

          {blocks.map((b, i) => {
            const name = projectName(b.entry.projectId);
            const title = b.entry.note || name;
            const described = t('block', {
              project: b.entry.note ? `${b.entry.note}, ${name}` : name,
              range: b.running ? t('rangeRunning', { start: clock(b.start) }) : range(b),
              length: span(b),
            });
            const label = b.planned ? t('plannedBlock', { block: described }) : described;
            const live = editable && !b.entry.locked;
            const inHand = held?.id === b.entry.id;
            const slider = (kind: 'start' | 'end') => (
              <span
                role="slider"
                tabIndex={0}
                className={cn('tl-handle', kind === 'start' ? 'tl-handle-start' : 'tl-handle-end')}
                aria-label={t(kind === 'start' ? 'startOf' : 'endOf', { project: title })}
                aria-orientation={across ? 'horizontal' : 'vertical'}
                aria-valuemin={0}
                aria-valuemax={Math.round((bounds.end - bounds.start) / MINUTE)}
                aria-valuenow={Math.round(((kind === 'start' ? b.start : b.end) - bounds.start) / MINUTE)}
                aria-valuetext={clock(kind === 'start' ? b.start : b.end)}
                onPointerDown={(e) => beginEdge(e, b, kind)}
                onClick={(e) => activateEntry(e, b.entry)}
                onKeyDown={(e) => nudge(e, b, kind)}
              />
            );
            // In hand, a block says when it now runs; at rest, what it is.
            const text = inHand ? (
              <BlockText name={range(b)} detail={span(b)} />
            ) : (
              <BlockText name={title} sub={b.entry.note ? name : undefined} detail={span(b)} locked={b.entry.locked} />
            );
            return (
              <div
                key={b.entry.id}
                data-entry={b.entry.id}
                data-tooltip-id={!drag && !editing && tooltipEntries.has(b.entry.id) ? TOOLTIP_ID : undefined}
                data-tooltip-content={tooltipEntries.has(b.entry.id) ? label : undefined}
                className={cn(
                  'tl-pos tl-block',
                  !b.entry.projectId && 'tl-plain',
                  b.running && 'tl-running',
                  b.planned && 'tl-planned',
                  b.entry.locked && 'tl-locked',
                  b.clippedStart && 'tl-clipped-start',
                  b.clippedEnd && 'tl-clipped-end',
                  inHand && 'tl-held',
                  inHand && drag?.destination && 'invisible',
                )}
                style={
                  {
                    ...place(b),
                    '--lane': side[i]?.lane ?? 0,
                    '--lanes': side[i]?.of ?? 1,
                    '--hue': b.entry.projectId ? projectHue(b.entry.projectId) : 0,
                  } as CSSProperties
                }
              >
                {live ? (
                  <button
                    type="button"
                    className="tl-body"
                    aria-label={t('editBlock', { block: label })}
                    onPointerDown={(e) => beginMove(e, b)}
                    onClick={(e) => activateEntry(e, b.entry)}
                  >
                    {text}
                  </button>
                ) : (
                  <div
                    className="tl-body"
                    role="img"
                    aria-label={b.entry.locked ? t('lockedBlock', { block: label }) : label}
                  >
                    {text}
                  </div>
                )}
                {live && !b.clippedStart && slider('start')}
                {live && !b.running && !b.clippedEnd && slider('end')}
              </div>
            );
          })}

          {movePreview?.day === day && (
            <div
              aria-hidden
              className="tl-pos tl-block tl-held pointer-events-none"
              style={
                {
                  ...place(movePreview),
                  '--lane': 0,
                  '--lanes': 1,
                  '--hue': movePreview.entry.projectId ? projectHue(movePreview.entry.projectId) : 0,
                } as CSSProperties
              }
            >
              <div className="tl-body">
                <BlockText
                  name={movePreview.entry.note || projectName(movePreview.entry.projectId)}
                  detail={range(movePreview)}
                />
              </div>
            </div>
          )}

          {suggestions.map((s, i) => {
            const title = s.event.title || t('untitled');
            return (
              <button
                key={s.event.id}
                type="button"
                data-event={s.event.id}
                className={cn('tl-event', openEvent?.id === s.event.id && 'tl-event-open')}
                style={
                  {
                    ...place(s),
                    '--lane': eventSide[i]?.lane ?? 0,
                    '--lanes': eventSide[i]?.of ?? 1,
                  } as CSSProperties
                }
                aria-label={t('event', { title, range: range(s) })}
                data-tooltip-id={!drag && !openEvent ? TOOLTIP_ID : undefined}
                data-tooltip-content={`${title} · ${range(s)}`}
                // The press is the event's: the track under it must not take it for a new stretch.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenEventId(s.event.id);
                }}
              >
                <span className="tl-event-title">{title}</span>
              </button>
            );
          })}

          {draft && (
            <div data-draft className="tl-pos tl-draft" style={place(draft)} aria-hidden>
              <span className="tl-body">
                <BlockText name={column ? range(draft) : t('new')} detail={span(draft)} />
              </span>
            </div>
          )}

          {hover !== null && (
            <span aria-hidden className="tl-at tl-cursor" style={{ '--s': at(hover) } as CSSProperties}>
              {column && <span className="tl-cursor-label tabular">{clock(hover)}</span>}
            </span>
          )}

          {isToday && now >= win.start && now <= win.end && (
            <span aria-hidden className="tl-at tl-now" style={{ '--s': at(now) } as CSSProperties} />
          )}
        </div>

        {!column && win.end < bounds.end && (
          <button
            type="button"
            className="tl-more tl-more-end"
            aria-label={t('later')}
            data-tooltip-id={TOOLTIP_ID}
            data-tooltip-content={t('later')}
            onClick={() => setLater(later + 2)}
          >
            <ChevronRightIcon aria-hidden className={cn('size-3.5', !across && 'rotate-90')} />
          </button>
        )}
      </div>

      {/* What is in hand, in words: it follows the pointer and is announced for the keyboard. */}
      <p className={cn('tl-readout tabular', column && 'sr-only')} aria-live="polite">
        {readout ? (
          <span className="font-medium text-foreground">
            {t('readout', { range: range(readout), length: span(readout) })}
          </span>
        ) : hover !== null ? (
          t('addAt', { time: clock(hover) })
        ) : editable && !column ? (
          across ? (
            t('hint')
          ) : (
            t('hintTouch')
          )
        ) : null}
      </p>

      <EntryDialog
        open={!!editing}
        onClose={() => {
          setEditing(null);
        }}
        entry={editing ?? undefined}
        anchor={column && editing ? blockEl(editing.id) : undefined}
        day={day}
      />
      <EntryDialog
        open={addOpen}
        onClose={closeNew}
        day={day}
        personId={personId}
        start={adding ? timeInput(iso(adding.start), zone) : undefined}
        end={adding ? timeInput(iso(adding.end), zone) : undefined}
        note={addNote}
        anchor={column && addOpen ? draftEl() : undefined}
        onSaved={(saved) => {
          if (addMeeting) remember.mutate({ meeting: addMeeting, projectId: saved.projectId ?? undefined });
        }}
      />
      {openEvent && eventEl(openEvent.id) && (
        <CalendarEventPopover
          event={openEvent}
          calendar={calendar}
          zone={zone}
          anchor={eventEl(openEvent.id) as HTMLElement}
          onClose={() => setOpenEventId(null)}
          projectName={openEvent.remembered ? projectName(openEvent.projectId) : undefined}
          onCopy={
            editable && !adding && eventSpan(openEvent).end - eventSpan(openEvent).start >= MINUTE
              ? (ask) => copyEvent(openEvent, ask)
              : undefined
          }
        />
      )}
    </div>
  );
}

/** Only supplement details the block cannot fit visibly. */
function needsTooltip(body: HTMLElement): boolean {
  const text = body.querySelector<HTMLElement>('.tl-text');
  if (!text || getComputedStyle(text).display === 'none') return true;
  return Array.from(text.children).some(
    (line) =>
      line instanceof HTMLElement &&
      (getComputedStyle(line).display === 'none' ||
        line.scrollWidth > line.clientWidth ||
        line.scrollHeight > body.clientHeight),
  );
}

/** A block's words, which show only when the block has room for them. */
function BlockText({ name, sub, detail, locked }: { name: string; sub?: string; detail: string; locked?: boolean }) {
  return (
    <span className="tl-text">
      <span className="tl-name">
        {locked && <LockIcon aria-hidden className="mr-1 inline size-3 align-[-1px]" />}
        {name}
      </span>
      {sub && <span className="tl-sub">{sub}</span>}
      <span className="tl-detail tabular">{detail}</span>
    </span>
  );
}
