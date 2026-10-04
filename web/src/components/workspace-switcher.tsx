import { ConfirmModal } from '@parallelworks/ui';
import { CheckIcon } from '@parallelworks/ui/icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { authInput } from '@/components/auth-page';
import { Field } from '@/components/field';
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

/** Changes the signed-in account's password, from the foot of the sidebar. */
export function PasswordButton({ className }: { className?: string }) {
  const t = useTranslations('shell.password');
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (!account.data) return null;
  const close = () => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setError(null);
  };
  return (
    <>
      <button type="button" className={className} aria-label={t('open')} onClick={() => setOpen(true)}>
        <KeyIcon />
      </button>
      <ConfirmModal
        open={open}
        onClose={close}
        title={t('title')}
        description={t('description')}
        confirmLabel={t('save')}
        confirmDisabled={!current || next.length < 10}
        closeOnConfirm={false}
        onConfirm={async () => {
          try {
            await accounts.changePassword(current, next);
            close();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <div className="space-y-3">
          <input type="email" autoComplete="username" value={account.data.account.email} readOnly hidden />
          <Field label={t('current')}>
            <input
              className={authInput}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label={t('next')} hint={t('rule')}>
            <input
              className={authInput}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          {error !== null && <ErrorNote error={error} />}
        </div>
      </ConfirmModal>
    </>
  );
}
