import { useErrorMessage } from '@parallelworks/problem/react';
import { ConfirmModal, Table } from '@parallelworks/ui';
import { LoaderIcon, RefreshIcon } from '@parallelworks/ui/icons';
import {
  ListColumns,
  ListDisplayMenu,
  ListRow,
  ListRowActionsProvider,
  type ListView,
  listTableProps,
  type OpenMenu,
  type RowMenuItem,
  RowSelectCheckbox,
  useListNavigate,
  useListView,
  useRowMenu,
} from '@parallelworks/ui/list';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { PersonIdentity } from '@/components/person-identity';
import { PersonSelect, personChoices } from '@/components/person-select';
import { Invites } from '@/components/settings/invites';
import { SwitchRow } from '@/components/settings/switch';
import { Chip } from '@/components/status';
import { ZoneSelect } from '@/components/zone-select';
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
  | 'payHolidays'
  | 'noHolidayPay'
  | 'holidayPayDefault'
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
function PersonDialog({ person, people, onClose }: { person: Person; people: Person[]; onClose: () => void }) {
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

/** One person, on the UI package's list row: ⋯ and a right click open the people menu. */
function PersonRow({
  person,
  people,
  view,
  items,
  openMenu,
  selected,
  selectionActive,
  onSelect,
  onEdit,
}: {
  person: Person;
  people: Person[];
  view: ListView<Person>;
  /** The menu for this person alone; openMenu decides who it is for when it opens. */
  items: RowMenuItem[];
  openMenu: OpenMenu;
  selected: boolean;
  /** While anyone is selected, a click on a row toggles it. */
  selectionActive: boolean;
  /** Toggles the row; with Shift, everything from the last row toggled. */
  onSelect: (range: boolean) => void;
  onEdit: () => void;
}) {
  const t = useTranslations('settings.people');
  const { settings, info } = useSession();
  const goTo = useListNavigate();
  const effectiveManagerId = person.managerOverrideId || person.directoryManagerId;
  const manager = people.find((p) => p.id === effectiveManagerId);

  const cells: Record<string, ReactNode> = {
    name: (
      <span className="flex items-center gap-2">
        <PersonIdentity person={person} people={people} />
        {person.admin && (
          <Chip
            tone="info"
            className="!px-1.5 !py-0 text-[11px]"
            hint={
              person.hostAdmin
                ? `${t('adminHint')} ${
                    // On its own, Timeclock has account pages and no host: the grant came from an
                    // invitation or the server's settings. Embedded, the host decides.
                    info.accountsUrl
                      ? t('adminFromServer')
                      : t('adminFromHost', { host: info.homeLabel || t('theHost') })
                  }`
                : t('adminHint')
            }
          >
            {t('admin')}
          </Chip>
        )}
      </span>
    ),
    email: <span className="text-muted-foreground">{person.email}</span>,
    manager: manager ? (
      <PersonIdentity person={manager} people={people} />
    ) : (
      <span>{effectiveManagerId || t('adminApproves')}</span>
    ),
    timezone: person.timezone || settings.timezone,
    exempt: person.overtimeExempt ? t('yes') : t('no'),
    timesheets: (
      <>
        {person.submitsTimesheets ? t('submits') : t('reportsOnly')}
        {person.submitsTimesheetsOverride == null && <span className="text-muted-foreground"> · {t('byDefault')}</span>}
      </>
    ),
    holidayPay: (
      <>
        {person.holidayPay ? t('paid') : t('notPaid')}
        {person.holidayPayOverride == null && <span className="text-muted-foreground"> · {t('byDefault')}</span>}
      </>
    ),
    payrollId: person.payrollId || t('notSet'),
    active: person.active ? t('active') : t('inactive'),
  };

  return (
    <ListRow
      href={null}
      onActivate={onEdit}
      items={items}
      goTo={goTo}
      openMenu={openMenu}
      selected={selected}
      selectionActive={selectionActive}
      onRowSelect={(e) => onSelect(e.shiftKey)}
      className={person.active ? undefined : 'text-muted-foreground'}
      leading={
        <Table.Item className="w-8 py-1.5">
          <RowSelectCheckbox
            checked={selected}
            label={t('bulk.select', { name: person.name })}
            onToggle={(e) => onSelect(e.shiftKey)}
          />
        </Table.Item>
      }
    >
      {view.visibleColumns.map((col) => (
        <Table.Item key={col.key} className="py-1.5">
          {cells[col.key]}
        </Table.Item>
      ))}
    </ListRow>
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
  const view = useListView<Person>({
    storageKey: 'timeclock.settings.people',
    columns: [
      { key: 'name', label: t('columns.name'), alwaysVisible: true },
      // The profile card shows the email; the column is there to turn on.
      { key: 'email', label: t('columns.email'), priority: 'low', defaultHidden: true },
      { key: 'manager', label: t('columns.manager') },
      { key: 'timezone', label: t('columns.timezone'), priority: 'medium' },
      { key: 'exempt', label: t('columns.exempt'), priority: 'low' },
      { key: 'timesheets', label: t('columns.timesheets'), priority: 'medium' },
      // Off until shown from the Display menu, so the table fits without scrolling.
      { key: 'holidayPay', label: t('columns.holidayPay'), priority: 'low', defaultHidden: true },
      { key: 'payrollId', label: t('columns.payrollId'), priority: 'low' },
      { key: 'active', label: t('columns.active'), priority: 'medium' },
    ],
    defaultShowColumnHeaders: true,
  });
  const admins = useSetAdmins();
  const me = useSession();
  // The action waiting to be confirmed.
  const [pending, setPending] = useState<Pending | null>(null);
  // The person whose settings are open.
  const [editing, setEditing] = useState<Person | null>(null);

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
  const openRowMenu =
    (person: Person): OpenMenu =>
    (x, y, _items, onClose) => {
      let group = chosen;
      if (!selected.has(person.id)) {
        setSelected(new Set([person.id]));
        setLast(person.id);
        group = [person];
      }
      // The keyboard's menu key reports no pointer: open beside what has focus instead.
      if (!x && !y && document.activeElement) {
        const box = document.activeElement.getBoundingClientRect();
        [x, y] = [box.left + 24, box.bottom];
      }
      openMenu(x, y, actionsFor(group).map(toMenuItem), onClose);
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
        holidayPay: p.holidayPayOverride,
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
    const paid = group.filter((p) => p.holidayPay);
    const payOverridden = group.filter((p) => p.holidayPayOverride != null);
    const active = group.filter((p) => p.active);
    const admin = group.filter((p) => p.admin);
    // Only grants made here can be taken back here, and never your own.
    const revocable = admin.filter((p) => !p.hostAdmin && p.id !== me.person.id);
    const others = (part: Person[]) => group.filter((p) => !part.includes(p));
    const [only] = group;
    return [
      ...(only && group.length === 1 ? [{ label: t('edit'), onSelect: () => setEditing(only) }] : []),
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
      paid.length === group.length
        ? confirmed('noHolidayPay', group, () =>
            apply(
              group,
              { holidayPay: false },
              () => true,
              (count) => t('bulk.madeNoHolidayPay', { count }),
            ),
          )
        : confirmed('payHolidays', others(paid), () =>
            apply(
              others(paid),
              { holidayPay: true },
              () => true,
              (count) => t('bulk.madePayHolidays', { count }),
            ),
          ),
      ...(payOverridden.length > 0
        ? [
            confirmed('holidayPayDefault', payOverridden, () =>
              apply(
                payOverridden,
                { holidayPay: null },
                () => true,
                (count) => t('bulk.followHolidayDefault', { count }),
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
          <>
            <ListDisplayMenu view={view} />
            <Button size="sm" loading={sync.isPending} icon={<RefreshIcon aria-hidden />} onClick={() => sync.mutate()}>
              {t('sync')}
            </Button>
          </>
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
          // Not every browser turns the menu keys into a contextmenu event: send the row one.
          // biome-ignore lint/a11y/noStaticElementInteractions: forwards the menu keys to the focused row
          <div
            className="@container"
            onKeyDown={(e) => {
              if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
              const row = (e.target as HTMLElement).closest('tbody tr');
              if (!row) return;
              e.preventDefault();
              row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            }}
          >
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
            <ListRowActionsProvider view={view}>
              <Table {...listTableProps} wrapperClassName="overflow-x-auto" tbodyClassName="divide-y divide-border">
                {view.showColumnHeaders && (
                  <Table.Header className="w-8 py-2" caps={false}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer rounded border-(--theme-border) align-middle"
                      aria-label={t('bulk.selectAll')}
                      checked={chosen.length > 0 && chosen.length === list.length}
                      ref={(el) => {
                        if (el) el.indeterminate = chosen.length > 0 && chosen.length < list.length;
                      }}
                      onChange={(e) => setSelected(new Set(e.target.checked ? list.map((p) => p.id) : []))}
                    />
                  </Table.Header>
                )}
                {view.showColumnHeaders && <ListColumns view={view} />}
                {people.data.map((p) => (
                  <PersonRow
                    key={p.id}
                    person={p}
                    people={people.data}
                    view={view}
                    items={actionsFor([p]).map(toMenuItem)}
                    openMenu={openRowMenu(p)}
                    selected={selected.has(p.id)}
                    selectionActive={chosen.length > 0}
                    onSelect={(range) => select(p.id, range)}
                    onEdit={() => setEditing(p)}
                  />
                ))}
              </Table>
            </ListRowActionsProvider>
          </div>
        )}
      </Panel>
      {contextMenu}
      {editing && (
        <PersonDialog
          person={list.find((p) => p.id === editing.id) ?? editing}
          people={list}
          onClose={() => setEditing(null)}
        />
      )}
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
        <li>{t('notes.holidayPay')}</li>
        <li>{t('notes.active')}</li>
      </ul>
    </>
  );
}
