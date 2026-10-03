import { CheckIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote, Panel } from '@/components/page';
import { type TimeOff, useRequestTimeOff } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays, type Day, daysBetween } from '@/lib/time';
import { isWeekend, MAX_REQUEST_DAYS, useHoursText } from './runs';

type Kind = TimeOff['kind'];

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** What the form would record, or why it can't. */
type Plan =
  | { ok: true; days: Day[]; skipped: number; hours: number }
  | { ok: false; reason: 'invalidDates' | 'invalidOrder' | 'invalidHours' | 'tooLong' | 'noDays' };

function plan(from: string, to: string, hoursText: string, weekends: boolean): Plan {
  if (!isDay(from) || !isDay(to)) return { ok: false, reason: 'invalidDates' };
  if (to < from) return { ok: false, reason: 'invalidOrder' };
  // Checked before listing the days, so a mistyped year doesn't walk centuries.
  if (to >= addDays(from, MAX_REQUEST_DAYS)) return { ok: false, reason: 'tooLong' };
  const hours = Number(hoursText);
  if (!(hours > 0 && hours <= 24)) return { ok: false, reason: 'invalidHours' };
  const all = daysBetween(from, to);
  const days = weekends ? all : all.filter((d) => !isWeekend(d));
  if (days.length === 0) return { ok: false, reason: 'noDays' };
  return { ok: true, days, skipped: all.length - days.length, hours };
}

/** Records vacation or sick hours on a run of days, showing the total before it's sent. */
export function RequestForm() {
  const t = useTranslations('timeOff.request');
  const tc = useTranslations('common');
  const hoursText = useHoursText();
  const { today, settings } = useSession();
  const request = useRequestTimeOff();
  const [kind, setKind] = useState<Kind>('vacation');
  const [from, setFrom] = useState<Day>(today);
  const [to, setTo] = useState<Day>(today);
  const [hours, setHours] = useState('8');
  const [weekends, setWeekends] = useState(false);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<{ count: number; hours: number; pending: boolean } | null>(null);

  const planned = plan(from, to, hours, weekends);

  return (
    <Panel title={t('title')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!planned.ok) return;
          setDone(null);
          request.mutate(
            { kind, from, to, hours: planned.hours, weekends, note: note.trim() || undefined },
            {
              onSuccess: (result) => {
                const recorded = result.timeOff ?? [];
                setDone({
                  count: recorded.length,
                  hours: recorded.reduce((sum, r) => sum + r.hours, 0),
                  pending: recorded.some((r) => r.status === 'pending'),
                });
                setNote('');
              },
            },
          );
        }}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t('kind')}>
            <select className={`${controlClass} w-full`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="vacation">{tc('kind.vacation')}</option>
              <option value="sick">{tc('kind.sick')}</option>
            </select>
          </Field>
          <Field label={t('from')}>
            <input
              type="date"
              required
              className={`${controlClass} w-full`}
              value={from}
              onChange={(e) => {
                const next = e.target.value;
                // The last day follows the first until it's set apart, and never falls before it.
                if (to === from || to < next) setTo(next);
                setFrom(next);
              }}
            />
          </Field>
          <Field label={t('to')}>
            <input
              type="date"
              required
              min={from}
              className={`${controlClass} w-full`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label={t('hours')}>
            <input
              type="number"
              required
              min={0.25}
              max={24}
              step={0.25}
              inputMode="decimal"
              className={`${controlClass} tabular w-full`}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </Field>
        </div>
        <Field label={tc('note')}>
          <input
            className={`${controlClass} w-full`}
            value={note}
            maxLength={2000}
            placeholder={t('notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <label className="flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={weekends}
            onChange={(e) => setWeekends(e.target.checked)}
          />
          {t('weekends')}
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="text-sm" aria-live="polite">
            {planned.ok ? (
              <>
                <span className="tabular font-medium">
                  {t('preview', {
                    count: planned.days.length,
                    hours: hoursText(planned.hours),
                    total: hoursText(planned.days.length * planned.hours),
                    kind: tc(`kind.${kind}`),
                  })}
                </span>
                {planned.skipped > 0 && (
                  <span className="text-muted-foreground"> · {t('previewSkipped', { count: planned.skipped })}</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">
                {planned.reason === 'tooLong' ? t('tooLong', { max: MAX_REQUEST_DAYS }) : t(planned.reason)}
              </span>
            )}
          </p>
          <Button type="submit" variant="primary" disabled={!planned.ok} loading={request.isPending}>
            {settings.approveTimeOff ? t('submitForApproval') : t('submit')}
          </Button>
        </div>
        {request.isError && <ErrorNote context={t('failed')} error={request.error} />}
        {done && !request.isPending && !request.isError && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md bg-success-subtle px-3 py-2 text-sm text-success"
          >
            <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {done.pending
              ? t('donePending', { count: done.count, total: hoursText(done.hours) })
              : t('doneRecorded', { count: done.count, total: hoursText(done.hours) })}
          </p>
        )}
      </form>
    </Panel>
  );
}
