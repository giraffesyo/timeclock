import { ConfirmModal } from '@parallelworks/ui';
import { LoaderIcon, RefreshIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass } from '@/components/field';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { PersonIdentity } from '@/components/person-identity';
import { Invites } from '@/components/settings/invites';
import { Switch } from '@/components/settings/switch';
import { type Person, type PersonUpdate, usePeople, useSyncPeople, useUpdatePerson } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { timeZones } from '@/lib/zone';

const th = 'px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4';
const td = 'px-3 py-2 align-middle first:pl-4 last:pr-4';

/** One person. Each change is its own request, so the row carries its own pending and error states. */
function PersonRow({ person, people }: { person: Person; people: Person[] }) {
  const t = useTranslations('settings.people');
  const update = useUpdatePerson();
  const { settings } = useSession();
  const [editing, setEditing] = useState(false);
  // The payroll id as typed, until it is saved; null shows the saved one.
  const [payrollDraft, setPayrollDraft] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // While a change is on its way the row shows what was asked for.
  const shown: PersonUpdate = update.isPending
    ? update.variables
    : {
        timezone: person.timezone,
        managerId: person.managerOverrideId,
        overtimeExempt: person.overtimeExempt,
        payrollId: person.payrollId,
        active: person.active,
      };
  const busy = update.isPending;

  const change = (patch: Partial<PersonUpdate>) => {
    if (busy) return Promise.resolve();
    return update.mutateAsync({
      id: person.id,
      timezone: person.timezone,
      managerId: person.managerOverrideId,
      overtimeExempt: person.overtimeExempt,
      payrollId: person.payrollId,
      active: person.active,
      ...patch,
    });
  };
  // A failure stays on the row, from update.error.
  const save = (patch: Partial<PersonUpdate>) => {
    change(patch).catch(() => {});
  };
  const savePayrollId = () => {
    if (payrollDraft === null) return;
    const value = payrollDraft.trim();
    if (value === person.payrollId) {
      setPayrollDraft(null);
      return;
    }
    change({ payrollId: value })
      .then(() => setPayrollDraft(null))
      .catch(() => {});
  };

  // The current manager stays choosable even when inactive or unknown here.
  const managers = people.filter((p) => p.id !== person.id && (p.active || p.id === shown.managerId));
  const effectiveManagerId = shown.managerId || person.directoryManagerId;
  const manager = people.find((p) => p.id === effectiveManagerId);
  const directoryManager = people.find((p) => p.id === person.directoryManagerId);
  const managerKnown = !shown.managerId || managers.some((p) => p.id === shown.managerId);

  return (
    <>
      <tr className={person.active ? undefined : 'text-muted-foreground'} aria-busy={busy}>
        <td className={`${td} whitespace-nowrap`}>
          <PersonIdentity person={person} people={people} />
        </td>
        <td className={`${td} whitespace-nowrap text-muted-foreground`}>{person.email}</td>
        <td className={td}>
          {editing ? (
            <select
              className={`${controlClass} w-48`}
              aria-label={t('managerFor', { name: person.name })}
              value={shown.managerId}
              disabled={busy}
              onChange={(e) => save({ managerId: e.target.value })}
            >
              <option value="">
                {person.directoryManagerId
                  ? t('managerDirectory', {
                      name: directoryManager?.name || directoryManager?.email || person.directoryManagerId,
                    })
                  : t('adminApproves')}
              </option>
              {!managerKnown && <option value={shown.managerId}>{shown.managerId}</option>}
              {managers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          ) : manager ? (
            <PersonIdentity person={manager} people={people} />
          ) : (
            <span>{effectiveManagerId || t('adminApproves')}</span>
          )}
        </td>
        <td className={td}>
          {editing ? (
            <select
              className={`${controlClass} w-48`}
              aria-label={t('timezoneFor', { name: person.name })}
              value={shown.timezone}
              disabled={busy}
              onChange={(e) => save({ timezone: e.target.value })}
            >
              <option value="">{t('timezoneDefault')}</option>
              {timeZones(shown.timezone).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          ) : (
            <span className="whitespace-nowrap">{shown.timezone || settings.timezone}</span>
          )}
        </td>
        <td className={td}>
          {editing ? (
            <Switch
              label={t('exemptFor', { name: person.name })}
              value={shown.overtimeExempt}
              onChange={(v) => save({ overtimeExempt: v })}
            />
          ) : (
            <span>{shown.overtimeExempt ? t('yes') : t('no')}</span>
          )}
        </td>
        <td className={td}>
          {editing ? (
            <input
              className={`${controlClass} w-36 font-mono`}
              aria-label={t('payrollIdFor', { name: person.name })}
              value={payrollDraft ?? shown.payrollId}
              maxLength={64}
              readOnly={busy}
              onChange={(e) => setPayrollDraft(e.target.value)}
              onBlur={savePayrollId}
              onKeyDown={(e) => {
                if (e.key === 'Enter') savePayrollId();
                if (e.key === 'Escape') {
                  setPayrollDraft(null);
                  update.reset();
                }
              }}
            />
          ) : (
            <span>{shown.payrollId || t('notSet')}</span>
          )}
        </td>
        <td className={td}>
          {editing ? (
            <Switch
              label={t('activeFor', { name: person.name })}
              value={shown.active}
              onChange={(v) => {
                if (busy) return;
                if (v) save({ active: true });
                else setDeactivating(true);
              }}
            />
          ) : (
            <span>{shown.active ? t('active') : t('inactive')}</span>
          )}
        </td>
        <td className={`${td} w-8`}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t(editing ? 'doneFor' : 'editFor', { name: person.name })}
            onClick={() => setEditing(!editing)}
          >
            {t(editing ? 'done' : 'edit')}
          </Button>
          {busy && (
            <span role="status" aria-label={t('saving')}>
              <LoaderIcon className="size-3.5 text-muted-foreground" aria-hidden />
            </span>
          )}
          {deactivating && (
            <ConfirmModal
              open
              onClose={() => {
                setDeactivating(false);
                update.reset();
              }}
              title={t('deactivate.title', { name: person.name })}
              description={t('deactivate.description')}
              confirmLabel={t('deactivate.action')}
              destructive
              closeOnConfirm={false}
              onConfirm={async () => {
                try {
                  await change({ active: false });
                  setDeactivating(false);
                } catch {
                  // Shown below from update.error.
                }
              }}
            >
              {update.isError ? (
                <ErrorNote context={t('saveFailed', { name: person.name })} error={update.error} />
              ) : null}
            </ConfirmModal>
          )}
        </td>
      </tr>
      {update.isError && !deactivating && (
        <tr>
          <td colSpan={8} className="px-4 pb-2">
            <ErrorNote context={t('saveFailed', { name: person.name })} error={update.error} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Everyone who tracks time: who approves it, and how payroll treats them. */
export function People() {
  const t = useTranslations('settings.people');
  const people = usePeople();
  const sync = useSyncPeople();

  return (
    <>
      <Invites />
      <Panel
        flush
        title={t('title')}
        actions={
          <Button size="sm" loading={sync.isPending} icon={<RefreshIcon aria-hidden />} onClick={() => sync.mutate()}>
            {t('sync')}
          </Button>
        }
      >
        {sync.isError && <ErrorNote className="m-3" context={t('syncFailed')} error={sync.error} />}
        {sync.isSuccess && (
          <p role="status" className="border-b border-border px-4 py-2 text-sm text-muted-foreground">
            {t('synced', { count: sync.data.people?.length ?? 0 })}
          </p>
        )}
        {people.isError ? (
          <ErrorNote className="m-4" context={t('loadFailed')} error={people.error} />
        ) : people.isPending ? (
          <Loading />
        ) : people.data.length === 0 ? (
          <Empty>{t('empty')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={th}>
                    {t('columns.name')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.email')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.manager')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.timezone')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.exempt')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.payrollId')}
                  </th>
                  <th scope="col" className={th}>
                    {t('columns.active')}
                  </th>
                  <th scope="col" className={th}>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {people.data.map((p) => (
                  <PersonRow key={p.id} person={p} people={people.data} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <li>{t('notes.manager')}</li>
        <li>{t('notes.exempt')}</li>
        <li>{t('notes.payrollId')}</li>
        <li>{t('notes.active')}</li>
      </ul>
    </>
  );
}
