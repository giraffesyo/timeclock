import { GlobalTooltip, type UILinkComponent, UIProvider } from '@parallelworks/ui';
import { Link, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';

// @parallelworks/ui renders internal links with the router's Link.
const RouterLink: UILinkComponent = ({ to, children, ...rest }) => (
  <Link to={to} {...rest}>
    {children}
  </Link>
);

const notify = {
  info: (m: string) => toast.info(m),
  success: (m: string) => toast.success(m),
  warning: (m: string) => toast.warning(m),
  error: (m: string) => toast.error(m),
  loading: (content: React.ReactNode) => toast.loading(content),
  update: () => {},
  dismiss: (id?: string | number) => toast.dismiss(id),
};

const slots = { link: RouterLink };

/** Binds @parallelworks/ui to sonner, the router and the app's catalog. */
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
      loading: t('loading'),
      modal: {
        cancel: t('modal.cancel'),
        close: t('modal.close'),
        create: t('modal.create'),
        creating: t('modal.creating'),
        filter: t('modal.filter'),
        noOptions: t('modal.noOptions'),
      },
      common: {
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
    <UIProvider notify={notify} strings={strings} navigation={navigation} slots={slots}>
      {children}
      <GlobalTooltip />
    </UIProvider>
  );
}
