import { Table, TOOLTIP_ID } from '@parallelworks/ui';
import { CheckIcon, ClockIcon, FileTextIcon, RollbackIcon } from '@parallelworks/ui/icons';
import {
  ListColumns,
  ListRow,
  ListRowActionsProvider,
  type ListView,
  listTableProps,
  type OpenMenu,
  type PinnedRowAction,
  type RowMenuItem,
  useListNavigate,
  useListView,
  useRowMenu,
} from '@parallelworks/ui/list';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Hours } from '@/components/hours';
import { Empty } from '@/components/page';
import { usePeriodLabel } from '@/components/period-nav';
import { PersonIdentity } from '@/components/person-identity';
import { SheetStatus } from '@/components/status';
import { useHoursText } from '@/components/time-off/runs';
import { type PeriodSummary, type Person, useDecideTimesheet } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { DecisionDialog } from './decision-dialog';

/** Worked, approved time off and holiday hours: what the timesheet states. */
export function totalHours(m: PeriodSummary): number {
  return m.regular + m.overtime + m.vacation + m.sick + m.holiday;
}

/** Where a person's timesheet stands, as the status filter names it. */
type SheetState = 'open' | 'submitted' | 'approved' | 'rejected' | 'reportsOnly';

function sheetState(m: PeriodSummary): SheetState {
  if (!m.timesheet && !m.person.submitsTimesheets) return 'reportsOnly';
  return m.timesheet?.status ?? 'open';
}

// Waiting first: the order the status sort uses, and the filter lists.
const sheetStates: SheetState[] = ['submitted', 'open', 'rejected', 'approved', 'reportsOnly'];

/** The team table's columns, sort orders and status filter, remembered between visits. */
export function useTeamView(): ListView<PeriodSummary> {
  const t = useTranslations('team.table');
  const tc = useTranslations('common.columns');
  const tsh = useTranslations('common.sheet');
  return useListView<PeriodSummary>({
    storageKey: 'timeclock.team',
    columns: [
      { key: 'person', label: t('person'), alwaysVisible: true },
      { key: 'regular', label: tc('regular'), headerClassName: 'text-right', priority: 'medium' },
      { key: 'overtime', label: tc('overtime'), headerClassName: 'text-right', priority: 'medium' },
      { key: 'vacation', label: tc('vacation'), headerClassName: 'text-right', priority: 'low' },
      { key: 'sick', label: tc('sick'), headerClassName: 'text-right', priority: 'low' },
      { key: 'holiday', label: tc('holiday'), headerClassName: 'text-right', priority: 'low' },
      { key: 'total', label: tc('total'), headerClassName: 'text-right' },
      { key: 'pendingTimeOff', label: t('pendingTimeOff'), headerClassName: 'text-right', priority: 'low' },
      // On a phone its column gives way, and the status sits under the name instead.
      { key: 'status', label: t('status'), priority: 'medium' },
    ],
    orderBys: [
      { value: 'name', label: t('person'), compare: (a, b) => a.person.name.localeCompare(b.person.name) },
      { value: 'total', label: tc('total'), compare: (a, b) => totalHours(a) - totalHours(b) },
      { value: 'overtime', label: tc('overtime'), compare: (a, b) => a.overtime - b.overtime },
      {
        value: 'status',
        label: t('status'),
        compare: (a, b) => sheetStates.indexOf(sheetState(a)) - sheetStates.indexOf(sheetState(b)),
      },
    ],
    defaultOrderBy: 'name',
    facets: [
      {
        key: 'status',
        label: t('status'),
        options: sheetStates.map((s) => ({ value: s, label: tsh(s) })),
        matches: (m, selected) => selected.includes(sheetState(m)),
      },
    ],
    actions: [
      { key: 'approve', label: t('approve'), defaultPinned: true },
      { key: 'sendBack', label: t('sendBack'), defaultPinned: true },
    ],
    defaultShowColumnHeaders: true,
  });
}

/** One person's period: their hours, where their timesheet stands, and the decision when it waits. */
function TeamRow({
  member: m,
  people,
  view,
  openMenu,
  onDecide,
}: {
  member: PeriodSummary;
  /** Everyone the profile cards can name, such as a person's manager. */
  people: Person[];
  view: ListView<PeriodSummary>;
  openMenu: OpenMenu;
  onDecide: (approve: boolean) => void;
}) {
  const t = useTranslations('team.table');
  const { person: me, admin } = useSession();
  const goTo = useListNavigate();
  const navigate = useNavigate();
  const own = m.person.id === me.id;
  const waiting = m.timesheet?.status === 'submitted';
  // Your own timesheet is your manager's or an admin's to decide.
  const decidable = waiting && (!own || admin);
  const open = () => navigate({ to: '/timesheet', search: { person: m.person.id, day: m.period.start } });
  const openTimer = () => navigate({ to: '/', search: { person: m.person.id, day: m.period.start } });

  const decisions: PinnedRowAction[] = decidable
    ? [
        { key: 'approve', label: t('approve'), icon: <CheckIcon />, onSelect: () => onDecide(true) },
        { key: 'sendBack', label: t('sendBack'), icon: <RollbackIcon />, onSelect: () => onDecide(false) },
      ]
    : [];
  const items: RowMenuItem[] = [
    { kind: 'action', label: t('openSheet', { name: m.person.name }), icon: <FileTextIcon />, onSelect: open },
    { kind: 'action', label: t('openTimer', { name: m.person.name }), icon: <ClockIcon />, onSelect: openTimer },
    ...decisions.map((d): RowMenuItem => ({ kind: 'action', label: d.label, icon: d.icon, onSelect: d.onSelect })),
  ];

  const status = (
    <>
      <SheetStatus timesheet={m.timesheet} reportsOnly={!m.person.submitsTimesheets} />
      {m.timesheet?.status === 'rejected' && m.timesheet.decisionNote && (
        <div className="mt-1 max-w-56 truncate text-xs text-muted-foreground">
          {t('sentBackNote', { note: m.timesheet.decisionNote })}
        </div>
      )}
      {waiting && !decidable && <div className="mt-1 text-xs text-muted-foreground">{t('own')}</div>}
    </>
  );

  const cells: Record<string, ReactNode> = {
    person: (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <PersonIdentity person={m.person} people={people} />
        {own && <span className="text-xs text-muted-foreground">{t('you')}</span>}
        {m.running && (
          <span
            className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-success"
            data-tooltip-id={TOOLTIP_ID}
            data-tooltip-content={t('runningHint')}
          >
            <ClockIcon className="size-3.5" aria-hidden />
            {t('running')}
          </span>
        )}
        {/* Narrower than the status column needs: stacked under the name. */}
        <div className="basis-full @[36rem]:hidden">{status}</div>
      </div>
    ),
    regular: <Hours value={m.regular} />,
    overtime: <Hours value={m.overtime} />,
    vacation: <Hours value={m.vacation} />,
    sick: <Hours value={m.sick} />,
    holiday: <Hours value={m.holiday} />,
    total: <Hours value={totalHours(m)} strong />,
    pendingTimeOff: <Hours value={m.pendingTimeOff} />,
    status,
  };

  return (
    <ListRow
      href={null}
      onActivate={open}
      items={items}
      goTo={goTo}
      openMenu={openMenu}
      pinnedActions={decisions.filter((d) => view.isPinned(d.key))}
    >
      {view.visibleColumns.map((col) => (
        <Table.Item
          key={col.key}
          className={col.headerClassName?.includes('text-right') ? 'py-2 text-right' : 'py-2'}
          wrap={col.key === 'status'}
        >
          {cells[col.key]}
        </Table.Item>
      ))}
    </ListRow>
  );
}

/**
 * One pay period, a row per person: their hours, where their timesheet
 * stands, and the decision when it waits for the caller. ⋯ and a right click
 * open the person's menu; a click opens their timesheet, except on their
 * name, which shows their profile.
 */
export function TeamTable({
  members,
  people,
  view,
}: {
  members: PeriodSummary[];
  /** Everyone the profile cards can name, such as a person's manager. */
  people: Person[];
  view: ListView<PeriodSummary>;
}) {
  const t = useTranslations('team.table');
  const ts = useTranslations('team.sheet');
  const tn = useTranslations('team.note');
  const periodLabel = usePeriodLabel();
  const hoursText = useHoursText();
  const decide = useDecideTimesheet();
  const { openMenu, contextMenu } = useRowMenu();
  const [target, setTarget] = useState<{ member: PeriodSummary; approve: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  const ask = (member: PeriodSummary, approve: boolean) => {
    setTarget({ member, approve });
    setOpen(true);
  };
  // The keyboard's menu key reports no pointer: open beside what has focus instead.
  const openRowMenu: OpenMenu = (x, y, items, onClose) => {
    if (!x && !y && document.activeElement) {
      const box = document.activeElement.getBoundingClientRect();
      [x, y] = [box.left + 24, box.bottom];
    }
    openMenu(x, y, items, onClose);
  };

  const shown = view.applyOrder(view.applyFilters(members));

  return (
    <>
      {shown.length === 0 ? (
        <Empty>{t('noMatch')}</Empty>
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
              {shown.map((m) => (
                <TeamRow
                  key={m.person.id}
                  member={m}
                  people={people}
                  view={view}
                  openMenu={openRowMenu}
                  onDecide={(approve) => ask(m, approve)}
                />
              ))}
            </Table>
          </ListRowActionsProvider>
        </div>
      )}
      {contextMenu}
      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={target ? ts(target.approve ? 'approveTitle' : 'sendBackTitle', { name: target.member.person.name }) : ''}
        description={
          target
            ? target.approve
              ? ts('approveDescription', {
                  period: periodLabel(target.member.period),
                  total: hoursText(totalHours(target.member)),
                })
              : ts('sendBackDescription', { period: periodLabel(target.member.period) })
            : null
        }
        confirmLabel={target?.approve ? t('approve') : t('sendBack')}
        destructive={target ? !target.approve : false}
        note={target?.approve ? 'none' : 'required'}
        notePlaceholder={tn('sendBackPlaceholder')}
        errorContext={ts('failed')}
        onConfirm={async (note) => {
          const id = target?.member.timesheet?.id;
          if (!target || !id) return;
          await decide.mutateAsync({ id, approve: target.approve, note: note || undefined });
        }}
      />
    </>
  );
}
