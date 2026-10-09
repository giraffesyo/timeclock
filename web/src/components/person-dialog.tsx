import { ConfirmModal } from '@parallelworks/ui';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { controlClass, Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { PersonSelect, personChoices } from '@/components/person-select';
import { SwitchRow } from '@/components/settings/switch';
import { ZoneSelect } from '@/components/zone-select';
import { type Person, type PersonUpdate, useUpdatePerson } from '@/lib/queries';
import { useSession } from '@/lib/session';

/** What an update leaves as it is. */
const current = (p: Person): PersonUpdate => ({
  timezone: p.timezone,
  managerId: p.managerOverrideId,
  overtimeExempt: p.overtimeExempt,
  payrollId: p.payrollId,
  active: p.active,
  submitsTimesheets: p.submitsTimesheetsOverride,
  holidayPay: p.holidayPayOverride,
});

/** One person's settings, saved together. */
export function PersonDialog({ person, people, onClose }: { person: Person; people: Person[]; onClose: () => void }) {
  const t = useTranslations('settings.people');
  const tc = useTranslations('common');
  const update = useUpdatePerson();
  const { settings } = useSession();
  const [draft, setDraft] = useState(() => current(person));
  const set = (patch: Partial<PersonUpdate>) => setDraft((d) => ({ ...d, ...patch }));

  // The current manager stays choosable even when inactive or unknown here.
  const managers = people.filter((p) => p.id !== person.id && (p.active || p.id === draft.managerId));
  const directoryManager = people.find((p) => p.id === person.directoryManagerId);
  const managerKnown = !draft.managerId || managers.some((p) => p.id === draft.managerId);

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={t('editTitle', { name: person.name })}
      confirmLabel={tc('save')}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await update.mutateAsync({ id: person.id, ...draft, payrollId: draft.payrollId.trim() });
          onClose();
        } catch {
          // Shown below from update.error; the dialog stays open to fix it.
        }
      }}
    >
      <div className="space-y-3">
        <Field label={t('columns.manager')} hint={t('managerHint')}>
          <PersonSelect
            label={t('columns.manager')}
            value={draft.managerId}
            onChange={(managerId) => set({ managerId })}
            choices={[
              {
                value: '',
                label: person.directoryManagerId
                  ? t('managerDirectory', {
                      name: directoryManager?.name || directoryManager?.email || person.directoryManagerId,
                    })
                  : t('adminApproves'),
              },
              ...(managerKnown ? [] : [{ value: draft.managerId, label: draft.managerId }]),
              ...personChoices(managers),
            ]}
          />
        </Field>
        <Field label={t('columns.timezone')}>
          <ZoneSelect
            value={draft.timezone}
            onChange={(timezone) => set({ timezone })}
            defaultLabel={t('timezoneDefault')}
          />
        </Field>
        <Field label={t('columns.timesheets')}>
          <select
            className={controlClass}
            value={draft.submitsTimesheets == null ? '' : String(draft.submitsTimesheets)}
            onChange={(e) => set({ submitsTimesheets: e.target.value === '' ? null : e.target.value === 'true' })}
          >
            <option value="">
              {t('timesheetsDefault', { value: settings.submitTimesheets ? t('submits') : t('reportsOnly') })}
            </option>
            <option value="true">{t('submits')}</option>
            <option value="false">{t('reportsOnly')}</option>
          </select>
        </Field>
        <Field label={t('columns.holidayPay')}>
          <select
            className={controlClass}
            value={draft.holidayPay == null ? '' : String(draft.holidayPay)}
            onChange={(e) => set({ holidayPay: e.target.value === '' ? null : e.target.value === 'true' })}
          >
            <option value="">
              {t('holidayPayDefault', { value: settings.holidayPay ? t('paid') : t('notPaid') })}
            </option>
            <option value="true">{t('paid')}</option>
            <option value="false">{t('notPaid')}</option>
          </select>
        </Field>
        <Field label={t('columns.payrollId')} hint={t('payrollIdHint')}>
          <input
            className={`${controlClass} font-mono`}
            value={draft.payrollId}
            maxLength={64}
            onChange={(e) => set({ payrollId: e.target.value })}
          />
        </Field>
        <SwitchRow
          label={t('columns.exempt')}
          hint={draft.overtimeExempt ? t('exemptOn') : t('exemptOff')}
          value={draft.overtimeExempt}
          onChange={(v) => set({ overtimeExempt: v })}
        />
      </div>
      {update.isError && (
        <ErrorNote className="mt-3" context={t('saveFailed', { name: person.name })} error={update.error} />
      )}
    </ConfirmModal>
  );
}
