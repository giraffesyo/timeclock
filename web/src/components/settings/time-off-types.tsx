import { ConfirmModal } from '@parallelworks/ui';
import { AddIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { Segmented } from '@/components/segmented';
import { Chip } from '@/components/status';
import { type TimeOffType, useSaveTimeOffType, useTimeOffTypes } from '@/lib/queries';

type PaysAs = TimeOffType['paysAs'];

/** Adds a time off type, or renames one. How it's paid is fixed once time off is recorded as it. */
function TypeDialog({ type, onClose }: { type?: TimeOffType; onClose: () => void }) {
  const t = useTranslations('settings.timeOffTypes');
  const tc = useTranslations('common');
  const save = useSaveTimeOffType();
  const [name, setName] = useState(type?.name ?? '');
  const [paysAs, setPaysAs] = useState<PaysAs>(type?.paysAs ?? 'vacation');
  const locked = !!type?.used;

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={type ? t('editTitle', { name: type.name }) : t('addTitle')}
      confirmLabel={tc('save')}
      confirmDisabled={name.trim() === ''}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await save.mutateAsync({ id: type?.id, name: name.trim(), paysAs, archived: type?.archived });
          onClose();
        } catch {
          // Shown below from save.error; the dialog stays open to fix it.
        }
      }}
    >
      <div className="space-y-3">
        <Field label={t('name')}>
          <input
            className={controlClass}
            value={name}
            maxLength={60}
            placeholder={t('namePlaceholder')}
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              save.reset();
            }}
          />
        </Field>
        {/* Not a Field: its label would forward a click to the first choice. */}
        <div className="text-sm">
          <span className="mb-1 block font-medium">{t('paysAs')}</span>
          {locked ? (
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{tc(`paysAs.${paysAs}`)}</span>
              <span className="text-xs text-muted-foreground">{t('paysAsLocked')}</span>
            </p>
          ) : (
            <>
              <Segmented<PaysAs>
                label={t('paysAs')}
                value={paysAs}
                onChange={(v) => {
                  setPaysAs(v);
                  save.reset();
                }}
                options={[
                  { value: 'vacation', label: tc('paysAs.vacation') },
                  { value: 'sick', label: tc('paysAs.sick') },
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('paysAsHint')}</p>
            </>
          )}
        </div>
      </div>
      {save.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={save.error} />}
    </ConfirmModal>
  );
}

/**
 * The kinds of time off people choose from, as the workspace names them, and
 * how payroll pays each. A type is archived rather than removed, so time off
 * recorded as it keeps its name.
 */
export function TimeOffTypes() {
  const t = useTranslations('settings.timeOffTypes');
  const tc = useTranslations('common');
  const list = useTimeOffTypes();
  const save = useSaveTimeOffType();
  const [editing, setEditing] = useState<{ type?: TimeOffType } | null>(null);
  const [failed, setFailed] = useState<{ name: string; error: unknown } | null>(null);

  const offered = (list.data ?? []).filter((type) => !type.archived);
  const archive = async (type: TimeOffType, archived: boolean) => {
    setFailed(null);
    try {
      await save.mutateAsync({ id: type.id, name: type.name, paysAs: type.paysAs, archived });
    } catch (error) {
      setFailed({ name: type.name, error });
    }
  };

  return (
    <Panel
      flush
      title={t('title')}
      actions={
        <Button size="sm" variant="primary" icon={<AddIcon aria-hidden />} onClick={() => setEditing({})}>
          {t('add')}
        </Button>
      }
    >
      <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{t('hint')}</p>
      {failed && <ErrorNote className="m-4" context={t('archiveFailed', { name: failed.name })} error={failed.error} />}
      {list.isError ? (
        <ErrorNote className="m-4" context={t('loadFailed')} error={list.error} />
      ) : list.isPending ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-border">
          {list.data.map((type) => (
            <li
              key={type.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm ${type.archived ? 'text-muted-foreground' : ''}`}
            >
              <span className="min-w-0 flex-1 font-medium">{type.name}</span>
              {type.archived && <Chip tone="neutral">{t('archived')}</Chip>}
              <span className="w-28 text-xs text-muted-foreground">
                {t('paidAs', { kind: tc(`paysAs.${type.paysAs}`) })}
              </span>
              <span className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('editFor', { name: type.name })}
                  onClick={() => setEditing({ type })}
                >
                  {t('edit')}
                </Button>
                {type.archived ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('restoreFor', { name: type.name })}
                    onClick={() => archive(type, false)}
                  >
                    {t('restore')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('archiveFor', { name: type.name })}
                    // The last one offered stays: without it no one could record time off.
                    disabled={offered.length <= 1}
                    onClick={() => archive(type, true)}
                  >
                    {t('archive')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && <TypeDialog type={editing.type} onClose={() => setEditing(null)} />}
    </Panel>
  );
}
