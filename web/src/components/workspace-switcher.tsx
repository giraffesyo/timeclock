import { TOOLTIP_ID } from '@parallelworks/ui';
import { CheckIcon } from '@parallelworks/ui/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { BrandIcon, KeyIcon } from '@/components/nav-icons';
import { ErrorNote } from '@/components/page';
import { accounts } from '@/lib/accounts';
import { basePath } from '@/lib/base';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';

/** The signed-in account and its workspaces, on a server that has its own accounts. */
export function useAccount() {
  const { info } = useSession();
  return useQuery({
    queryKey: ['account-session'],
    queryFn: accounts.session,
    enabled: !!info.accountsUrl,
    select: (d) => d.session,
  });
}

/**
 * The name at the top of the sidebar. For someone in more than one
 * workspace it is also how they move between them.
 */
export function WorkspaceSwitcher() {
  const t = useTranslations('shell');
  const account = useAccount();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const workspaces = account.data?.workspaces ?? [];
  const current = workspaces.find((w) => w.key === account.data?.workspace);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const name = current?.name || t('name');
  const label = (
    <>
      <BrandIcon className="shrink-0 text-(--theme-accent)" />
      <span className="truncate">{name}</span>
    </>
  );
  if (workspaces.length < 2) {
    return <span className="flex h-9 min-w-0 items-center gap-2 px-2 text-sm font-semibold">{label}</span>;
  }
  const go = async (key: string) => {
    // A workspace with its own single sign-on is entered through it.
    if (workspaces.find((w) => w.key === key)?.ssoRequired) {
      window.location.assign(accounts.workspaceSSOUrl(key, `${basePath}/`));
      return;
    }
    try {
      await accounts.switchWorkspace(key);
      // Everything on the page was the other workspace's.
      window.location.assign(`${basePath}/`);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-semibold hover:bg-foreground/5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workspace.switch', { name })}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div role="menu" className="popover absolute top-full left-0 z-40 mt-1 w-60 p-1 text-(--theme-app)">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={w.key === current?.key}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--theme-hover)',
              )}
              onClick={() => (w.key === current?.key ? setOpen(false) : go(w.key))}
            >
              <span className="min-w-0 flex-1 truncate">{w.name || w.key}</span>
              {w.key === current?.key && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-(--theme-accent)" />}
            </button>
          ))}
          {error !== null && <ErrorNote className="m-1" context={t('workspace.failed')} error={error} />}
        </div>
      )}
    </div>
  );
}

/** The way to the account's own page, on a server that has its own accounts. */
export function AccountLink({ className }: { className?: string }) {
  const t = useTranslations('shell');
  const { info } = useSession();
  if (!info.accountsUrl) return null;
  return (
    <Link
      to="/account"
      className={className}
      aria-label={t('account')}
      data-tooltip-id={TOOLTIP_ID}
      data-tooltip-content={t('account')}
    >
      <KeyIcon />
    </Link>
  );
}
