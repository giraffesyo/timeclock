import { type UILinkComponent, UIProvider } from '@parallelworks/ui';
import { Link, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { GlobalTooltip } from '@/components/tooltip';

// @parallelworks/ui renders internal links with the router's Link.
const RouterLink: UILinkComponent = ({ href, children, ...rest }) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

const slots = { link: RouterLink };

/** Binds @parallelworks/ui to the router and the app's catalog. It shows the app's toasts too. */
export function AppUIProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useTranslations('ui');

  const navigation = useMemo(
    () => ({
      goTo: (to: string) => router.navigate({ to }),
      openExternal: (href: string) => window.open(href, '_blank', 'noopener,noreferrer'),
    }),
    [router],
  );

  const strings = useMemo(
    () => ({
      modal: { creating: t('modal.creating') },
      common: {
        loading: t('loading'),
        cancel: t('common.cancel'),
        close: t('common.close'),
        dismiss: t('common.dismiss'),
        filter: t('common.filter'),
        notifications: t('common.notifications'),
        copy: t('common.copy'),
        copied: t('common.copied'),
        copyFailed: t('common.copyFailed'),
        add: t('common.add'),
        create: t('common.create'),
        remove: t('common.remove'),
        sort: t('common.sort'),
        userAvatar: t('common.userAvatar'),
      },
      dropdown: {
        select: (type: string) => t('dropdown.select', { type }),
        noOptionsFound: t('dropdown.noOptionsFound'),
        showOptions: t('dropdown.showOptions'),
      },
    }),
    [t],
  );

  return (
    <UIProvider strings={strings} navigation={navigation} slots={slots}>
      {children}
      <GlobalTooltip />
    </UIProvider>
  );
}
