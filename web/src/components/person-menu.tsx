import { ClockIcon, EditIcon, FileTextIcon } from '@parallelworks/ui/icons';
import { type OpenMenu, type RowMenuItem, useCopySubmenu, useRowMenu } from '@parallelworks/ui/list';
import { useNavigate } from '@tanstack/react-router';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { PersonDialog } from '@/components/person-dialog';
import { type Person, usePeople } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { Day } from '@/lib/time';

interface PersonMenu {
  /**
   * A person's menu: their timesheet and timer where the caller may see their
   * time, their settings for an admin, and copying who they are. A list's own
   * actions on them go in the middle; destructive ones go last.
   */
  items: (person: Person, options?: { day?: Day; actions?: RowMenuItem[] }) => RowMenuItem[];
  /** Opens the person's menu at the pointer, or beside what has focus for the keyboard's menu key. */
  open: OpenMenu;
  /** Opens the person's settings. */
  edit: (person: Person) => void;
}

const PersonMenuContext = createContext<PersonMenu | null>(null);

/** The same menu for a person wherever they appear: their name, a row of theirs. */
export function usePersonMenu(): PersonMenu {
  const menu = useContext(PersonMenuContext);
  if (!menu) throw new Error('usePersonMenu outside PersonMenuProvider');
  return menu;
}

/** Holds the person menu and the settings dialog it opens, for every page. */
export function PersonMenuProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('common.person');
  const navigate = useNavigate();
  const copy = useCopySubmenu();
  const { person: me, admin } = useSession();
  const { openMenu, contextMenu } = useRowMenu();
  const [editing, setEditing] = useState<Person | null>(null);
  const people = usePeople(admin);

  const items = useCallback<PersonMenu['items']>(
    (person, { day, actions = [] } = {}) => {
      // As the server decides: your own time, your reports', or anyone's for an admin.
      const viewable = admin || person.id === me.id || (person.managerId !== '' && person.managerId === me.id);
      const search = { person: person.id === me.id ? undefined : person.id, day };
      const lead: RowMenuItem[] = [
        ...(viewable
          ? [
              {
                kind: 'action' as const,
                label: t('openSheet'),
                icon: <FileTextIcon />,
                onSelect: () => void navigate({ to: '/timesheet', search }),
              },
              {
                kind: 'action' as const,
                label: t('openTimer'),
                icon: <ClockIcon />,
                onSelect: () => void navigate({ to: '/', search }),
              },
            ]
          : []),
        ...(admin
          ? [{ kind: 'action' as const, label: t('edit'), icon: <EditIcon />, onSelect: () => setEditing(person) }]
          : []),
      ];
      const middle = actions.filter((a) => !('destructive' in a && a.destructive));
      const trailing = actions.filter((a) => 'destructive' in a && a.destructive);
      const groups = [lead, middle, [copy({ name: person.name, email: person.email })], trailing];
      return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [{ kind: 'divider' as const }, ...g]));
    },
    [admin, me.id, navigate, t, copy],
  );

  const open = useCallback<OpenMenu>(
    (x, y, menu, onClose) => {
      // The keyboard's menu key reports no pointer: open beside what has focus instead.
      if (!x && !y && document.activeElement) {
        const box = document.activeElement.getBoundingClientRect();
        [x, y] = [box.left + 24, box.bottom];
      }
      openMenu(x, y, menu, onClose);
    },
    [openMenu],
  );

  const value = useMemo(() => ({ items, open, edit: setEditing }), [items, open]);
  const list = people.data ?? [];

  return (
    <PersonMenuContext.Provider value={value}>
      {children}
      {contextMenu}
      {editing && (
        <PersonDialog
          person={list.find((p) => p.id === editing.id) ?? editing}
          people={list}
          onClose={() => setEditing(null)}
        />
      )}
    </PersonMenuContext.Provider>
  );
}
