// The geometry of a day drawn as a ruler: instants are milliseconds, and a
// day's edges are its midnights in the organization's time zone.
import { DateTime } from 'luxon';
import type { Day } from '@/lib/time';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Dragging lands on five-minute marks. */
export const SNAP = 5 * MINUTE;

export type Span = { start: number; end: number };

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** The nearest multiple of step. Every zone's offset is a multiple of five minutes, so this lands on the zone's marks too. */
export function snap(ms: number, step = SNAP): number {
  return Math.round(ms / step) * step;
}

/** The midnights a day runs between, in the zone. */
export function dayBounds(day: Day, zone: string): Span {
  const start = DateTime.fromISO(day, { zone }).startOf('day');
  return { start: start.toMillis(), end: start.plus({ days: 1 }).toMillis() };
}

/**
 * The hours the ruler shows: the working day, widened to whole hours around
 * everything in it, and by `earlier` and `later` hours on request.
 */
export function rulerWindow(day: Span, spans: Span[], earlier: number, later: number): Span {
  let start = day.start + 6 * HOUR;
  let end = day.start + 20 * HOUR;
  for (const s of spans) {
    start = Math.min(start, day.start + Math.floor((s.start - day.start) / HOUR) * HOUR);
    end = Math.max(end, day.start + Math.ceil((s.end - day.start) / HOUR) * HOUR);
  }
  return { start: Math.max(day.start, start - earlier * HOUR), end: Math.min(day.end, end + later * HOUR) };
}

/** The free stretch around an instant: from the span that ends before it to the one that starts after. */
export function gapAround(at: number, spans: Span[], bounds: Span): Span | null {
  let lo = bounds.start;
  let hi = bounds.end;
  for (const s of spans) {
    if (at > s.start && at < s.end) return null;
    if (s.end <= at) lo = Math.max(lo, s.end);
    if (s.start >= at) hi = Math.min(hi, s.start);
  }
  return hi > lo ? { start: lo, end: hi } : null;
}

const HUES = [274, 205, 152, 88, 42, 338, 305, 232];

/** A project's hue, the same every time, so its blocks are recognizable at a glance. */
export function projectHue(projectId: string): number {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length] ?? 274;
}
