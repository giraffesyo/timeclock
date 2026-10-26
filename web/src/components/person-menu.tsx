import { type MenuEntry, menuDivider, type OpenMenu, useOpenMenu } from '@parallelworks/ui';
import { ClockIcon, EditIcon, FileTextIcon } from '@parallelworks/ui/icons';
import { useCopySubmenu } from '@parallelworks/ui/list';
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
  items: (person: Person, options?: { day?: Day; actions?: MenuEntry[] }) => MenuEntry[];
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
  const openMenu = useOpenMenu();
  const [editing, setEditing] = useState<Person | null>(null);
  const people = usePeople(admin);

  const items = useCallback<PersonMenu['items']>(
    (person, { day, actions = [] } = {}) => {
      // As the server decides: your own time, your reports', or anyone's for an admin.
      const viewable = admin || person.id === me.id || (person.managerId !== '' && person.managerId === me.id);
      const search = { person: person.id === me.id ? undefined : person.id, day };
      const lead: MenuEntry[] = [
        ...(viewable
          ? [
              {
                label: t('openSheet'),
                icon: <FileTextIcon />,
                onClick: () => void navigate({ to: '/timesheet', search }),
              },
              {
                label: t('openTimer'),
                icon: <ClockIcon />,
                onClick: () => void navigate({ to: '/', search }),
              },
            ]
          : []),
        ...(admin ? [{ label: t('edit'), icon: <EditIcon />, onClick: () => setEditing(person) }] : []),
      ];
      const middle = actions.filter((a) => !('destructive' in a && a.destructive));
      const trailing = actions.filter((a) => 'destructive' in a && a.destructive);
      const groups = [lead, middle, [copy({ name: person.name, email: person.email })], trailing];
      return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [menuDivider, ...g]));
    },
    [admin, me.id, navigate, t, copy],
  );

  const open = useCallback<OpenMenu>(
    (at, menu, options) => {
      // The keyboard's menu key reports no pointer: open under what has focus instead.
      const keyboard = !(at instanceof Element) && !at.clientX && !at.clientY;
      if (keyboard && document.activeElement) {
        at.preventDefault?.();
        return openMenu(document.activeElement, menu, options);
      }
      return openMenu(at, menu, options);
    },
    [openMenu],
  );

  const value = useMemo(() => ({ items, open, edit: setEditing }), [items, open]);
  const list = people.data ?? [];

  return (
    <PersonMenuContext.Provider value={value}>
      {children}
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
