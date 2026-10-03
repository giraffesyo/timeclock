// Days, workweeks and pay periods are cut in the organization's time zone
// (Settings.timezone), not the browser's, so every helper here takes it.
import { DateTime } from 'luxon';

/** A calendar day, YYYY-MM-DD, as the API writes it. */
export type Day = string;

/** The day an instant falls on in the zone. */
export function dayOf(iso: string, zone: string): Day {
  return DateTime.fromISO(iso, { zone }).toISODate() ?? '';
}

export function addDays(day: Day, n: number): Day {
  return DateTime.fromISO(day).plus({ days: n }).toISODate() ?? day;
}

/** The days from..to, both included. */
export function daysBetween(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A day as a Date at noon, for formatters: noon is the same day in every zone. */
export function dayToDate(day: Day): Date {
  return new Date(`${day}T12:00:00`);
}

/** An instant as a datetime-local input's value, in the zone. */
export function toInput(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** A datetime-local input's value, read in the zone, as an ISO instant. */
export function fromInput(value: string, zone: string): string | null {
  const dt = DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

/** A day and an HH:mm time in the zone, as an ISO instant. */
export function at(day: Day, time: string, zone: string): string | null {
  return fromInput(`${day}T${time}`, zone);
}

/** The HH:mm of an instant in the zone, for a time input. */
export function timeInput(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat('HH:mm');
}

/** Milliseconds between two instants; the second defaults to now. */
export function elapsed(startIso: string, endIso?: string | null): number {
  const end = endIso ? Date.parse(endIso) : Date.now();
  return Math.max(0, end - Date.parse(startIso));
}

/** A duration as whole hours and minutes. */
export function hoursMinutes(ms: number): { hours: number; minutes: number } {
  const total = Math.round(ms / 60000);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** A running duration as H:MM:SS, for the live clock. */
export function stopwatch(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Decimal hours as payroll reads them: two places. */
export function decimalHours(hours: number): string {
  return hours.toFixed(2);
}

/** Milliseconds as decimal hours. */
export function msToHours(ms: number): number {
  return Math.round((ms / 3600000) * 100) / 100;
}

/** The first day of the workweek a day falls in; weekStart is 0 for Sunday. */
export function weekStartOf(day: Day, weekStart: number): Day {
  const weekday = DateTime.fromISO(day).weekday % 7;
  return addDays(day, -((weekday - weekStart + 7) % 7));
}
