import { Avatar, type AvatarStatus } from '@parallelworks/ui';
import { HoverCardRow, HoverCardTrigger, UserHoverCard } from '@parallelworks/ui/list';
import { useTranslations } from 'use-intl';
import { BrandIcon, TeamIcon } from '@/components/nav-icons';
import type { Person } from '@/lib/queries';
import { useSession } from '@/lib/session';

/** Foundation's shared identity and profile card, for people and their managers. */
export function PersonIdentity({
  person,
  people,
  status,
}: {
  person: Person;
  people: Person[];
  /** A dot on the picture, as for a running clock. */
  status?: AvatarStatus;
}) {
  const t = useTranslations('settings.people');
  const { settings } = useSession();
  const name = person.name || person.email || person.id;
  const manager = people.find((p) => p.id === person.managerId);
  return (
    <HoverCardTrigger
      className="inline-flex"
      card={(placement) => (
        <UserHoverCard
          {...placement}
          username={person.email || person.id}
          name={name}
          avatarSrc={person.avatarUrl}
          badge={person.active ? t('active') : t('inactive')}
        >
          <HoverCardRow icon={<TeamIcon />}>
            {t.rich('profileManager', {
              name: manager?.name || manager?.email || person.managerId || t('adminApproves'),
              // The manager is a person too: their photo beside their name.
              person: (chunks) =>
                manager ? (
                  <span className="inline-flex items-center gap-1 align-bottom">
                    <Avatar
                      src={manager.avatarUrl}
                      name={manager.name || manager.email || manager.id}
                      size="sm"
                      className="shrink-0 [&>*]:!size-4 [&>*]:!text-[8px]"
                    />
                    <span className="font-medium text-foreground">{chunks}</span>
                  </span>
                ) : (
                  chunks
                ),
            })}
          </HoverCardRow>
          <HoverCardRow icon={<BrandIcon />}>{person.timezone || settings.timezone}</HoverCardRow>
        </UserHoverCard>
      )}
    >
      <button
        type="button"
        aria-label={name}
        className="flex min-h-9 items-center gap-2 rounded-md text-left font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Avatar src={person.avatarUrl} name={name} size="sm" status={status} className="shrink-0" />
        <span>{name}</span>
      </button>
    </HoverCardTrigger>
  );
}
