import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import type { Period } from '@/lib/queries';
import type { Day } from '@/lib/time';

/** A report's table: dense, and scrolling sideways inside its panel on a narrow screen. */
export function ReportTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full border-collapse text-sm ${className ?? ''}`}>{children}</table>
    </div>
  );
}

export const th = 'px-4 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground';
export const thNum = `${th} text-right`;
export const td = 'px-4 py-2 align-top';
export const tdNum = `${td} text-right whitespace-nowrap`;
export const rowLine = 'border-t border-border';

export const textLink = 'font-medium underline decoration-border underline-offset-2 hover:decoration-foreground';

/** A link to a person's timesheet for the pay period containing a day. */
export function TimesheetLink({
  person,
  day,
  children,
  className = textLink,
  label,
}: {
  person: string;
  day: Day;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <Link to="/timesheet" search={{ person, day }} className={className} aria-label={label}>
      {children}
    </Link>
  );
}

/**
 * The period to show while the next one loads: the last one known, so the
 * period navigation stays in place as the reader steps through periods.
 */
export function useStickyPeriod(period: Period | undefined): Period | undefined {
  const [shown, setShown] = useState(period);
  if (period && (period.start !== shown?.start || period.end !== shown?.end)) {
    setShown(period);
    return period;
  }
  return shown;
}
