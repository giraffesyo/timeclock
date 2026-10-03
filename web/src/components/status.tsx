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

/** A small status chip. Color repeats what the words say; it never stands alone. */
export function Chip({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn(chip, tones[tone], className)}>{children}</span>;
}

/** Where a pay period's timesheet stands. No timesheet means not submitted. */
export function SheetStatus({ timesheet }: { timesheet?: Timesheet | null }) {
  const t = useTranslations('common.sheet');
  const status = timesheet?.status ?? 'open';
  const tone: Tone =
    status === 'approved' ? 'success' : status === 'submitted' ? 'info' : status === 'rejected' ? 'danger' : 'neutral';
  return <Chip tone={tone}>{t(status)}</Chip>;
}

export function TimeOffStatus({ status }: { status: 'pending' | 'approved' | 'rejected' }) {
  const t = useTranslations('common.timeOffStatus');
  const tone: Tone = status === 'approved' ? 'success' : status === 'pending' ? 'warning' : 'danger';
  return <Chip tone={tone}>{t(status)}</Chip>;
}
