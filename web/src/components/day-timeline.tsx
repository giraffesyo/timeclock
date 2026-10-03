import { useErrorMessage } from '@parallelworks/problem/react';
import { TOOLTIP_ID } from '@parallelworks/ui';
import { ChevronLeftIcon, ChevronRightIcon, LockIcon } from '@parallelworks/ui/icons';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { EntryDialog } from '@/components/entry-dialog';
import { useProjectName } from '@/components/project-select';
import { cn } from '@/lib/cn';
import { morph } from '@/lib/morph';
import { type Entry, useAdjustEntry } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, hoursMinutes, timeInput } from '@/lib/time';
import {
  clamp,
  dayBounds,
  gapAround,
  HOUR,
  MINUTE,
  projectHue,
  rulerWindow,
  SNAP,
  type Span,
  snap,
} from '@/lib/timeline';
import { useMedia } from '@/lib/use-media';
import { useNow } from '@/lib/use-now';

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
};

type Block = Span & {
  entry: Entry;
  running: boolean;
  /** The entry reaches past this day's midnight on that side. */
  clippedStart: boolean;
  clippedEnd: boolean;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A day as a ruler: each entry is a block placed by the hour, and the running
 * clock's block grows as time passes. Dragging empty space adds time, dragging
 * a block moves it, and dragging an edge changes when it starts or ends; a
 * block opens for editing. Everything lands on five-minute marks (one-minute
 * with Shift) and stops at its neighbours and at now. The edges are sliders
 * for the keyboard. On a narrow screen the ruler runs top to bottom.
 */
export function DayTimeline({
  day,
  entries,
  readOnly,
  personId,
}: {
  day: Day;
  entries: Entry[];
  /** Locked, or not the caller's to change: the day shows without controls. */
  readOnly?: boolean;
  /** Whose day, when it isn't the caller's. */
  personId?: string;
}) {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const { today, settings } = useSession();
  const zone = settings.timezone;
  const projectName = useProjectName();
  const adjust = useAdjustEntry();
  const wide = useMedia('(min-width: 40rem)');

  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const keyTimer = useRef(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [earlier, setEarlier] = useState(0);
  const [later, setLater] = useState(0);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [adding, setAdding] = useState<Span | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const pointer = useRef('mouse');

  const isToday = day === today;
  const now = useNow(15_000, isToday || entries.some((e) => !e.endedAt));
  const bounds = dayBounds(day, zone);
  // Time can't be recorded in the future.
  const cap = clamp(Math.floor(now / SNAP) * SNAP, bounds.start, bounds.end);
  const editable = !readOnly && day <= today;

  const blocks: Block[] = entries
    .map((entry) => {
      const start = Date.parse(entry.startedAt);
      const end = entry.endedAt ? Date.parse(entry.endedAt) : Math.max(now, start);
      const held = drag?.id === entry.id ? drag : null;
      return {
        entry,
        running: !entry.endedAt,
        clippedStart: start < bounds.start,
        clippedEnd: end > bounds.end,
        start: held ? held.start : Math.max(start, bounds.start),
        end: held ? held.end : Math.min(end, bounds.end),
      };
    })
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const win = rulerWindow(bounds, isToday ? [...blocks, { start: now, end: now }] : blocks, earlier, later);
  const length = win.end - win.start;
  const at = (ms: number) => clamp((ms - win.start) / length, 0, 1);
  const place = (s: Span) => ({ '--s': at(s.start), '--w': at(s.end) - at(s.start) }) as CSSProperties;
  const hours: number[] = [];
  for (let h = win.start; h <= win.end; h += HOUR) hours.push(h);
  // Every hour is named until they crowd; then every other one.
  const labelEvery = wide && hours.length > 17 ? 2 : 1;

  const clock = (ms: number) => format.dateTime(new Date(ms), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const hourLabel = (ms: number) => format.dateTime(new Date(ms), { hour: 'numeric', timeZone: zone });
  const range = (s: Span) => t('range', { start: clock(s.start), end: clock(s.end) });
  const span = (s: Span) => tc('duration', hoursMinutes(s.end - s.start));

  const others = (id?: string) => blocks.filter((b) => b.entry.id !== id);
  const instant = (e: { clientX: number; clientY: number }) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return win.start;
    const f = wide ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
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
  const openEntry = (entry: Entry) =>
    morph(
      () => setEditing(entry),
      () => blockEl(entry.id),
    );
  const openNew = (s: Span) => {
    // The stretch is drawn first, so the dialog can open out of it.
    flushSync(() => {
      setDrag(null);
      setAdding(s);
    });
    morph(() => setAddOpen(true), draftEl);
  };
  const closeNew = () => {
    setAddOpen(false);
    setAdding(null);
  };

  // --- Pointer ---

  const begin = (e: PointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    root.current?.setPointerCapture(e.pointerId);
    setHover(null);
    setDrag(d);
  };

  const beginCreate = (e: PointerEvent) => {
    if (!editable || e.button !== 0 || adding) return;
    const ms = instant(e);
    const gap = gapAround(ms, blocks, { start: bounds.start, end: cap });
    if (!gap) return;
    const anchor = clamp(snap(ms), gap.start, gap.end);
    if (e.pointerType === 'touch') {
      // A touch scrolls the page; a tap adds an hour here.
      const end = Math.min(anchor + HOUR, gap.end);
      if (end - anchor >= SNAP) openNew({ start: anchor, end });
      return;
    }
    begin(e, { kind: 'create', start: anchor, end: anchor, lo: gap.start, hi: gap.end, grab: anchor, moved: false });
  };

  const beginEdge = (e: PointerEvent, b: Block, kind: 'start' | 'end') => {
    if (e.button !== 0) return;
    const gap = gapAround((b.start + b.end) / 2, others(b.entry.id), { start: bounds.start, end: cap });
    if (!gap) return;
    begin(e, { kind, id: b.entry.id, start: b.start, end: b.end, lo: gap.start, hi: gap.end, grab: 0, moved: false });
  };

  const beginMove = (e: PointerEvent, b: Block) => {
    pointer.current = e.pointerType;
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const gap = gapAround((b.start + b.end) / 2, others(b.entry.id), { start: bounds.start, end: cap });
    // A running entry, or one that crosses midnight, opens but doesn't move.
    const fixed = b.running || b.clippedStart || b.clippedEnd || !gap;
    begin(e, {
      kind: 'move',
      id: b.entry.id,
      start: b.start,
      end: b.end,
      lo: fixed ? b.start : gap.start,
      hi: fixed ? b.end : gap.end,
      grab: instant(e) - b.start,
      moved: false,
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    const ms = instant(e);
    if (!drag) {
      if (e.pointerType !== 'mouse' || !editable) return;
      const free = e.target === track.current && gapAround(ms, blocks, { start: bounds.start, end: cap });
      setHover(free ? clamp(snap(ms), free.start, free.end) : null);
      return;
    }
    const step = e.shiftKey ? MINUTE : SNAP;
    const to = snap(ms, step);
    let next: Span;
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
        const start = clamp(snap(ms - drag.grab, step), drag.lo, Math.max(drag.lo, drag.hi - size));
        next = { start, end: start + size };
        break;
      }
    }
    if (next.start !== drag.start || next.end !== drag.end) setDrag({ ...drag, ...next, moved: true });
  };

  const onPointerUp = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.kind === 'create') {
      // A click without a drag offers the hour from there.
      const end = drag.moved ? drag.end : Math.min(drag.start + HOUR, drag.hi);
      if (end - drag.start >= SNAP) openNew({ start: drag.start, end });
      return;
    }
    const b = blocks.find((x) => x.entry.id === drag.id);
    if (!b) return;
    if (drag.moved) save(b, drag);
    else if (drag.kind === 'move' && !b.entry.locked) openEntry(b.entry);
  };

  // --- Keyboard: an edge is a slider ---

  useEffect(() => () => window.clearTimeout(keyTimer.current), []);

  const nudge = (e: KeyboardEvent, b: Block, kind: 'start' | 'end') => {
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, PageUp: -6, PageDown: 6 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const gap = gapAround((b.start + b.end) / 2, others(b.entry.id), { start: bounds.start, end: cap });
    if (!gap) return;
    const delta = dir * (e.shiftKey ? MINUTE : SNAP);
    const next =
      kind === 'start'
        ? { start: clamp(b.start + delta, gap.start, b.end - SNAP), end: b.end }
        : { start: b.start, end: clamp(b.end + delta, b.start + SNAP, gap.end) };
    const held: Drag = { kind, id: b.entry.id, ...next, lo: gap.start, hi: gap.end, grab: 0, moved: true };
    setDrag(held);
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
      className={cn('tl', drag && 'tl-dragging', drag && (drag.kind === 'move' ? 'cursor-grabbing' : 'tl-resizing'))}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      style={{ '--tl-hours': length / HOUR } as CSSProperties}
    >
      {/* The hours. */}
      <div className="tl-scale" aria-hidden>
        {hours.map((h, i) => (
          <span key={h} className="tl-at tl-hour" style={{ '--s': at(h) } as CSSProperties}>
            {i % labelEvery === 0 && <span className="tl-hour-label tabular">{hourLabel(h)}</span>}
          </span>
        ))}
      </div>

      <div className="tl-row">
        {win.start > bounds.start && (
          <button
            type="button"
            className="tl-more tl-more-start"
            aria-label={t('earlier')}
            data-tooltip-id={TOOLTIP_ID}
            data-tooltip-content={t('earlier')}
            onClick={() => setEarlier(earlier + 2)}
          >
            <ChevronLeftIcon aria-hidden className="size-3.5 max-sm:rotate-90" />
          </button>
        )}

        {/* Dragging here is the pointer's shortcut; the Add time button and each block's own controls are the keyboard's. */}
        <div ref={track} className={cn('tl-track', editable && 'tl-track-editable')} onPointerDown={beginCreate}>
          {hours.slice(1, -1).map((h) => (
            <span key={h} aria-hidden className="tl-at tl-grid" style={{ '--s': at(h) } as CSSProperties} />
          ))}

          {blocks.map((b) => {
            const name = projectName(b.entry.projectId);
            const label = t('block', {
              project: name,
              range: b.running ? t('rangeRunning', { start: clock(b.start) }) : range(b),
              length: span(b),
            });
            const live = editable && !b.entry.locked;
            const slider = (kind: 'start' | 'end') => (
              <span
                role="slider"
                tabIndex={0}
                className={cn('tl-handle', kind === 'start' ? 'tl-handle-start' : 'tl-handle-end')}
                aria-label={t(kind === 'start' ? 'startOf' : 'endOf', { project: name })}
                aria-orientation={wide ? 'horizontal' : 'vertical'}
                aria-valuemin={0}
                aria-valuemax={Math.round((bounds.end - bounds.start) / MINUTE)}
                aria-valuenow={Math.round(((kind === 'start' ? b.start : b.end) - bounds.start) / MINUTE)}
                aria-valuetext={clock(kind === 'start' ? b.start : b.end)}
                onPointerDown={(e) => beginEdge(e, b, kind)}
                onKeyDown={(e) => nudge(e, b, kind)}
              />
            );
            return (
              <div
                key={b.entry.id}
                data-entry={b.entry.id}
                className={cn(
                  'tl-pos tl-block',
                  !b.entry.projectId && 'tl-plain',
                  b.running && 'tl-running',
                  b.entry.locked && 'tl-locked',
                  b.clippedStart && 'tl-clipped-start',
                  b.clippedEnd && 'tl-clipped-end',
                  held?.id === b.entry.id && 'tl-held',
                )}
                style={{ ...place(b), '--hue': b.entry.projectId ? projectHue(b.entry.projectId) : 0 } as CSSProperties}
              >
                {live ? (
                  <button
                    type="button"
                    className="tl-body"
                    aria-label={t('editBlock', { block: label })}
                    data-tooltip-id={drag ? undefined : TOOLTIP_ID}
                    data-tooltip-content={label}
                    onPointerDown={(e) => beginMove(e, b)}
                    // The pointer opens it on release (see onPointerUp); this is the keyboard and touch.
                    onClick={(e) => {
                      if (e.detail === 0 || pointer.current === 'touch') openEntry(b.entry);
                    }}
                  >
                    <BlockText name={name} detail={span(b)} />
                  </button>
                ) : (
                  <div
                    className="tl-body"
                    role="img"
                    aria-label={b.entry.locked ? t('lockedBlock', { block: label }) : label}
                    data-tooltip-id={TOOLTIP_ID}
                    data-tooltip-content={label}
                  >
                    <BlockText name={name} detail={span(b)} locked={b.entry.locked} />
                  </div>
                )}
                {live && !b.clippedStart && slider('start')}
                {live && !b.running && !b.clippedEnd && slider('end')}
              </div>
            );
          })}

          {draft && (
            <div data-draft className="tl-pos tl-draft" style={place(draft)} aria-hidden>
              <span className="tl-body">
                <BlockText name={t('new')} detail={span(draft)} />
              </span>
            </div>
          )}

          {hover !== null && (
            <span aria-hidden className="tl-at tl-cursor" style={{ '--s': at(hover) } as CSSProperties} />
          )}

          {isToday && now >= win.start && now <= win.end && (
            <span aria-hidden className="tl-at tl-now" style={{ '--s': at(now) } as CSSProperties} />
          )}
        </div>

        {win.end < bounds.end && (
          <button
            type="button"
            className="tl-more tl-more-end"
            aria-label={t('later')}
            data-tooltip-id={TOOLTIP_ID}
            data-tooltip-content={t('later')}
            onClick={() => setLater(later + 2)}
          >
            <ChevronRightIcon aria-hidden className="size-3.5 max-sm:rotate-90" />
          </button>
        )}
      </div>

      {/* What is in hand, in words: it follows the pointer and is announced for the keyboard. */}
      <p className="tl-readout tabular" aria-live="polite">
        {readout ? (
          <span className="font-medium text-foreground">
            {t('readout', { range: range(readout), length: span(readout) })}
          </span>
        ) : hover !== null ? (
          t('addAt', { time: clock(hover) })
        ) : editable ? (
          wide ? (
            t('hint')
          ) : (
            t('hintTouch')
          )
        ) : null}
      </p>

      <EntryDialog
        open={!!editing}
        onClose={() => {
          const id = editing?.id;
          morph(
            () => setEditing(null),
            () => null,
            () => (id ? blockEl(id) : null),
          );
        }}
        entry={editing ?? undefined}
        day={day}
      />
      <EntryDialog
        open={addOpen}
        onClose={closeNew}
        day={day}
        personId={personId}
        start={adding ? timeInput(iso(adding.start), zone) : undefined}
        end={adding ? timeInput(iso(adding.end), zone) : undefined}
      />
    </div>
  );
}

/** A block's words, which show only when the block has room for them. */
function BlockText({ name, detail, locked }: { name: string; detail: string; locked?: boolean }) {
  return (
    <span className="tl-text">
      <span className="tl-name">
        {locked && <LockIcon aria-hidden className="mr-1 inline size-3 align-[-1px]" />}
        {name}
      </span>
      <span className="tl-detail tabular">{detail}</span>
    </span>
  );
}
