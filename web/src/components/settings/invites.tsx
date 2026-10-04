import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass } from '@/components/field';
import { ErrorNote, Panel } from '@/components/page';
import { Chip } from '@/components/status';
import { accounts } from '@/lib/accounts';
import { useSession } from '@/lib/session';

/**
 * Inviting people, on a server that has its own accounts: an address gets a
 * link by email to set up an account in this workspace. The link is shown
 * here too, for a server with no mail to send it.
 */
export function Invites() {
  const t = useTranslations('settings.invites');
  const format = useFormatter();
  const { info } = useSession();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(false);
  const [made, setMade] = useState<{ email: string; link: string } | null>(null);

  const waiting = useQuery({ queryKey: ['invites'], queryFn: accounts.invites, enabled: !!info.accountsUrl });
  const invite = useMutation({
    mutationFn: () => accounts.invite(email, admin),
    onSuccess: (out) => {
      setMade(out);
      setEmail('');
      setAdmin(false);
      return client.invalidateQueries({ queryKey: ['invites'] });
    },
  });
  const revoke = useMutation({
    mutationFn: accounts.revokeInvite,
    onSuccess: () => client.invalidateQueries({ queryKey: ['invites'] }),
  });
  if (!info.accountsUrl) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMade(null);
    invite.mutate();
  };
  return (
    <Panel flush title={t('title')} className="mb-4">
      <form className="flex flex-wrap items-center gap-2 px-4 py-3" onSubmit={submit}>
        <input
          className={`${controlClass} max-w-xs flex-1 basis-56`}
          type="email"
          required
          placeholder={t('placeholder')}
          aria-label={t('email')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="theme-range" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          {t('asAdmin')}
        </label>
        <Button type="submit" variant="primary" loading={invite.isPending}>
          {t('send')}
        </Button>
      </form>
      {invite.isError && <ErrorNote className="mx-4 mb-3" context={t('failed')} error={invite.error} />}
      {made && (
        <div className="mx-4 mb-3 rounded-md bg-success-subtle px-3 py-2 text-sm text-success" role="status">
          <p>{t('sent', { email: made.email })}</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              className={`${controlClass} flex-1 font-mono text-xs`}
              readOnly
              aria-label={t('link')}
              value={made.link}
            />
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(made.link).then(
                  () => toast.success(t('copied')),
                  () => toast.error(t('copyFailed')),
                );
              }}
            >
              {t('copy')}
            </Button>
          </div>
        </div>
      )}
      {waiting.isError && <ErrorNote className="mx-4 mb-3" context={t('loadFailed')} error={waiting.error} />}
      {(waiting.data?.length ?? 0) > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {waiting.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{i.email}</span>
              {i.admin && <Chip tone="info">{t('admin')}</Chip>}
              <span className="text-xs text-muted-foreground">
                {t('expires', { date: format.dateTime(new Date(i.expiresAt), { month: 'short', day: 'numeric' }) })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('withdrawFor', { email: i.email })}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(i.id)}
              >
                {t('withdraw')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
