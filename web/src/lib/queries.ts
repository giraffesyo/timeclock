import { clockFor } from '@giraffesyo/timeclock';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Schemas, unwrap } from '@/api/client';
import { basePath } from '@/lib/base';
import type { Day } from '@/lib/time';

export type Me = Schemas['MeBody'];
export type Settings = Schemas['Settings'];
export type Person = Schemas['Person'];
export type Customer = Schemas['Customer'];
export type Project = Schemas['Project'];
export type Entry = Schemas['Entry'];
export type EntryInput = Schemas['EntryInput'];
export type TimeOff = Schemas['TimeOff'];
export type TimeOffInput = Schemas['TimeOffInput'];
export type Timesheet = Schemas['Timesheet'];
export type PeriodSummary = Schemas['PeriodSummary'];
export type Period = Schemas['Period'];
export type Exception = Schemas['Exception'];
export type PayrollRow = Schemas['PayrollRow'];
export type ProjectHours = Schemas['ProjectHours'];
export type ProjectInput = Schemas['ProjectInput'];
export type PersonUpdate = Schemas['PersonUpdate'];
export type AuditEntry = Schemas['AuditEntry'];
export type Activity = Schemas['Activity'];
export type DayProjectHours = Schemas['DayProjectHours'];
export type Holiday = Schemas['Holiday'];
export type HolidayInput = Schemas['HolidayInput'];
export type CalendarEvent = Schemas['CalendarEvent'];

// --- Reads ---

/** Who is calling, how payroll runs, and their running clock. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => unwrap(await api.GET('/api/v1/me')),
    // The running clock can be stopped from another tab or device.
    refetchInterval: 60_000,
  });
}

export function usePeople(enabled = true) {
  return useQuery({
    queryKey: ['people'],
    queryFn: async () => unwrap(await api.GET('/api/v1/people')).people ?? [],
    // `enabled`, not skipToken, here and below: observers share a key, and a
    // refetch (invalidateQueries after any write) runs the queryFn of
    // whichever observer set it last, so a disabled one turned the query
    // into an error.
    enabled,
  });
}

export function useCustomers(archived = false) {
  return useQuery({
    queryKey: ['customers', archived],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/customers', { params: { query: { archived } } })).customers ?? [],
  });
}

export function useProjects(archived = false) {
  return useQuery({
    queryKey: ['projects', archived],
    queryFn: async () => unwrap(await api.GET('/api/v1/projects', { params: { query: { archived } } })).projects ?? [],
  });
}

export function useEntries(from: Day, to: Day, person?: string) {
  return useQuery({
    queryKey: ['entries', person ?? '', from, to],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/entries', { params: { query: { from, to, person } } })).entries ?? [],
  });
}

/** The caller's Google Calendar events on a range of days, when the host reads their calendar. */
export function useCalendarEvents(from: Day, to: Day, enabled: boolean) {
  return useQuery({
    queryKey: ['calendar', from, to],
    queryFn: async () => unwrap(await api.GET('/api/v1/calendar/events', { params: { query: { from, to } } })),
    enabled,
    // Meetings move rarely; a week read a few minutes ago is current enough.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Whether the caller's own Google Calendar is connected, or the host reads it for them. */
export function useGoogleCalendar(enabled = true) {
  return useQuery({
    queryKey: ['google-calendar'],
    queryFn: async () => unwrap(await api.GET('/api/v1/calendar/google')),
    enabled,
  });
}

export function useTimeOff(from: Day, to: Day, person?: string) {
  return useQuery({
    queryKey: ['time-off', person ?? '', from, to],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/time-off', { params: { query: { from, to, person } } })).timeOff ?? [],
  });
}

/** Time off waiting for the caller's decision. */
export function usePendingTimeOff(enabled = true) {
  return useQuery({
    queryKey: ['time-off', 'pending'],
    queryFn: async () => unwrap(await api.GET('/api/v1/time-off/pending')).timeOff ?? [],
    enabled,
  });
}

/** A person's pay period containing day (today when absent). */
export function useTimesheet(day?: Day, person?: string) {
  return useQuery({
    queryKey: ['timesheet', person ?? '', day ?? ''],
    queryFn: async () => unwrap(await api.GET('/api/v1/timesheet', { params: { query: { day, person } } })),
  });
}

export function useTeam(day?: Day, enabled = true) {
  return useQuery({
    queryKey: ['team', day ?? ''],
    queryFn: async () => unwrap(await api.GET('/api/v1/team', { params: { query: { day } } })),
    enabled,
  });
}

export function useExceptions(day?: Day, enabled = true) {
  return useQuery({
    queryKey: ['exceptions', day ?? ''],
    queryFn: async () => unwrap(await api.GET('/api/v1/exceptions', { params: { query: { day } } })),
    enabled,
  });
}

export function usePayroll(day?: Day, enabled = true) {
  return useQuery({
    queryKey: ['payroll', day ?? ''],
    queryFn: async () => unwrap(await api.GET('/api/v1/reports/payroll', { params: { query: { day } } })),
    enabled,
  });
}

export function useProjectReport(from: Day, to: Day) {
  return useQuery({
    queryKey: ['project-report', from, to],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/reports/projects', { params: { query: { from, to } } })).rows ?? [],
  });
}

/** Hours by day and project on a range of days: the caller's own, or everyone's they may see. */
export function useHoursByDay(from: Day, to: Day, mine: boolean) {
  return useQuery({
    queryKey: ['hours-by-day', from, to, mine],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/reports/days', { params: { query: { from, to, mine } } })).rows ?? [],
  });
}

/** What people are on now, and their hours today and this week. */
export function useActivity() {
  return useQuery({
    queryKey: ['clocked-in'],
    queryFn: async () => unwrap(await api.GET('/api/v1/clocked-in')).people ?? [],
    refetchInterval: 60_000,
  });
}

/** The company's holidays, by their first day. */
export function useHolidays() {
  return useQuery({
    queryKey: ['holidays'],
    queryFn: async () => unwrap(await api.GET('/api/v1/holidays')).holidays ?? [],
  });
}

export function useAudit(person?: string, enabled = true) {
  return useQuery({
    queryKey: ['audit', person ?? ''],
    queryFn: async () => unwrap(await api.GET('/api/v1/audit', { params: { query: { person } } })).entries ?? [],
    enabled,
  });
}

// --- Writes ---
//
// Hours, timesheets, exceptions and reports all derive from the same time,
// so every write refetches whatever is on screen.

function useWrite<TIn, TOut>(fn: (input: TIn) => Promise<TOut>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      // The clock in the bar keeps its own state; a write here may have changed what is running.
      void clockFor(basePath).refresh();
      return client.invalidateQueries();
    },
  });
}

/** Creates an entry, or with an id changes one. */
export function useSaveEntry() {
  return useWrite(async ({ id, ...body }: EntryInput & { id?: string }) =>
    id
      ? unwrap(await api.PUT('/api/v1/entries/{id}', { params: { path: { id } }, body }))
      : unwrap(await api.POST('/api/v1/entries', { body })),
  );
}

/**
 * Changes when an entry starts or ends, as the ruler does on a drag. The
 * change shows at once and is taken back if the API refuses it.
 */
export function useAdjustEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ entry, startedAt, endedAt }: { entry: Entry; startedAt: string; endedAt?: string }) =>
      unwrap(
        await api.PUT('/api/v1/entries/{id}', {
          params: { path: { id: entry.id } },
          body: { projectId: entry.projectId, startedAt, endedAt, note: entry.note },
        }),
      ),
    onMutate: ({ entry, startedAt, endedAt }) => {
      const previous = client.getQueriesData<Entry[]>({ queryKey: ['entries'] });
      client.setQueriesData<Entry[]>({ queryKey: ['entries'] }, (list) =>
        list?.map((e) => (e.id === entry.id ? { ...e, startedAt, endedAt } : e)),
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      for (const [key, data] of context?.previous ?? []) client.setQueryData(key, data);
    },
    onSettled: () => {
      void clockFor(basePath).refresh();
      return client.invalidateQueries();
    },
  });
}

export function useDeleteEntry() {
  return useWrite(async (id: string) => unwrap(await api.DELETE('/api/v1/entries/{id}', { params: { path: { id } } })));
}

/** Remembers the project the caller copies a calendar meeting to; none is no project. */
export function useRememberMeeting() {
  return useWrite(async (body: { meeting: string; projectId?: string }) =>
    unwrap(await api.PUT('/api/v1/calendar/meetings', { body })),
  );
}

/** Disconnects the caller's own Google Calendar, and revokes Timeclock's access to it. */
export function useDisconnectGoogleCalendar() {
  return useWrite(async () => unwrap(await api.DELETE('/api/v1/calendar/google')));
}

export function useRequestTimeOff() {
  return useWrite(async (body: TimeOffInput) => unwrap(await api.POST('/api/v1/time-off', { body })));
}

export function useCancelTimeOff() {
  return useWrite(async (id: string) =>
    unwrap(await api.DELETE('/api/v1/time-off/{id}', { params: { path: { id } } })),
  );
}

export function useDecideTimeOff() {
  return useWrite(async ({ id, ...body }: { id: string; approve: boolean; note?: string }) =>
    unwrap(await api.POST('/api/v1/time-off/{id}/decision', { params: { path: { id } }, body })),
  );
}

export function useSubmitTimesheet() {
  return useWrite(async (body: { day: Day; personId?: string }) =>
    unwrap(await api.POST('/api/v1/timesheet/submit', { body })),
  );
}

export function useDecideTimesheet() {
  return useWrite(async ({ id, ...body }: { id: string; approve: boolean; note?: string }) =>
    unwrap(await api.POST('/api/v1/timesheets/{id}/decision', { params: { path: { id } }, body })),
  );
}

export function useReopenTimesheet() {
  return useWrite(async ({ id, note }: { id: string; note?: string }) =>
    unwrap(await api.POST('/api/v1/timesheets/{id}/reopen', { params: { path: { id } }, body: { note } })),
  );
}

export function useSaveSettings() {
  return useWrite(async (body: Settings) => unwrap(await api.PUT('/api/v1/settings', { body })));
}

export function useSaveCustomer() {
  return useWrite(async ({ id, ...body }: { id?: string; name: string; archived?: boolean }) =>
    id
      ? unwrap(await api.PUT('/api/v1/customers/{id}', { params: { path: { id } }, body }))
      : unwrap(await api.POST('/api/v1/customers', { body })),
  );
}

export function useDeleteCustomer() {
  return useWrite(async (id: string) =>
    unwrap(await api.DELETE('/api/v1/customers/{id}', { params: { path: { id } } })),
  );
}

export function useSaveProject() {
  return useWrite(async ({ id, ...body }: ProjectInput & { id?: string }) =>
    id
      ? unwrap(await api.PUT('/api/v1/projects/{id}', { params: { path: { id } }, body }))
      : unwrap(await api.POST('/api/v1/projects', { body })),
  );
}

/** Adds a holiday, or with an id changes one. */
export function useSaveHoliday() {
  return useWrite(async ({ id, ...body }: HolidayInput & { id?: string }) =>
    id
      ? unwrap(await api.PUT('/api/v1/holidays/{id}', { params: { path: { id } }, body }))
      : unwrap(await api.POST('/api/v1/holidays', { body })),
  );
}

export function useDeleteHoliday() {
  return useWrite(async (id: string) =>
    unwrap(await api.DELETE('/api/v1/holidays/{id}', { params: { path: { id } } })),
  );
}

export function useDeleteProject() {
  return useWrite(async (id: string) =>
    unwrap(await api.DELETE('/api/v1/projects/{id}', { params: { path: { id } } })),
  );
}

export function useUpdatePerson() {
  return useWrite(async ({ id, ...body }: PersonUpdate & { id: string }) =>
    unwrap(await api.PUT('/api/v1/people/{id}', { params: { path: { id } }, body })),
  );
}

/**
 * Changes several people at once, one request each. Every change is tried;
 * the error, if any, counts those that failed, and the list is read again
 * once at the end either way.
 */
export function useUpdatePeople() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (updates: (PersonUpdate & { id: string })[]) => {
      const results = await Promise.allSettled(
        updates.map(({ id, ...body }) =>
          api.PUT('/api/v1/people/{id}', { params: { path: { id } }, body }).then(unwrap),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0)
        throw new PartialFailure(failed.length, updates.length, (failed[0] as PromiseRejectedResult).reason);
    },
    onSettled: () => client.invalidateQueries(),
  });
}

/** Grants admin to several people, or takes it back, one request each. */
export function useSetAdmins() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, admin }: { ids: string[]; admin: boolean }) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          api.PUT('/api/v1/people/{id}/admin', { params: { path: { id } }, body: { admin } }).then(unwrap),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0)
        throw new PartialFailure(failed.length, ids.length, (failed[0] as PromiseRejectedResult).reason);
    },
    onSettled: () => client.invalidateQueries(),
  });
}

/** Some of a batch of changes failed: how many, and the first reason. */
export class PartialFailure extends Error {
  constructor(
    readonly failed: number,
    readonly total: number,
    override readonly cause: unknown,
  ) {
    super(`${failed} of ${total} changes failed`);
  }
}

/** Sets the time zone the caller's own days are cut in; empty is the organization's. */
export function useSetOwnTimezone() {
  return useWrite(async (timezone: string) => unwrap(await api.PUT('/api/v1/me/timezone', { body: { timezone } })));
}

/** Sets the workspace's look; an empty theme goes back to the host's or Timeclock's own. */
export function useSaveTheme() {
  return useWrite(async (body: Schemas['Theme']) => unwrap(await api.PUT('/api/v1/theme', { body })));
}

export function useSyncPeople() {
  return useWrite(async () => unwrap(await api.POST('/api/v1/people/sync')));
}
