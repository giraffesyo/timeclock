import { ConfirmModal } from '@parallelworks/ui';
import { AddIcon, CloseIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { type Holiday, useDeleteHoliday, useHolidays, useSaveHoliday } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { dayToDate } from '@/lib/time';

/** What a holiday day pays when the admin doesn't say. */
const FULL_DAY = 8;

/** A day as typed: hours stay text so the field can be empty, which pays a full day. */
interface DraftDay {
  key: number;
  day: string;
  hours: string;
}

let nextKey = 0;
const draftDay = (day = '', hours = ''): DraftDay => ({ key: nextKey++, day, hours });

/** Adds a holiday, or changes one: its name and the observed days it covers. */
function HolidayDialog({ holiday, onClose }: { holiday?: Holiday; onClose: () => void }) {
  const t = useTranslations('settings.holidays');
  const tc = useTranslations('common');
  const save = useSaveHoliday();
  const [name, setName] = useState(holiday?.name ?? '');
  const [days, setDays] = useState<DraftDay[]>(() =>
    holiday?.days?.length
      ? holiday.days.map((d) => draftDay(d.day, d.hours === FULL_DAY ? '' : String(d.hours)))
      : [draftDay()],
  );
  const change = (key: number, patch: Partial<DraftDay>) => {
    setDays((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    save.reset();
  };

  const hoursOf = (d: DraftDay) => (d.hours.trim() === '' ? FULL_DAY : Number.parseFloat(d.hours));
  const chosen = days.map((d) => d.day).filter(Boolean);
  const valid =
    name.trim() !== '' &&
    days.every((d) => d.day !== '' && Number.isFinite(hoursOf(d)) && hoursOf(d) > 0 && hoursOf(d) <= 24) &&
    new Set(chosen).size === chosen.length;

  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={holiday ? t('editTitle') : t('addTitle')}
      confirmLabel={tc('save')}
      confirmDisabled={!valid}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await save.mutateAsync({
            id: holiday?.id,
            name: name.trim(),
            days: days.map((d) => ({ day: d.day, hours: hoursOf(d) })),
          });
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
            maxLength={120}
            placeholder={t('namePlaceholder')}
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              save.reset();
            }}
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('days')}</legend>
          <p className="text-xs text-muted-foreground">{t('daysHint', { hours: FULL_DAY })}</p>
          {days.map((d, i) => (
            <div key={d.key} className="flex items-center gap-2">
              <input
                type="date"
                required
                className={`${controlClass} min-w-0 flex-1`}
                aria-label={t('dayLabel', { n: i + 1 })}
                value={d.day}
                onChange={(e) => change(d.key, { day: e.target.value })}
              />
              <input
                type="number"
                min={0.25}
                max={24}
                step="any"
                inputMode="decimal"
                className={`${controlClass} tabular w-24`}
                aria-label={t('hoursLabel', { n: i + 1 })}
                placeholder={String(FULL_DAY)}
                value={d.hours}
                onChange={(e) => change(d.key, { hours: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">{t('hoursUnit')}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('removeDay', { n: i + 1 })}
                disabled={days.length === 1}
                onClick={() => setDays((list) => list.filter((x) => x.key !== d.key))}
              >
                <CloseIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={<AddIcon aria-hidden />}
            onClick={() => setDays((l) => [...l, draftDay()])}
          >
            {t('addDay')}
          </Button>
        </fieldset>
      </div>
      {save.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={save.error} />}
    </ConfirmModal>
  );
}

/** The company's holidays: paid hours for everyone whose holiday pay is on. */
export function Holidays() {
  const t = useTranslations('settings.holidays');
  const tc = useTranslations('common');
  const format = useFormatter();
  const { today } = useSession();
  const list = useHolidays();
  const remove = useDeleteHoliday();
  const [editing, setEditing] = useState<{ holiday?: Holiday } | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);

  // Upcoming holidays first, soonest first; then past ones, most recent first.
  const last = (h: Holiday) => h.days?.at(-1)?.day ?? '';
  const sorted = [...(list.data ?? [])].sort((a, b) => {
    const pa = last(a) < today;
    const pb = last(b) < today;
    if (pa !== pb) return pa ? 1 : -1;
    return pa ? last(b).localeCompare(last(a)) : last(a).localeCompare(last(b));
  });

  const dayLabel = (day: string, hours: number) => {
    const date = format.dateTime(dayToDate(day), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return hours === FULL_DAY ? date : t('dayWithHours', { date, hours });
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
      {list.isError ? (
        <ErrorNote className="m-4" context={t('loadFailed')} error={list.error} />
      ) : list.isPending ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty>{t('empty')}</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((h) => {
            const days = h.days ?? [];
            const past = last(h) < today;
            return (
              <li
                key={h.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm ${past ? 'text-muted-foreground' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{h.name}</p>
                  <p className="tabular text-xs text-muted-foreground">
                    {days.map((d) => dayLabel(d.day, d.hours)).join(' · ')}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('editFor', { name: h.name })}
                  onClick={() => setEditing({ holiday: h })}
                >
                  {t('edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('deleteFor', { name: h.name })}
                  onClick={() => setDeleting(h)}
                >
                  {tc('delete')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <HolidayDialog holiday={editing.holiday} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmModal
          open
          onClose={() => {
            setDeleting(null);
            remove.reset();
          }}
          title={t('deleteTitle', { name: deleting.name })}
          description={t('deleteDescription')}
          confirmLabel={tc('delete')}
          destructive
          closeOnConfirm={false}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(deleting.id);
              setDeleting(null);
            } catch {
              // Shown below from remove.error.
            }
          }}
        >
          {remove.isError ? <ErrorNote context={t('deleteFailed')} error={remove.error} /> : null}
        </ConfirmModal>
      )}
    </Panel>
  );
}
