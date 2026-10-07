import { TOOLTIP_ID } from '@parallelworks/ui';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/cn';
import type { Timesheet } from '@/lib/queries';

const chip = 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

const tones = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info-subtle text-info',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
} as const;

export type Tone = keyof typeof tones;

/**
 * A small status chip. Color repeats what the words say; it never stands alone.
 * A hint says what the chip means: shown on hover or focus, and read with it.
 */
export function Chip({
  tone,
  children,
  className,
  hint,
  inLink,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  hint?: string;
  /** Inside a link, which takes the focus: a button can't nest there. */
  inLink?: boolean;
}) {
  const hintId = useId();
  if (!hint) return <span className={cn(chip, tones[tone], className)}>{children}</span>;
  const tip = { 'data-tooltip-id': TOOLTIP_ID, 'data-tooltip-content': hint };
  if (inLink) {
    // Read as part of the link's content, since a description on a span isn't.
    return (
      <span {...tip} className={cn(chip, tones[tone], className)}>
        {children}
        <span className="sr-only">. {hint}</span>
      </span>
    );
  }
  // A toggletip: hovering or focusing it shows what the chip means. The words it
  // describes itself with sit beside it, so they don't join its name.
  return (
    <>
      <button
        type="button"
        aria-describedby={hintId}
        {...tip}
        className={cn(
          chip,
          tones[tone],
          'cursor-help outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary',
          className,
        )}
      >
        {children}
      </button>
      <span id={hintId} hidden>
        {hint}
      </span>
    </>
  );
}

/**
 * Where a pay period's timesheet stands. No timesheet means not submitted,
 * or, for someone who doesn't submit timesheets, time for reports only.
 */
export function SheetStatus({
  timesheet,
  reportsOnly,
  inLink,
}: {
  timesheet?: Timesheet | null;
  reportsOnly?: boolean;
  inLink?: boolean;
}) {
  const t = useTranslations('common.sheet');
  const hint = useTranslations('common.sheetHint');
  if (!timesheet && reportsOnly)
    return (
      <Chip tone="neutral" hint={hint('reportsOnly')} inLink={inLink}>
        {t('reportsOnly')}
      </Chip>
    );
  const status = timesheet?.status ?? 'open';
  const tone: Tone =
    status === 'approved' ? 'success' : status === 'submitted' ? 'info' : status === 'rejected' ? 'danger' : 'neutral';
  return (
    <Chip tone={tone} hint={hint(status)} inLink={inLink}>
      {t(status)}
    </Chip>
  );
}

export function TimeOffStatus({ status }: { status: 'pending' | 'approved' | 'rejected' }) {
  const t = useTranslations('common.timeOffStatus');
  const hint = useTranslations('common.timeOffStatusHint');
  const tone: Tone = status === 'approved' ? 'success' : status === 'pending' ? 'warning' : 'danger';
  return (
    <Chip tone={tone} hint={hint(status)}>
      {t(status)}
    </Chip>
  );
}
