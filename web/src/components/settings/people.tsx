import { useErrorMessage } from '@parallelworks/problem/react';
import { ConfirmModal } from '@parallelworks/ui';
import { LoaderIcon, MenuIcon, RefreshIcon } from '@parallelworks/ui/icons';
import { type RowMenuItem, useRowMenu } from '@parallelworks/ui/list';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass } from '@/components/field';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { PersonIdentity } from '@/components/person-identity';
import { Invites } from '@/components/settings/invites';
import { Switch } from '@/components/settings/switch';
import { Chip } from '@/components/status';
import { cn } from '@/lib/cn';
import {
  PartialFailure,
  type Person,
  type PersonUpdate,
  usePeople,
  useSetAdmins,
  useSyncPeople,
  useUpdatePeople,
  useUpdatePerson,
} from '@/lib/queries';
import { useSession } from '@/lib/session';
import { timeZones } from '@/lib/zone';

const th = 'px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4';
const td = 'px-3 py-2 align-middle first:pl-4 last:pr-4';

/** Something to do to a group of people, shown in the menu and the selection bar. */
interface Action {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled. */
  tooltip?: string | undefined;
}

/** The actions on people: each has a label under bulk and a confirmation under confirm. */
type ActionKey =
  | 'exempt'
  | 'notExempt'
  | 'reportsOnly'
  | 'submits'
  | 'timesheetsDefault'
  | 'makeAdmin'
  | 'removeAdmin'
  | 'activate'
  | 'deactivate';

/** An action waiting for the admin to confirm it. */
interface Pending {
  title: string;
  description: string;
  label: string;
  danger: boolean;
  run: () => void;
}

const toMenuItem = (a: Action): RowMenuItem => ({
  kind: 'action',
  label: a.label,
  onSelect: a.onSelect,
  destructive: a.danger,
  disabled: a.disabled,
  tooltip: a.tooltip,
});

/** One person. Each change is its own request, so the row carries its own pending and error states. */
function PersonRow({
  person,
  people,
  selected,
  onSelect,
  onMenu,
}: {
  person: Person;
  people: Person[];
  selected: boolean;
  /** Toggles the row; with Shift, everything from the last row toggled. */
  onSelect: (range: boolean) => void;
  /** Opens the people menu for this row at the pointer. */
  onMenu: (at: { x: number; y: number }) => void;
}) {
  const t = useTranslations('settings.people');
  const update = useUpdatePerson();
  const { settings, info } = useSession();
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
        submitsTimesheets: person.submitsTimesheetsOverride,
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
      submitsTimesheets: person.submitsTimesheetsOverride,
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
      <tr
        className={cn(!person.active && 'text-muted-foreground', selected && 'bg-primary/8')}
        aria-busy={busy}
        onContextMenu={(e) => {
          // Inside a field, the browser's own menu (copy, paste) is the useful one.
          if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
          if (e.target instanceof HTMLSelectElement) return;
          e.preventDefault();
          // The keyboard's menu key reports no pointer: open beside the row instead.
          const box = e.currentTarget.getBoundingClientRect();
          onMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 24, y: box.bottom });
        }}
        onKeyDown={(e) => {
          // Not every browser turns the menu keys into a contextmenu event.
          if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          onMenu({ x: box.left + 24, y: box.bottom });
        }}
      >
        <td className={`${td} w-8 !pr-0`}>
          <input
            type="checkbox"
            className="size-4 cursor-pointer accent-(--color-primary) align-middle"
            aria-label={t('bulk.select', { name: person.name })}
            checked={selected}
            onClick={(e) => onSelect(e.shiftKey)}
            onChange={() => {}}
          />
        </td>
        <td className={`${td} whitespace-nowrap`}>
          <span className="flex items-center gap-2">
            <PersonIdentity person={person} people={people} />
            {person.admin && (
              <Chip tone="info" className="!px-1.5 !py-0 text-[11px]">
                <span
                  title={person.hostAdmin ? t('adminFromHost', { host: info.homeLabel || t('theHost') }) : undefined}
                >
                  {t('admin')}
                </span>
              </Chip>
            )}
          </span>
        </td>
        <td className={`${td} whitespace-nowrap text-muted-foreground`}>{person.email}</td>
        <td className={td}>
          {editing ? (
            <select
              className={`${controlClass} w-48 min-w-48`}
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
              className={`${controlClass} w-48 min-w-48`}
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
            <select
              className={`${controlClass} w-40 min-w-40`}
              aria-label={t('timesheetsFor', { name: person.name })}
              value={shown.submitsTimesheets == null ? '' : String(shown.submitsTimesheets)}
              disabled={busy}
              onChange={(e) => save({ submitsTimesheets: e.target.value === '' ? null : e.target.value === 'true' })}
            >
              <option value="">
                {t('timesheetsDefault', { value: settings.submitTimesheets ? t('submits') : t('reportsOnly') })}
              </option>
              <option value="true">{t('submits')}</option>
              <option value="false">{t('reportsOnly')}</option>
            </select>
          ) : (
            <span className="whitespace-nowrap">
              {person.submitsTimesheets ? t('submits') : t('reportsOnly')}
              {person.submitsTimesheetsOverride == null && (
                <span className="text-muted-foreground"> · {t('byDefault')}</span>
              )}
            </span>
          )}
        </td>
        <td className={td}>
          {editing ? (
            <input
              className={`${controlClass} w-36 min-w-36 font-mono`}
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
        <td className={`${td} w-8 whitespace-nowrap`}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t(editing ? 'doneFor' : 'editFor', { name: person.name })}
            onClick={() => setEditing(!editing)}
          >
            {t(editing ? 'done' : 'edit')}
          </Button>
          <button
            type="button"
            className="ml-0.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md align-middle text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('rowMenu', { name: person.name })}
            aria-haspopup="menu"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              onMenu({ x: box.right, y: box.bottom });
            }}
          >
            <MenuIcon aria-hidden className="size-4" />
          </button>
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
          <td colSpan={10} className="px-4 pb-2">
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
  const errorMessage = useErrorMessage();
  const people = usePeople();
  const sync = useSyncPeople();
  const bulk = useUpdatePeople();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [last, setLast] = useState<string | null>(null);
  const { openMenu, contextMenu } = useRowMenu();
  const admins = useSetAdmins();
  const me = useSession();
  // The action waiting to be confirmed.
  const [pending, setPending] = useState<Pending | null>(null);

  const list = people.data ?? [];
  // People who left the list (a sync, another admin) drop out of the selection.
  const chosen = list.filter((p) => selected.has(p.id));

  const select = (id: string, range: boolean) => {
    const next = new Set(selected);
    const on = !next.has(id);
    const from = range && last ? list.findIndex((p) => p.id === last) : -1;
    const to = list.findIndex((p) => p.id === id);
    const ids = from >= 0 ? list.slice(Math.min(from, to), Math.max(from, to) + 1).map((p) => p.id) : [id];
    for (const x of ids) {
      if (on) next.add(x);
      else next.delete(x);
    }
    setSelected(next);
    setLast(id);
  };
  // A right click on a row outside the selection acts on that row alone, as in a file list.
  const openRowMenu = (person: Person, at: { x: number; y: number }) => {
    let group = chosen;
    if (!selected.has(person.id)) {
      setSelected(new Set([person.id]));
      setLast(person.id);
      group = [person];
    }
    openMenu(at.x, at.y, actionsFor(group).map(toMenuItem));
  };

  /** Applies the patch to those in the group it would change. */
  const apply = (
    group: Person[],
    patch: Partial<PersonUpdate>,
    changes: (p: Person) => boolean,
    done: (count: number) => string,
  ) => {
    const targets = group.filter(changes);
    if (targets.length === 0) return;
    bulk.mutate(
      targets.map((p) => ({
        id: p.id,
        timezone: p.timezone,
        managerId: p.managerOverrideId,
        overtimeExempt: p.overtimeExempt,
        payrollId: p.payrollId,
        active: p.active,
        submitsTimesheets: p.submitsTimesheetsOverride,
        ...patch,
      })),
      {
        onSuccess: () => toast.success(done(targets.length)),
        onError: (err) => failed(err, targets.length),
      },
    );
  };
  const failed = (err: unknown, count: number) =>
    toast.error(
      err instanceof PartialFailure
        ? t('bulk.failed', { count: err.failed, total: err.total })
        : t('bulk.failed', { count, total: count }),
      { description: errorMessage(err instanceof PartialFailure ? err.cause : err) },
    );
  const setAdmin = (group: Person[], admin: boolean) => {
    const ids = group.map((p) => p.id);
    admins.mutate(
      { ids, admin },
      {
        onSuccess: () =>
          toast.success(
            admin ? t('bulk.madeAdmin', { count: ids.length }) : t('bulk.removedAdmin', { count: ids.length }),
          ),
        onError: (err) => failed(err, ids.length),
      },
    );
  };

  // One item per setting, saying what it would do: a mixed group is brought
  // into line, everyone already alike is switched over. Deactivating, the
  // destructive one, comes last.
  // Every action is confirmed first, naming who it is for.
  const confirmed = (
    key: ActionKey,
    group: Person[],
    run: () => void,
    extra: { danger?: boolean; disabled?: boolean; tooltip?: string | undefined } = {},
  ): Action => {
    const who = group.length === 1 ? (group[0]?.name ?? '') : t('bulk.people', { count: group.length });
    return {
      label: t(`bulk.${key}`),
      ...extra,
      onSelect: () =>
        setPending({
          title: t(`confirm.${key}.title`, { who }),
          description: t(`confirm.${key}.description`),
          label: t(`bulk.${key}`).replace(/…$/, ''),
          danger: extra.danger ?? false,
          run,
        }),
    };
  };

  // One item per setting, saying what it would do: a mixed group is brought
  // into line, everyone already alike is switched over. Deactivating, the
  // destructive one, comes last.
  const actionsFor = (group: Person[]): Action[] => {
    const exempt = group.filter((p) => p.overtimeExempt);
    const submitting = group.filter((p) => p.submitsTimesheets);
    const overridden = group.filter((p) => p.submitsTimesheetsOverride != null);
    const active = group.filter((p) => p.active);
    const admin = group.filter((p) => p.admin);
    // Only grants made here can be taken back here, and never your own.
    const revocable = admin.filter((p) => !p.hostAdmin && p.id !== me.person.id);
    const others = (part: Person[]) => group.filter((p) => !part.includes(p));
    return [
      exempt.length === group.length
        ? confirmed('notExempt', group, () =>
            apply(
              group,
              { overtimeExempt: false },
              () => true,
              (count) => t('bulk.unexempted', { count }),
            ),
          )
        : confirmed('exempt', others(exempt), () =>
            apply(
              others(exempt),
              { overtimeExempt: true },
              () => true,
              (count) => t('bulk.exempted', { count }),
            ),
          ),
      submitting.length === group.length
        ? confirmed('reportsOnly', group, () =>
            apply(
              group,
              { submitsTimesheets: false },
              () => true,
              (count) => t('bulk.madeReportsOnly', { count }),
            ),
          )
        : confirmed('submits', others(submitting), () =>
            apply(
              others(submitting),
              { submitsTimesheets: true },
              () => true,
              (count) => t('bulk.madeSubmit', { count }),
            ),
          ),
      ...(overridden.length > 0
        ? [
            confirmed('timesheetsDefault', overridden, () =>
              apply(
                overridden,
                { submitsTimesheets: null },
                () => true,
                (count) => t('bulk.followDefault', { count }),
              ),
            ),
          ]
        : []),
      admin.length === group.length
        ? confirmed('removeAdmin', revocable, () => setAdmin(revocable, false), {
            disabled: revocable.length === 0,
            tooltip:
              revocable.length === 0
                ? group.some((p) => p.id === me.person.id)
                  ? t('bulk.ownAdmin')
                  : t('adminFromHost', { host: me.info.homeLabel || t('theHost') })
                : undefined,
          })
        : confirmed('makeAdmin', others(admin), () => setAdmin(others(admin), true)),
      active.length === group.length
        ? confirmed(
            'deactivate',
            group,
            () =>
              apply(
                group,
                { active: false },
                () => true,
                (count) => t('bulk.deactivated', { count }),
              ),
            { danger: true },
          )
        : confirmed('activate', others(active), () =>
            apply(
              others(active),
              { active: true },
              () => true,
              (count) => t('bulk.activated', { count }),
            ),
          ),
    ];
  };
  const busy = bulk.isPending || admins.isPending;

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
            {chosen.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-4 py-2">
                <span className="mr-1 text-sm font-medium" role="status">
                  {t('bulk.selected', { count: chosen.length })}
                </span>
                {actionsFor(chosen).map((a) => (
                  <Button
                    key={a.label}
                    size="sm"
                    variant={a.danger ? 'danger' : 'outline'}
                    disabled={busy || a.disabled}
                    title={a.tooltip}
                    onClick={a.onSelect}
                  >
                    {a.label}
                  </Button>
                ))}
                {busy && <LoaderIcon className="size-3.5 text-muted-foreground" aria-label={t('saving')} />}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
                  {t('bulk.clear')}
                </Button>
              </div>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={`${th} w-8 !pr-0`}>
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer accent-(--color-primary) align-middle"
                      aria-label={t('bulk.selectAll')}
                      checked={chosen.length > 0 && chosen.length === list.length}
                      ref={(el) => {
                        if (el) el.indeterminate = chosen.length > 0 && chosen.length < list.length;
                      }}
                      onChange={(e) => setSelected(new Set(e.target.checked ? list.map((p) => p.id) : []))}
                    />
                  </th>
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
                    {t('columns.timesheets')}
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
                  <PersonRow
                    key={p.id}
                    person={p}
                    people={people.data}
                    selected={selected.has(p.id)}
                    onSelect={(range) => select(p.id, range)}
                    onMenu={(at) => openRowMenu(p, at)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {contextMenu}
      {pending && (
        <ConfirmModal
          open
          onClose={() => setPending(null)}
          title={pending.title}
          description={pending.description}
          confirmLabel={pending.label}
          destructive={pending.danger}
          onConfirm={pending.run}
        />
      )}
      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <li>{t('bulk.hint')}</li>
        <li>{t('notes.manager')}</li>
        <li>{t('notes.exempt')}</li>
        <li>{t('notes.payrollId')}</li>
        <li>{t('notes.timesheets')}</li>
        <li>{t('notes.active')}</li>
      </ul>
    </>
  );
}
