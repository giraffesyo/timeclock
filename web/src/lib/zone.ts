import { usePeople } from '@/lib/queries';
import { useSession } from '@/lib/session';

/** The time zone the browser is in. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The IANA zones the browser knows, with `current` first if it isn't one of them. */
export function timeZones(current: string): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return !current || zones.includes(current) ? zones : [current, ...zones];
}

/**
 * The time zone a person's time is shown and cut in: their own, or the
 * organization's when they have none. Without an id it is the caller's.
 */
export function useZone(personId?: string): string {
  const me = useSession();
  const other = !!personId && personId !== me.person.id;
  const people = usePeople(other && (me.admin || me.manager));
  if (!other) return me.person.timezone || me.settings.timezone;
  return people.data?.find((p) => p.id === personId)?.timezone || me.settings.timezone;
}
