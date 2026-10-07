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

/**
 * Where overlapping spans sit side by side: each gets a lane, and the number
 * of lanes its group of overlapping spans needs. Spans must be sorted by start.
 */
export function lanes(spans: Span[]): { lane: number; of: number }[] {
  const out: { lane: number; of: number }[] = [];
  let group: number[] = [];
  let ends: number[] = []; // per lane, when it frees up
  let groupEnd = Number.NEGATIVE_INFINITY;
  const close = () => {
    for (const i of group) (out[i] as { of: number }).of = ends.length;
    group = [];
    ends = [];
  };
  spans.forEach((s, i) => {
    if (s.start >= groupEnd) close();
    let lane = ends.findIndex((end) => end <= s.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = s.end;
    groupEnd = Math.max(groupEnd, s.end);
    out[i] = { lane, of: 1 };
    group.push(i);
  });
  close();
  return out;
}

/** The time spans cover, counting overlapping time once, as worked hours do. */
export function covered(spans: Span[]): number {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.end <= end) continue;
    total += s.end - Math.max(s.start, end);
    end = s.end;
  }
  return total;
}

/**
 * Time worked up to now, and what lies ahead of it: planned time, which
 * counts once it passes. Overlaps count once, as in covered.
 */
export function workedAndPlanned(spans: Span[], now: number): { worked: number; planned: number } {
  return {
    worked: covered(spans.filter((s) => s.start < now).map((s) => ({ start: s.start, end: Math.min(s.end, now) }))),
    planned: covered(spans.filter((s) => s.end > now).map((s) => ({ start: Math.max(s.start, now), end: s.end }))),
  };
}

export { projectHue } from '@giraffesyo/timeclock';
