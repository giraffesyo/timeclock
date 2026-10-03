import { toApiError } from '@parallelworks/problem';
import { ConfirmModal } from '@parallelworks/ui';
import { AddIcon, ArchiveIcon, EditIcon, TrashIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { SwitchRow } from '@/components/settings/switch';
import { Chip } from '@/components/status';
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
  /** The customer a new project starts under. */
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
      confirmDisabled={!name.trim() || !customer}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await save.mutateAsync({
            id: project?.id,
            customerId: customer,
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

/**
 * Customers with their projects under them. Archiving keeps the recorded
 * time and stops new time; deleting works only for what was never used.
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

  const [showArchived, setShowArchived] = useState(false);
  const [customerDialog, setCustomerDialog] = useState<{ customer?: Customer } | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ project?: Project; customerId: string } | null>(null);
  const [archiving, setArchiving] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  // What the last archive or unarchive was for, to say so if it fails.
  const [archiveName, setArchiveName] = useState('');

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
  const pendingId = saveCustomer.isPending
    ? saveCustomer.variables?.id
    : saveProject.isPending
      ? saveProject.variables?.id
      : undefined;

  const remove = deleting?.type === 'customer' ? deleteCustomer : deleteProject;
  const inUse = remove.isError && toApiError(remove.error).code === 'in_use';
  const deletingArchived = deleting?.type === 'customer' ? deleting.customer.archived : deleting?.project.archived;
  const closeDelete = () => {
    setDeleting(null);
    deleteCustomer.reset();
    deleteProject.reset();
  };

  const allCustomers = customers.data ?? [];
  const allProjects = projects.data ?? [];
  const archivedCount =
    allCustomers.filter((c) => c.archived).length +
    allProjects.filter((p) => p.archived && !allCustomers.find((c) => c.id === p.customerId)?.archived).length;
  const shownCustomers = allCustomers.filter((c) => showArchived || !c.archived);

  const addCustomer = (
    <Button variant="primary" size="sm" icon={<AddIcon aria-hidden />} onClick={() => setCustomerDialog({})}>
      {t('customer.add')}
    </Button>
  );

  return (
    <>
      <Panel
        flush
        title={t('title')}
        actions={
          <>
            {archivedCount > 0 && (
              <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? t('hideArchived') : t('showArchived', { count: archivedCount })}
              </Button>
            )}
            {addCustomer}
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
        ) : shownCustomers.length === 0 ? (
          <Empty>{allCustomers.length === 0 ? t('empty') : t('emptyAllArchived')}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {shownCustomers.map((c) => {
              const own = allProjects.filter((p) => p.customerId === c.id && (showArchived || !p.archived));
              return (
                <li key={c.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted px-4 py-2">
                    <h3
                      className={`min-w-0 flex-1 truncate text-sm font-semibold ${c.archived ? 'text-muted-foreground' : ''}`}
                    >
                      {c.name}
                    </h3>
                    {c.archived && <Chip tone="neutral">{t('archived')}</Chip>}
                    <div className="flex flex-wrap items-center gap-0.5">
                      {c.archived ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={pendingId === c.id}
                          disabled={archivePending}
                          onClick={() => unarchive({ type: 'customer', customer: c })}
                        >
                          {t('unarchive')}
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<AddIcon aria-hidden />}
                            onClick={() => setProjectDialog({ customerId: c.id })}
                          >
                            {t('project.add')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setCustomerDialog({ customer: c })}>
                            {t('customer.rename')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setArchiving({ type: 'customer', customer: c })}
                          >
                            {t('archive')}
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('customer.delete', { name: c.name })}
                        onClick={() => setDeleting({ type: 'customer', customer: c })}
                      >
                        <TrashIcon aria-hidden />
                      </Button>
                    </div>
                  </div>
                  {own.length === 0 ? (
                    <p className="px-4 py-2.5 text-sm text-muted-foreground">
                      {c.archived ? t('project.noneArchived') : t('project.none')}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {own.map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pr-4 pl-8">
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate text-sm ${p.archived ? 'text-muted-foreground' : 'font-medium'}`}
                            >
                              {p.name}
                            </span>
                            {p.code && (
                              <span className="block truncate font-mono text-xs text-muted-foreground">{p.code}</span>
                            )}
                          </span>
                          <Chip tone={p.billable ? 'info' : 'neutral'}>
                            {p.billable ? t('project.billable') : t('project.notBillable')}
                          </Chip>
                          {/* Under an archived customer every project reads as archived; the customer's chip says so. */}
                          {p.archived && !c.archived && <Chip tone="neutral">{t('archived')}</Chip>}
                          {!c.archived && (
                            <span className="flex items-center gap-0.5">
                              {p.archived ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  loading={pendingId === p.id}
                                  disabled={archivePending}
                                  onClick={() => unarchive({ type: 'project', project: p })}
                                >
                                  {t('unarchive')}
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    aria-label={t('project.edit', { name: p.name })}
                                    onClick={() => setProjectDialog({ project: p, customerId: p.customerId })}
                                  >
                                    <EditIcon aria-hidden />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    aria-label={t('project.archive', { name: p.name })}
                                    onClick={() => setArchiving({ type: 'project', project: p })}
                                  >
                                    <ArchiveIcon aria-hidden />
                                  </Button>
                                </>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('project.delete', { name: p.name })}
                                onClick={() => setDeleting({ type: 'project', project: p })}
                              >
                                <TrashIcon aria-hidden />
                              </Button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
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
