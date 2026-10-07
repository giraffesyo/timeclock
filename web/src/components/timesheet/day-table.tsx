import { AddIcon, ChevronRightIcon } from '@parallelworks/ui/icons';
import { Fragment, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { DayTimeline } from '@/components/day-timeline';
import { EntryDialog } from '@/components/entry-dialog';
import { EntryList } from '@/components/entry-list';
import { Hours } from '@/components/hours';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { Chip } from '@/components/status';
import { totalHours } from '@/components/timesheet/sheet';
import { cn } from '@/lib/cn';
import { type Entry, type PeriodSummary, useEntries } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { type Day, dayOf, dayToDate } from '@/lib/time';
import { useZone } from '@/lib/zone';

const num = 'px-3 py-2 text-right';

/**
 * The pay period, one row per day, with a totals row. A day opens to show
 * its entries, which can be changed there unless the sheet is read-only.
 */
export function DayTable({
  summary,
  personId,
  readOnly,
}: {
  summary: PeriodSummary;
  /** Whose sheet, when it isn't the caller's. */
  personId?: string;
  /** Locked, or not the caller's to change: entries show without controls. */
  readOnly: boolean;
}) {
  const t = useTranslations('timesheet.days');
  const te = useTranslations('entry');
  const tc = useTranslations('common.columns');
  const format = useFormatter();
  const { today, settings } = useSession();
  const zone = useZone(personId);
  const { period } = summary;
  const days = summary.days ?? [];
  const entries = useEntries(period.start, period.end, personId);
  const [open, setOpen] = useState<ReadonlySet<Day>>(new Set());
  const [adding, setAdding] = useState<Day | null>(null);

  const byDay = new Map<Day, Entry[]>();
  for (const e of entries.data ?? []) {
    const day = dayOf(e.startedAt, zone);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  const allOpen = days.length > 0 && days.every((d) => open.has(d.day));
  const toggle = (day: Day) => {
    const next = new Set(open);
    if (!next.delete(day)) next.add(day);
    setOpen(next);
  };

  return (
    <Panel
      flush
      title={t('title')}
      actions={
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={allOpen}
          onClick={() => setOpen(allOpen ? new Set() : new Set(days.map((d) => d.day)))}
        >
          {allOpen ? t('collapseAll') : t('expandAll')}
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[39rem] border-collapse text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">
                {t('day')}
              </th>
              {(['regular', 'overtime', 'vacation', 'sick', 'holiday', 'total'] as const).map((c) => (
                <th key={c} scope="col" className={cn(num, 'w-20 font-medium', c === 'total' && 'pr-4')}>
                  {tc(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const date = dayToDate(d.day);
              const weekday = date.getDay();
              const weekend = weekday === 0 || weekday === 6;
              const isOpen = open.has(d.day);
              const dayEntries = byDay.get(d.day) ?? [];
              // Days ahead stay closed, unless the organization allows planned time.
              const future = d.day > today && !settings.allowPlannedTime;
              const longDate = format.dateTime(date, { weekday: 'long', month: 'long', day: 'numeric' });
              const rowId = `day-${d.day}`;
              return (
                <Fragment key={d.day}>
                  <tr className={cn('border-t border-border', weekend && 'bg-muted/50')}>
                    <th scope="row" className="p-0 text-left font-normal">
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left hover:bg-muted"
                        aria-expanded={isOpen}
                        aria-controls={rowId}
                        aria-label={isOpen ? t('hideDay', { date: longDate }) : t('showDay', { date: longDate })}
                        onClick={() => toggle(d.day)}
                      >
                        <ChevronRightIcon
                          aria-hidden
                          className={cn(
                            'size-3.5 shrink-0 text-muted-foreground transition-transform',
                            isOpen && 'rotate-90',
                          )}
                        />
                        <span className={cn('w-9 shrink-0', weekend ? 'text-muted-foreground' : 'font-medium')}>
                          {format.dateTime(date, { weekday: 'short' })}
                        </span>
                        <span className="tabular whitespace-nowrap text-muted-foreground">
                          {format.dateTime(date, { month: 'short', day: 'numeric' })}
                        </span>
                        {d.day === today && <Chip tone="info">{t('today')}</Chip>}
                        {d.holidayName && (
                          <Chip tone="neutral" className="max-w-40 truncate" hint={t('holidayHint')}>
                            {d.holidayName}
                          </Chip>
                        )}
                        {dayEntries.length > 0 && (
                          <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
                            {t('entryCount', { count: dayEntries.length })}
                          </span>
                        )}
                      </button>
                    </th>
                    <td className={num}>
                      <Hours value={d.regular} />
                    </td>
                    <td className={num}>
                      <Hours value={d.overtime} />
                    </td>
                    <td className={num}>
                      <Hours value={d.vacation} />
                    </td>
                    <td className={num}>
                      <Hours value={d.sick} />
                    </td>
                    <td className={num}>
                      <Hours value={d.holiday} />
                    </td>
                    <td className={cn(num, 'pr-4')}>
                      <Hours value={totalHours(d)} strong />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr id={rowId} className="border-t border-border bg-background">
                      <td colSpan={7} className="p-0">
                        {entries.isError ? (
                          <ErrorNote className="m-3" context={t('loadFailed')} error={entries.error} />
                        ) : entries.isPending ? (
                          <Loading className="py-4" />
                        ) : (
                          <>
                            {!future && (dayEntries.length > 0 || !readOnly) && (
                              <div className="border-b border-border px-4 py-3">
                                <DayTimeline day={d.day} entries={dayEntries} readOnly={readOnly} personId={personId} />
                              </div>
                            )}
                            {dayEntries.length > 0 ? (
                              <EntryList entries={dayEntries} readOnly={readOnly} />
                            ) : (
                              <p className="px-4 py-3 text-sm text-muted-foreground">
                                {future ? t('emptyFuture') : readOnly ? t('emptyReadOnly') : t('empty')}
                              </p>
                            )}
                            {!readOnly && !future && (
                              <div className="border-t border-border px-4 py-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon={<AddIcon aria-hidden />}
                                  onClick={() => setAdding(d.day)}
                                >
                                  {te('add')}
                                </Button>
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <th scope="row" className="px-4 py-2.5 text-left font-semibold">
                {t('totals')}
              </th>
              <td className={num}>
                <Hours value={summary.regular} strong />
              </td>
              <td className={num}>
                <Hours value={summary.overtime} strong />
              </td>
              <td className={num}>
                <Hours value={summary.vacation} strong />
              </td>
              <td className={num}>
                <Hours value={summary.sick} strong />
              </td>
              <td className={num}>
                <Hours value={summary.holiday} strong />
              </td>
              <td className={cn(num, 'pr-4')}>
                <Hours value={totalHours(summary)} strong />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <EntryDialog open={adding !== null} onClose={() => setAdding(null)} day={adding ?? today} personId={personId} />
    </Panel>
  );
}
