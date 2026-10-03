import { cn } from '@/lib/cn';
import { decimalHours } from '@/lib/time';

/** Decimal hours in a column: zero is quiet, so the eye lands on real time. */
export function Hours({ value, className, strong }: { value: number; className?: string; strong?: boolean }) {
  return (
    <span className={cn('tabular', value === 0 ? 'text-muted-foreground/60' : strong && 'font-semibold', className)}>
      {decimalHours(value)}
    </span>
  );
}
