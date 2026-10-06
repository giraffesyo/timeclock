import { useErrorMessage } from '@parallelworks/problem/react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { PersonIdentity } from '@/components/person-identity';
import { groupRuns, type Run, useDayLabel, useHoursText } from '@/components/time-off/runs';
import { type Person, type TimeOff, useDecideTimeOff } from '@/lib/queries';
import { decimalHours } from '@/lib/time';
import { DecisionDialog } from './decision-dialog';

/** One request: a person's consecutive days of one kind, asked for alike. */
const alike = (t: TimeOff) => [t.personId, t.kind, t.hours, t.note].join('\u0000');

/** The requests waiting for the caller, oldest first. */
export function pendingRuns(items: TimeOff[]): Run[] {
  return groupRuns(items, alike);
}

const single = (item: TimeOff): Run => ({ id: item.id, days: [item], first: item, last: item, hours: item.hours });

interface Target {
  name: string;
  approve: boolean;
  /** The days still to decide: all of them, then only those that failed. */
  days: TimeOff[];
  /** How many days the decision started with. */
  total: number;
  hours: number;
  range: string;
  failures: { item: TimeOff; error: unknown }[];
}

/**
 * Time off waiting for the caller's decision. Each day is its own record;
 * a run of them is decided together, or day by day when only some can go.
 */
export function PendingTimeOff({
  runs,
  people,
}: {
  runs: Run[];
  /** Everyone the requests can name, with their profiles. */
  people: Person[];
}) {
  const t = useTranslations('team.timeOff');
  const tn = useTranslations('team.note');
  const tc = useTranslations('common');
  const label = useDayLabel();
  const hoursText = useHoursText();
  const errorMessage = useErrorMessage();
  const decide = useDecideTimeOff();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);

  const personOf = (id: string) => people.find((p) => p.id === id);
  const ask = (run: Run, approve: boolean) => {
    setTarget({
      name: personOf(run.first.personId)?.name ?? t('unknownPerson'),
      approve,
      days: run.days,
      total: run.days.length,
      hours: run.hours,
      range: label.range(run.first.day, run.last.day),
      failures: [],
    });
    setOpen(true);
  };

  const toggle = (id: string) =>
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const actions = (run: Run, name: string) => {
    const count = run.days.length;
    const context = { name, kind: tc(`kind.${run.first.kind}`), days: label.range(run.first.day, run.last.day) };
    return (
      <>
        <Button size="sm" variant="primary" aria-label={t('approveLabel', context)} onClick={() => ask(run, true)}>
          {count > 1 ? t('approveAll', { count }) : t('approve')}
        </Button>
        <Button size="sm" variant="danger" aria-label={t('rejectLabel', context)} onClick={() => ask(run, false)}>
          {count > 1 ? t('rejectAll', { count }) : t('reject')}
        </Button>
      </>
    );
  };

  return (
    <>
      <ul className="divide-y divide-border">
        {runs.map((run) => {
          const { first } = run;
          const person = personOf(first.personId);
          const name = person?.name ?? t('unknownPerson');
          const multi = run.days.length > 1;
          const byDay = multi && expanded.includes(run.id);
          return (
            <li key={run.id} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="min-w-0 truncate text-sm font-medium sm:w-44">
                  {person ? <PersonIdentity person={person} people={people} /> : name}
                </span>
                <span className="text-sm">{tc(`kind.${first.kind}`)}</span>
                <span className="tabular text-sm">{label.range(first.day, run.last.day)}</span>
                <span className="tabular text-sm text-muted-foreground">
                  {multi && `${t('days', { count: run.days.length })} · `}
                  {tc('hours', { hours: decimalHours(run.hours) })}
                  {multi && ` · ${t('perDay', { hours: hoursText(first.hours) })}`}
                </span>
                <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  {multi && (
                    <Button size="sm" variant="ghost" aria-expanded={byDay} onClick={() => toggle(run.id)}>
                      {byDay ? t('together') : t('byDay')}
                    </Button>
                  )}
                  {!byDay && actions(run, name)}
                </span>
              </div>
              {first.note && <p className="mt-1 text-xs text-muted-foreground">{first.note}</p>}
              {byDay && (
                <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                  {run.days.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm">
                      <span className="tabular min-w-0 flex-1">{label.day(item.day)}</span>
                      <span className="tabular text-muted-foreground">
                        {tc('hours', { hours: decimalHours(item.hours) })}
                      </span>
                      <span className="flex gap-1.5">{actions(single(item), name)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={target ? t(target.approve ? 'approveTitle' : 'rejectTitle', { name: target.name }) : ''}
        description={
          target
            ? t('description', {
                kind: tc(`kind.${target.days[0]?.kind ?? 'vacation'}`),
                days: target.range,
                count: target.total,
                total: hoursText(target.hours),
              })
            : null
        }
        confirmLabel={
          !target
            ? ''
            : target.failures.length > 0
              ? t('retry', { count: target.days.length })
              : target.total > 1
                ? t(target.approve ? 'approveAll' : 'rejectAll', { count: target.total })
                : t(target.approve ? 'approve' : 'reject')
        }
        destructive={target ? !target.approve : false}
        note={target?.approve ? 'optional' : 'required'}
        notePlaceholder={target?.approve ? tn('approvePlaceholder') : tn('rejectPlaceholder')}
        errorContext={t('failed')}
        onConfirm={async (note) => {
          if (!target) return;
          // One record per day, so one decision each; a day that fails doesn't stop the rest.
          const failures: Target['failures'] = [];
          for (const item of target.days) {
            try {
              await decide.mutateAsync({ id: item.id, approve: target.approve, note: note || undefined });
            } catch (error) {
              failures.push({ item, error });
            }
          }
          if (failures.length === 0) return;
          // A single day failing is the whole decision failing: say so the usual way.
          if (target.total === 1 && failures[0]) throw failures[0].error;
          setTarget({ ...target, days: failures.map((f) => f.item), failures });
          return 'keep';
        }}
      >
        {target && target.failures.length > 0 && (
          <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
            <p className="font-medium">
              {t('partial', { done: target.total - target.failures.length, total: target.total })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {target.failures.map(({ item, error }) => (
                <li key={item.id}>
                  <span className="tabular font-medium">{label.day(item.day)}</span> {errorMessage(error)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DecisionDialog>
    </>
  );
}
