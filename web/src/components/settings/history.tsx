import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass } from '@/components/field';
import { Empty, ErrorNote, Loading, Panel } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { PersonSelect, personChoices } from '@/components/person-select';
import { isDay } from '@/lib/periods';
import { type AuditEntry, useAudit } from '@/lib/queries';
import { type Day, dayToDate } from '@/lib/time';
import { useZone } from '@/lib/zone';

/** The audit actions the catalog has words for, keyed as the catalog spells them. */
const ACTIONS = {
  'entry.create': 'entry_create',
  'entry.update': 'entry_update',
  'entry.delete': 'entry_delete',
  'time_off.request': 'time_off_request',
  'time_off.cancel': 'time_off_cancel',
  'time_off.approved': 'time_off_approved',
  'time_off.rejected': 'time_off_rejected',
  'timesheet.submit': 'timesheet_submit',
  'timesheet.approved': 'timesheet_approved',
  'timesheet.rejected': 'timesheet_rejected',
  'timesheet.reopen': 'timesheet_reopen',
  'settings.update': 'settings_update',
  'person.update': 'person_update',
  'customer.save': 'customer_save',
  'customer.delete': 'customer_delete',
  'project.save': 'project_save',
  'project.delete': 'project_delete',
  'holiday.create': 'holiday_create',
  'holiday.update': 'holiday_update',
  'holiday.delete': 'holiday_delete',
} as const;

const isAction = (action: string): action is keyof typeof ACTIONS => action in ACTIONS;

const th = 'px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4';
const td = 'px-3 py-2 align-top first:pl-4 last:pr-4';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The record a change is about: what it became, or for a removal what it was. */
function subject(entry: AuditEntry): Record<string, unknown> {
  const detail = entry.detail ?? {};
  return isRecord(detail['after']) ? detail['after'] : detail;
}

/** The audit log, newest first: who changed what, and whose time it was. */
export function History() {
  const t = useTranslations('settings.history');
  const tc = useTranslations('common');
  const format = useFormatter();
  const periodLabel = usePeriodLabel();
  const zone = useZone();
  const [personId, setPersonId] = useState('');
  // Where the log starts: the end of this day, or now.
  const [until, setUntil] = useState<Day | ''>('');
  // The last entry of each page read so far: the way back to newer ones.
  const [pages, setPages] = useState<string[]>([]);
  const audit = useAudit({ person: personId || undefined, before: pages.at(-1), until: until || undefined });
  // Who everyone is comes with the log, as an auditor need not be an admin who sees everyone;
  // from the newest page, so the filter keeps its choices while another page loads.
  const people = useAudit().data?.people ?? [];
  // A new filter or day starts over at its newest page.
  const choosePerson = (id: string) => {
    setPersonId(id);
    setPages([]);
  };
  const chooseUntil = (day: string) => {
    setUntil(isDay(day) ? day : '');
    setPages([]);
  };
  const last = audit.data?.entries.at(-1);

  const names = new Map(people.map((p) => [p.id, p.name || p.id]));
  const name = (id: string) => names.get(id) ?? id;

  /** What the change was about, when the log says: the time, the day off, the period, the name. */
  const about = (entry: AuditEntry): string => {
    const s = subject(entry);
    const family = entry.action.split('.')[0];
    if (family === 'entry') {
      const start = str(s['startedAt']);
      if (!start) return '';
      const end = str(s['endedAt']);
      const time = (iso: string) =>
        format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
      const day = format.dateTime(new Date(start), { month: 'short', day: 'numeric', timeZone: zone });
      return end
        ? t('about.entry', { day, start: time(start), end: time(end) })
        : t('about.entryRunning', { day, start: time(start) });
    }
    if (family === 'time_off') {
      const day = str(s['day']);
      const kind = str(s['kind']);
      if (!isDay(day) || (kind !== 'vacation' && kind !== 'sick')) return '';
      return t('about.timeOff', {
        kind: tc(`kind.${kind}`),
        day: format.dateTime(dayToDate(day), { month: 'short', day: 'numeric', year: 'numeric' }),
        hours: typeof s['hours'] === 'number' ? s['hours'] : 0,
      });
    }
    if (family === 'timesheet') {
      const period = s['period'];
      if (!isRecord(period)) return '';
      const start = str(period['start']);
      const end = str(period['end']);
      return isDay(start) && isDay(end) ? periodLabel({ start, end }) : '';
    }
    if (family === 'customer' || family === 'project' || family === 'holiday') return str(s['name']);
    return '';
  };

  return (
    <Panel
      flush
      title={t('title')}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* The day and the person are full width, so each takes its width from a box around it. */}
          <div className="w-40">
            <input
              type="date"
              className={controlClass}
              aria-label={t('until')}
              title={t('until')}
              value={until}
              onChange={(e) => chooseUntil(e.target.value)}
            />
          </div>
          <div className="w-52">
            <PersonSelect
              label={t('filter')}
              value={personId}
              onChange={choosePerson}
              choices={[{ value: '', label: t('everyone') }, ...personChoices(people)]}
            />
          </div>
        </div>
      }
    >
      {audit.isError ? (
        <ErrorNote className="m-4" context={t('loadFailed')} error={audit.error} />
      ) : audit.isPending ? (
        <Loading />
      ) : audit.data.entries.length === 0 ? (
        <Empty>
          {until
            ? t('emptyUntil', {
                day: format.dateTime(dayToDate(until), { month: 'short', day: 'numeric', year: 'numeric' }),
              })
            : personId
              ? t('emptyPerson', { name: name(personId) })
              : t('empty')}
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={th}>
                  {t('columns.when')}
                </th>
                <th scope="col" className={th}>
                  {t('columns.who')}
                </th>
                <th scope="col" className={th}>
                  {t('columns.what')}
                </th>
                <th scope="col" className={th}>
                  {t('columns.whose')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {audit.data.entries.map((entry, i) => {
                const detail = about(entry);
                return (
                  // The log has no ids and can repeat an instant; its order is stable.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <tr key={`${entry.at}-${i}`}>
                    <td className={`${td} tabular whitespace-nowrap text-muted-foreground`}>
                      {format.dateTime(new Date(entry.at), {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZone: zone,
                      })}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{name(entry.actor)}</td>
                    <td className={td}>
                      {isAction(entry.action) ? (
                        t(`actions.${ACTIONS[entry.action]}`)
                      ) : (
                        <code className="font-mono text-xs">{entry.action}</code>
                      )}
                      {detail && <span className="text-muted-foreground"> · {detail}</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {entry.personId ? (
                        entry.personId === entry.actor ? (
                          <span className="text-muted-foreground">{t('own')}</span>
                        ) : (
                          name(entry.personId)
                        )
                      ) : (
                        <span className="text-muted-foreground">{t('organization')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {audit.data && (audit.data.entries.length > 0 || pages.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
          <p className="mr-auto text-xs text-muted-foreground">
            {t('footer', { page: pages.length + 1, count: audit.data.entries.length, zone })}
          </p>
          {(pages.length > 0 || until) && (
            <Button size="sm" variant="ghost" onClick={() => chooseUntil('')}>
              {t('newest')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={pages.length === 0}
            onClick={() => setPages(pages.slice(0, -1))}
          >
            {t('newer')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!audit.data.more || !last}
            onClick={() => last && setPages([...pages, last.id])}
          >
            {t('older')}
          </Button>
        </div>
      )}
    </Panel>
  );
}
