import type { Me, PeriodSummary } from '@/lib/queries';

/** How the caller stands to a timesheet, which decides what the page offers. */
export interface Standing {
  /** The sheet is the caller's own. */
  own: boolean;
  /** Where the sheet stands; "open" is never submitted. */
  status: 'open' | 'submitted' | 'approved' | 'rejected';
  /** Submitted or approved: its time can't change. */
  locked: boolean;
  /** The caller may approve it or send it back: the person's manager, or an admin. */
  decider: boolean;
  /** The caller may add and change its time when it isn't locked. */
  writer: boolean;
  /** The pay period hasn't begun, so it can't be submitted. */
  notStarted: boolean;
  /** The person submits timesheets; without, their time is for reports only. */
  submits: boolean;
}

export function standing(summary: PeriodSummary, me: Me): Standing {
  const own = summary.person.id === me.person.id;
  const status = summary.timesheet?.status ?? 'open';
  return {
    own,
    status,
    locked: status === 'submitted' || status === 'approved',
    decider: me.admin || (!own && summary.person.managerId === me.person.id),
    writer: summary.person.active || me.admin,
    notStarted: summary.period.start > me.today,
    submits: summary.person.submitsTimesheets,
  };
}

/** Every hour the period pays: worked time and approved time off. */
export function totalHours(h: { regular: number; overtime: number; vacation: number; sick: number }): number {
  return h.regular + h.overtime + h.vacation + h.sick;
}
