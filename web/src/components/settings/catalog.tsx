import { toApiError } from '@parallelworks/problem';
import { ConfirmModal, Table } from '@parallelworks/ui';
import { AddIcon, ArchiveIcon, EditIcon, TrashIcon } from '@parallelworks/ui/icons';
import {
  ListColumns,
  ListDisplayMenu,
  ListFilterMenu,
  ListRow,
  ListRowActionsProvider,
  listTableProps,
  type OpenMenu,
  type RowMenuItem,
  useListNavigate,
  useListView,
  useRowMenu,
} from '@parallelworks/ui/list';
import { type ReactNode, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { SwitchRow } from '@/components/settings/switch';
import { Chip } from '@/components/status';
import { cn } from '@/lib/cn';
import {
  type Customer,
  type Project,
  useCustomers,
  useDeleteCustomer,
  useDeleteProject,
  useProjects,
  useSaveCustomer,
  useSaveProject,
} from '@/lib/queries';

type Target = { type: 'customer'; customer: Customer } | { type: 'project'; project: Project };

const targetName = (target: Target) => (target.type === 'customer' ? target.customer.name : target.project.name);

/** Adds a customer, or renames one. */
function CustomerDialog({ customer, onClose }: { customer?: Customer; onClose: () => void }) {
  const t = useTranslations('settings.catalog');
  const tc = useTranslations('common');
  const save = useSaveCustomer();
  const [name, setName] = useState(customer?.name ?? '');

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={customer ? t('customer.renameTitle') : t('customer.addTitle')}
      confirmLabel={tc('save')}
      confirmDisabled={!name.trim()}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await save.mutateAsync({ id: customer?.id, name: name.trim(), archived: customer?.archived });
          onClose();
        } catch {
          // Shown below from save.error; the dialog stays open to fix it.
        }
      }}
    >
      <Field label={t('customer.name')}>
        <input
          className={controlClass}
          value={name}
          maxLength={120}
          // biome-ignore lint/a11y/noAutofocus: the dialog has one field
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {save.isError && <ErrorNote className="mt-3" context={t('customer.saveFailed')} error={save.error} />}
    </ConfirmModal>
  );
}

/** Adds a project to a customer, or edits one. */
function ProjectDialog({
  project,
  customerId,
  customers,
  onClose,
}: {
  project?: Project;
  /** The customer a new project starts under; empty for internal work. */
  customerId: string;
  customers: Customer[];
  onClose: () => void;
}) {
  const t = useTranslations('settings.catalog');
  const tc = useTranslations('common');
  const save = useSaveProject();
  const [name, setName] = useState(project?.name ?? '');
  const [code, setCode] = useState(project?.code ?? '');
  const [billable, setBillable] = useState(project?.billable ?? true);
  const [customer, setCustomer] = useState(project?.customerId ?? customerId);

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={project ? t('project.editTitle') : t('project.addTitle')}
      confirmLabel={tc('save')}
      confirmDisabled={!name.trim()}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await save.mutateAsync({
            id: project?.id,
            customerId: customer || undefined,
            name: name.trim(),
            code: code.trim(),
            billable,
            archived: project?.archived,
          });
          onClose();
        } catch {
          // Shown below from save.error; the dialog stays open to fix it.
        }
      }}
    >
      <div className="space-y-3">
        <Field label={t('project.name')}>
          <input
            className={controlClass}
            value={name}
            maxLength={120}
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t('project.code')} hint={t('project.codeHint')}>
          <input className={controlClass} value={code} maxLength={64} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label={t('project.customer')}>
          <select className={controlClass} value={customer} onChange={(e) => setCustomer(e.target.value)}>
            <option value="">{t('project.noCustomer')}</option>
            {customers
              .filter((c) => !c.archived || c.id === customer)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        <SwitchRow
          label={t('project.billable')}
          hint={billable ? t('project.billableOn') : t('project.billableOff')}
          value={billable}
          onChange={setBillable}
        />
      </div>
      {save.isError && <ErrorNote className="mt-3" context={t('project.saveFailed')} error={save.error} />}
    </ConfirmModal>
  );
}

/** Where a menu opens: at the pointer, or beside what has focus when the keyboard opened it. */
const menuAt =
  (openMenu: OpenMenu): OpenMenu =>
  (x, y, items, onClose) => {
    if (!x && !y && document.activeElement) {
      const box = document.activeElement.getBoundingClientRect();
      [x, y] = [box.left + 24, box.bottom];
    }
    openMenu(x, y, items, onClose);
  };

/** A row without a menu still keeps the actions column, so the cells line up. */
function PlainRow({ actions, children }: { actions: boolean; children: ReactNode }) {
  return (
    <tr>
      {children}
      {actions && <Table.Item />}
    </tr>
  );
}

/**
 * Customers with their projects under them, on the UI package's list view:
 * ⋯ and a right click open the same menu on every row. Archiving keeps the
 * recorded time and stops new time; deleting works only for what was never used.
 */
export function Catalog() {
  const t = useTranslations('settings.catalog');
  const tc = useTranslations('common');
  const customers = useCustomers(true);
  const projects = useProjects(true);
  const saveCustomer = useSaveCustomer();
  const saveProject = useSaveProject();
  const deleteCustomer = useDeleteCustomer();
  const deleteProject = useDeleteProject();
  const goTo = useListNavigate();
  const { openMenu, contextMenu } = useRowMenu();

  const [customerDialog, setCustomerDialog] = useState<{ customer?: Customer } | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ project?: Project; customerId: string } | null>(null);
  const [archiving, setArchiving] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  // What the last archive or unarchive was for, to say so if it fails.
  const [archiveName, setArchiveName] = useState('');

  const allCustomers = customers.data ?? [];
  const allProjects = projects.data ?? [];
  const archivedCount =
    allCustomers.filter((c) => c.archived).length +
    allProjects.filter((p) => p.archived && !allCustomers.find((c) => c.id === p.customerId)?.archived).length;

  const view = useListView<Customer | Project>({
    storageKey: 'timeclock.settings.catalog',
    columns: [
      { key: 'name', label: t('columns.name'), alwaysVisible: true },
      { key: 'code', label: t('columns.code'), priority: 'low' },
      { key: 'billable', label: t('columns.billable'), priority: 'medium' },
      { key: 'status', label: t('columns.status'), priority: 'medium' },
    ],
    // Archived things are hidden until the filter asks for them, as the old toggle did.
    facets: [
      {
        key: 'archived',
        label: t('archived'),
        options: [{ value: 'show', label: t('showArchived', { count: archivedCount }) }],
        matches: () => true,
      },
    ],
    // Room for the pinned Add project button on customers.
    actionCount: 1,
    defaultShowColumnHeaders: true,
  });
  const showArchived = (view.filters.archived?.length ?? 0) > 0;

  const setArchived = (target: Target, archived: boolean) => {
    setArchiveName(targetName(target));
    if (target.type === 'customer') {
      saveProject.reset();
      return saveCustomer.mutateAsync({ id: target.customer.id, name: target.customer.name, archived });
    }
    const p = target.project;
    saveCustomer.reset();
    return saveProject.mutateAsync({
      id: p.id,
      customerId: p.customerId,
      name: p.name,
      code: p.code,
      billable: p.billable,
      archived,
    });
  };
  const unarchive = (target: Target) => {
    // The failure is shown above the list from the mutation's error.
    setArchived(target, false).catch(() => {});
  };
  const archivePending = saveCustomer.isPending || saveProject.isPending;
  const archiveError = saveCustomer.error ?? saveProject.error;

  const remove = deleting?.type === 'customer' ? deleteCustomer : deleteProject;
  const inUse = remove.isError && toApiError(remove.error).code === 'in_use';
  const deletingArchived = deleting?.type === 'customer' ? deleting.customer.archived : deleting?.project.archived;
  const closeDelete = () => {
    setDeleting(null);
    deleteCustomer.reset();
    deleteProject.reset();
  };

  const shownCustomers = allCustomers.filter((c) => showArchived || !c.archived);
  // Internal work has no customer: it is listed first, as a group of its own.
  const groups: (Customer & { internal?: boolean })[] = [
    { id: '', name: t('internal'), archived: false, internal: true },
    ...shownCustomers,
  ];

  // Each menu: what changes it first, what can't be undone last.
  const customerMenu = (c: Customer & { internal?: boolean }): RowMenuItem[] => {
    const target: Target = { type: 'customer', customer: c };
    if (c.archived)
      return [
        { kind: 'action', label: t('unarchive'), disabled: archivePending, onSelect: () => unarchive(target) },
        { kind: 'divider' },
        { kind: 'action', label: t('menu.delete'), destructive: true, onSelect: () => setDeleting(target) },
      ];
    const add: RowMenuItem = {
      kind: 'action',
      label: t('menu.addProject'),
      icon: <AddIcon />,
      onSelect: () => setProjectDialog({ customerId: c.id }),
    };
    if (c.internal) return [add];
    return [
      add,
      {
        kind: 'action',
        label: t('menu.rename'),
        icon: <EditIcon />,
        onSelect: () => setCustomerDialog({ customer: c }),
      },
      { kind: 'action', label: t('menu.archive'), icon: <ArchiveIcon />, onSelect: () => setArchiving(target) },
      { kind: 'divider' },
      {
        kind: 'action',
        label: t('menu.delete'),
        icon: <TrashIcon />,
        destructive: true,
        onSelect: () => setDeleting(target),
      },
    ];
  };
  const projectMenu = (p: Project): RowMenuItem[] => {
    const target: Target = { type: 'project', project: p };
    const del: RowMenuItem = {
      kind: 'action',
      label: t('menu.delete'),
      icon: <TrashIcon />,
      destructive: true,
      onSelect: () => setDeleting(target),
    };
    if (p.archived)
      return [
        { kind: 'action', label: t('unarchive'), disabled: archivePending, onSelect: () => unarchive(target) },
        { kind: 'divider' },
        del,
      ];
    return [
      {
        kind: 'action',
        label: t('menu.edit'),
        icon: <EditIcon />,
        onSelect: () => setProjectDialog({ project: p, customerId: p.customerId ?? '' }),
      },
      { kind: 'action', label: t('menu.archive'), icon: <ArchiveIcon />, onSelect: () => setArchiving(target) },
      { kind: 'divider' },
      del,
    ];
  };

  const archivedChip = (
    <Chip tone="neutral" hint={t('archivedHint')}>
      {t('archived')}
    </Chip>
  );
  const customerCells = (c: Customer): Record<string, ReactNode> => ({
    name: <span className={cn('font-semibold', c.archived && 'text-muted-foreground')}>{c.name}</span>,
    status: c.archived && archivedChip,
  });
  const projectCells = (p: Project, underArchived: boolean): Record<string, ReactNode> => ({
    name: <span className={cn('block pl-4', p.archived ? 'text-muted-foreground' : 'font-medium')}>{p.name}</span>,
    code: p.code && <span className="font-mono text-xs text-muted-foreground">{p.code}</span>,
    billable: (
      <Chip
        tone={p.billable ? 'info' : 'neutral'}
        hint={p.billable ? t('project.billableHint') : t('project.notBillableHint')}
      >
        {p.billable ? t('project.billable') : t('project.notBillable')}
      </Chip>
    ),
    // Under an archived customer every project reads as archived; the customer's chip says so.
    status: p.archived && !underArchived && archivedChip,
  });
  const cellsOf = (cells: Record<string, ReactNode>) =>
    view.visibleColumns.map((col) => (
      <Table.Item key={col.key} className="py-2">
        {cells[col.key]}
      </Table.Item>
    ));
  const width = view.visibleColumns.length + (view.showActions ? 1 : 0);

  return (
    <>
      <Panel
        flush
        title={t('title')}
        actions={
          <>
            {archivedCount > 0 && <ListFilterMenu view={view} />}
            <ListDisplayMenu view={view} />
            <Button variant="primary" size="sm" icon={<AddIcon aria-hidden />} onClick={() => setCustomerDialog({})}>
              {t('customer.add')}
            </Button>
          </>
        }
      >
        {archiveError && !archiving && !deleting && (
          <ErrorNote className="m-3" context={t('changeFailed', { name: archiveName })} error={archiveError} />
        )}
        {customers.isError || projects.isError ? (
          <ErrorNote className="m-4" context={t('loadFailed')} error={customers.error ?? projects.error} />
        ) : customers.isPending || projects.isPending ? (
          <Loading />
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
            <ListRowActionsProvider view={view}>
              <Table {...listTableProps} wrapperClassName="overflow-x-auto" tbodyClassName="divide-y divide-border">
                {view.showColumnHeaders && <ListColumns view={view} />}
                {groups.flatMap((c) => {
                  const own = allProjects.filter((p) => (p.customerId ?? '') === c.id && (showArchived || !p.archived));
                  const rename = !c.internal && !c.archived ? () => setCustomerDialog({ customer: c }) : undefined;
                  const header = (
                    <ListRow
                      key={`customer-${c.id}`}
                      href={null}
                      onActivate={rename}
                      items={customerMenu(c)}
                      goTo={goTo}
                      openMenu={menuAt(openMenu)}
                      pinnedActions={
                        c.archived
                          ? undefined
                          : [
                              {
                                key: 'add',
                                label: t('project.addTo', { name: c.name }),
                                icon: <AddIcon />,
                                onSelect: () => setProjectDialog({ customerId: c.id }),
                              },
                            ]
                      }
                      className="bg-muted"
                    >
                      {cellsOf(customerCells(c))}
                    </ListRow>
                  );
                  const rows = own.map((p) =>
                    c.archived ? (
                      <PlainRow key={p.id} actions={view.showActions}>
                        {cellsOf(projectCells(p, true))}
                      </PlainRow>
                    ) : (
                      <ListRow
                        key={p.id}
                        href={null}
                        onActivate={
                          p.archived
                            ? undefined
                            : () => setProjectDialog({ project: p, customerId: p.customerId ?? '' })
                        }
                        items={projectMenu(p)}
                        goTo={goTo}
                        openMenu={menuAt(openMenu)}
                      >
                        {cellsOf(projectCells(p, false))}
                      </ListRow>
                    ),
                  );
                  if (own.length === 0)
                    rows.push(
                      <tr key={`none-${c.id}`}>
                        <td colSpan={width} className="py-2.5 pr-4 pl-8 text-sm text-muted-foreground">
                          {c.archived ? t('project.noneArchived') : t('project.none')}
                        </td>
                      </tr>,
                    );
                  return [header, ...rows];
                })}
              </Table>
            </ListRowActionsProvider>
          </div>
        )}
      </Panel>
      {contextMenu}
      <p className="mt-2 text-xs text-muted-foreground">{t('archiveNote')}</p>

      {customerDialog && (
        <CustomerDialog
          key={customerDialog.customer?.id ?? 'new'}
          customer={customerDialog.customer}
          onClose={() => setCustomerDialog(null)}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          key={projectDialog.project?.id ?? `new-${projectDialog.customerId}`}
          project={projectDialog.project}
          customerId={projectDialog.customerId}
          customers={allCustomers}
          onClose={() => setProjectDialog(null)}
        />
      )}

      <ConfirmModal
        open={!!archiving}
        onClose={() => {
          setArchiving(null);
          saveCustomer.reset();
          saveProject.reset();
        }}
        title={archiving ? t('archiveTitle', { name: targetName(archiving) }) : ''}
        description={
          archiving
            ? archiving.type === 'customer'
              ? t('customer.archiveDescription')
              : t('project.archiveDescription')
            : null
        }
        confirmLabel={t('archive')}
        closeOnConfirm={false}
        onConfirm={async () => {
          if (!archiving) return;
          try {
            await setArchived(archiving, true);
            setArchiving(null);
          } catch {
            // Shown below from the mutation's error.
          }
        }}
      >
        {archiveError ? <ErrorNote context={t('changeFailed', { name: archiveName })} error={archiveError} /> : null}
      </ConfirmModal>

      <ConfirmModal
        open={!!deleting}
        onClose={closeDelete}
        title={deleting ? t('deleteTitle', { name: targetName(deleting) }) : ''}
        description={
          deleting
            ? deleting.type === 'customer'
              ? t('customer.deleteDescription')
              : t('project.deleteDescription')
            : null
        }
        // Once the server says it is in use, the way forward is to archive it.
        confirmLabel={inUse && !deletingArchived ? t('archiveInstead') : tc('delete')}
        confirmDisabled={inUse && !!deletingArchived}
        destructive={!inUse}
        closeOnConfirm={false}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            if (inUse) await setArchived(deleting, true);
            else if (deleting.type === 'customer') await deleteCustomer.mutateAsync(deleting.customer.id);
            else await deleteProject.mutateAsync(deleting.project.id);
            closeDelete();
          } catch {
            // Shown below.
          }
        }}
      >
        {inUse ? (
          <p role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
            {deleting?.type === 'customer' ? t('customer.inUse') : t('project.inUse')}
            {deletingArchived ? ` ${t('alreadyArchived')}` : ''}
          </p>
        ) : remove.isError ? (
          <ErrorNote context={t('deleteFailed')} error={remove.error} />
        ) : null}
        {inUse && archiveError ? (
          <ErrorNote className="mt-2" context={t('changeFailed', { name: archiveName })} error={archiveError} />
        ) : null}
      </ConfirmModal>
    </>
  );
}
