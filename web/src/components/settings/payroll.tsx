import { ConfirmModal } from '@parallelworks/ui';
import { CheckIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote, Panel } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { Holidays } from '@/components/settings/holidays';
import { isDay, periodAfter, periodContaining, todayIn } from '@/components/settings/periods';
import { SwitchRow } from '@/components/settings/switch';
import { ZoneSelect } from '@/components/zone-select';
import { type Settings, useSaveSettings } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { dayToDate } from '@/lib/time';

const CYCLES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const satisfies readonly Settings['payCycle'][];

// 2023-01-01 was a Sunday, so day i of that week is weekday i.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((i) => dayToDate(`2023-01-0${i + 1}`));

/** The form's values: the settings, with numbers as typed so a field can be empty mid-edit. */
interface Draft extends Omit<Settings, '$schema' | 'overtimeWeeklyHours' | 'longEntryHours'> {
  overtime: string;
  longEntry: string;
}

function toDraft(s: Settings): Draft {
  return {
    timezone: s.timezone,
    payCycle: s.payCycle,
    cycleAnchor: s.cycleAnchor,
    weekStart: s.weekStart,
    submitTimesheets: s.submitTimesheets,
    holidayPay: s.holidayPay,
    approveTimesheets: s.approveTimesheets,
    approveTimeOff: s.approveTimeOff,
    requireProject: s.requireProject,
    requireDescription: s.requireDescription,
    overtime: String(s.overtimeWeeklyHours),
    longEntry: String(s.longEntryHours),
  };
}

/** How payroll runs. Nothing changes until Save. */
export function PayrollSettings() {
  const t = useTranslations('settings.payroll');
  const tc = useTranslations('common');
  const format = useFormatter();
  const periodLabel = usePeriodLabel();
  const { settings, today, period } = useSession();
  const save = useSaveSettings();
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [confirming, setConfirming] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    save.reset();
  };

  const anchored = draft.payCycle === 'weekly' || draft.payCycle === 'biweekly';
  const anchorValid = isDay(draft.cycleAnchor);
  const overtime = Number.parseFloat(draft.overtime);
  const longEntry = Number.parseFloat(draft.longEntry);
  const next: Settings = {
    timezone: draft.timezone,
    payCycle: draft.payCycle,
    // Only weekly and biweekly cycles read the anchor; the others keep what is saved.
    cycleAnchor: anchored ? draft.cycleAnchor : settings.cycleAnchor,
    weekStart: draft.weekStart,
    overtimeWeeklyHours: overtime,
    submitTimesheets: draft.submitTimesheets,
    holidayPay: draft.holidayPay,
    approveTimesheets: draft.approveTimesheets,
    approveTimeOff: draft.approveTimeOff,
    requireProject: draft.requireProject,
    requireDescription: draft.requireDescription,
    longEntryHours: longEntry,
  };
  const valid =
    (!anchored || anchorValid) &&
    Number.isFinite(overtime) &&
    overtime >= 0 &&
    overtime <= 168 &&
    Number.isFinite(longEntry) &&
    longEntry > 0 &&
    longEntry <= 24;
  const periodsChange = next.payCycle !== settings.payCycle || next.cycleAnchor !== settings.cycleAnchor;
  const dirty =
    periodsChange ||
    next.timezone !== settings.timezone ||
    next.weekStart !== settings.weekStart ||
    next.overtimeWeeklyHours !== settings.overtimeWeeklyHours ||
    next.submitTimesheets !== settings.submitTimesheets ||
    next.holidayPay !== settings.holidayPay ||
    next.approveTimesheets !== settings.approveTimesheets ||
    next.approveTimeOff !== settings.approveTimeOff ||
    next.requireProject !== settings.requireProject ||
    next.requireDescription !== settings.requireDescription ||
    next.longEntryHours !== settings.longEntryHours;

  // What the chosen cycle does, before it is saved.
  const previewDay = draft.timezone === settings.timezone ? today : todayIn(draft.timezone, today);
  const current = !anchored || anchorValid ? periodContaining(next.payCycle, next.cycleAnchor, previewDay) : null;
  const following = current ? periodAfter(next.payCycle, next.cycleAnchor, current) : null;

  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty || !valid) return;
          if (periodsChange) setConfirming(true);
          else save.mutate(next);
        }}
      >
        <Panel title={t('periods.title')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('cycle.label')} hint={t('cycle.hint')}>
              <select
                className={controlClass}
                value={draft.payCycle}
                onChange={(e) => set('payCycle', e.target.value as Settings['payCycle'])}
              >
                {CYCLES.map((c) => (
                  <option key={c} value={c}>
                    {t(`cycle.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
            {anchored && (
              <Field label={t('anchor.label')} hint={t('anchor.hint')}>
                <input
                  type="date"
                  required
                  className={controlClass}
                  value={draft.cycleAnchor}
                  onChange={(e) => set('cycleAnchor', e.target.value)}
                />
              </Field>
            )}
          </div>
          <dl className="mt-4 grid gap-x-8 gap-y-2 rounded-md bg-muted px-3 py-2.5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t('preview.current')}</dt>
              <dd className="tabular font-medium">{current ? periodLabel(current) : t('preview.needAnchor')}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('preview.next')}</dt>
              <dd className="tabular font-medium">{following ? periodLabel(following) : t('preview.needAnchor')}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            {periodsChange && `${t('preview.saved', { period: periodLabel(period) })} `}
            {t('preview.submittedKeep')}
          </p>
        </Panel>

        <Panel title={t('time.title')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('timezone.label')} hint={t('timezone.hint')} className="sm:col-span-2">
              <ZoneSelect className="sm:max-w-sm" value={draft.timezone} onChange={(zone) => set('timezone', zone)} />
            </Field>
            <Field label={t('weekStart.label')} hint={t('weekStart.hint')}>
              <select
                className={controlClass}
                value={draft.weekStart}
                onChange={(e) => set('weekStart', Number(e.target.value))}
              >
                {WEEKDAYS.map((date, i) => (
                  <option key={date.toISOString()} value={i}>
                    {format.dateTime(date, { weekday: 'long' })}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('overtime.label')} hint={t('overtime.hint')}>
              <input
                type="number"
                required
                min={0}
                max={168}
                step="any"
                inputMode="decimal"
                className={`${controlClass} tabular`}
                value={draft.overtime}
                onChange={(e) => set('overtime', e.target.value)}
              />
            </Field>
          </div>
        </Panel>

        <Panel title={t('approvals.title')}>
          <div className="space-y-4">
            <SwitchRow
              label={t('approvals.submit')}
              hint={draft.submitTimesheets ? t('approvals.submitOn') : t('approvals.submitOff')}
              value={draft.submitTimesheets}
              onChange={(v) => set('submitTimesheets', v)}
            />
            <SwitchRow
              label={t('approvals.timesheets')}
              hint={draft.approveTimesheets ? t('approvals.timesheetsOn') : t('approvals.timesheetsOff')}
              value={draft.approveTimesheets}
              onChange={(v) => set('approveTimesheets', v)}
            />
            <SwitchRow
              label={t('approvals.timeOff')}
              hint={draft.approveTimeOff ? t('approvals.timeOffOn') : t('approvals.timeOffOff')}
              value={draft.approveTimeOff}
              onChange={(v) => set('approveTimeOff', v)}
            />
          </div>
        </Panel>

        <Panel title={t('holidayPay.title')}>
          <SwitchRow
            label={t('holidayPay.label')}
            hint={draft.holidayPay ? t('holidayPay.on') : t('holidayPay.off')}
            value={draft.holidayPay}
            onChange={(v) => set('holidayPay', v)}
          />
        </Panel>

        <Panel title={t('entries.title')}>
          <div className="space-y-4">
            <SwitchRow
              label={t('entries.requireProject')}
              hint={draft.requireProject ? t('entries.requireProjectOn') : t('entries.requireProjectOff')}
              value={draft.requireProject}
              onChange={(v) => set('requireProject', v)}
            />
            <SwitchRow
              label={t('entries.requireDescription')}
              hint={draft.requireDescription ? t('entries.requireDescriptionOn') : t('entries.requireDescriptionOff')}
              value={draft.requireDescription}
              onChange={(v) => set('requireDescription', v)}
            />
            <Field label={t('entries.longEntry')} hint={t('entries.longEntryHint')} className="sm:max-w-xs">
              <input
                type="number"
                required
                min={0.25}
                max={24}
                step="any"
                inputMode="decimal"
                className={`${controlClass} tabular`}
                value={draft.longEntry}
                onChange={(e) => set('longEntry', e.target.value)}
              />
            </Field>
          </div>
        </Panel>

        {save.isError && !confirming && <ErrorNote context={t('saveFailed')} error={save.error} />}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !valid}>
            {tc('save')}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                setDraft(toDraft(settings));
                save.reset();
              }}
            >
              {t('discard')}
            </Button>
          )}
          <span className="text-sm text-muted-foreground" role="status">
            {dirty ? (
              valid ? (
                t('unsaved')
              ) : (
                t('invalid')
              )
            ) : save.isSuccess ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <CheckIcon className="size-3.5" aria-hidden />
                {t('saved')}
              </span>
            ) : (
              t('noChanges')
            )}
          </span>
        </div>
      </form>
      <div className="mt-4">
        <Holidays />
      </div>
      <ConfirmModal
        open={confirming}
        onClose={() => {
          setConfirming(false);
          save.reset();
        }}
        title={t('confirm.title')}
        description={
          current && following
            ? t('confirm.description', { current: periodLabel(current), next: periodLabel(following) })
            : null
        }
        confirmLabel={t('confirm.action')}
        closeOnConfirm={false}
        onConfirm={async () => {
          try {
            await save.mutateAsync(next);
            setConfirming(false);
          } catch {
            // Shown below from save.error; the dialog stays open.
          }
        }}
      >
        {save.isError ? <ErrorNote context={t('saveFailed')} error={save.error} /> : null}
      </ConfirmModal>
    </>
  );
}
