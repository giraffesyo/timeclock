import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Schemas, unwrap } from '@/api/client';
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
    queryFn: enabled ? async () => unwrap(await api.GET('/api/v1/people')).people ?? [] : skipToken,
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
    queryFn: enabled ? async () => unwrap(await api.GET('/api/v1/time-off/pending')).timeOff ?? [] : skipToken,
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
    queryFn: enabled ? async () => unwrap(await api.GET('/api/v1/team', { params: { query: { day } } })) : skipToken,
  });
}

export function useExceptions(day?: Day, enabled = true) {
  return useQuery({
    queryKey: ['exceptions', day ?? ''],
    queryFn: enabled
      ? async () => unwrap(await api.GET('/api/v1/exceptions', { params: { query: { day } } }))
      : skipToken,
  });
}

export function usePayroll(day?: Day, enabled = true) {
  return useQuery({
    queryKey: ['payroll', day ?? ''],
    queryFn: enabled
      ? async () => unwrap(await api.GET('/api/v1/reports/payroll', { params: { query: { day } } }))
      : skipToken,
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
    queryKey: ['activity'],
    queryFn: async () => unwrap(await api.GET('/api/v1/activity')).people ?? [],
    refetchInterval: 60_000,
  });
}

export function useAudit(person?: string, enabled = true) {
  return useQuery({
    queryKey: ['audit', person ?? ''],
    queryFn: enabled
      ? async () => unwrap(await api.GET('/api/v1/audit', { params: { query: { person } } })).entries ?? []
      : skipToken,
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
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useClockIn() {
  return useWrite(async (body: { projectId?: string; note?: string }) =>
    unwrap(await api.POST('/api/v1/clock/in', { body })),
  );
}

/** Moves the running clock to other work: the time so far stays where it was, and the clock goes on. */
export function useSwitchClock() {
  return useWrite(async (body: { projectId?: string; note?: string }) =>
    unwrap(await api.POST('/api/v1/clock/switch', { body })),
  );
}

export function useClockOut() {
  return useWrite(async () => unwrap(await api.POST('/api/v1/clock/out')));
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
    onSettled: () => client.invalidateQueries(),
  });
}

export function useDeleteEntry() {
  return useWrite(async (id: string) => unwrap(await api.DELETE('/api/v1/entries/{id}', { params: { path: { id } } })));
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

export function useSyncPeople() {
  return useWrite(async () => unwrap(await api.POST('/api/v1/people/sync')));
}
