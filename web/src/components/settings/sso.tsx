import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { SwitchRow } from '@/components/settings/switch';
import { accounts, type SSOSettings } from '@/lib/accounts';
import { useSession } from '@/lib/session';

/**
 * The workspace's own single sign-on: an OpenID Connect provider its people
 * sign in through. What the provider says counts in this workspace only.
 */
export function SignIn() {
  const t = useTranslations('settings.sso');
  const { info } = useSession();
  const settings = useQuery({ queryKey: ['workspace-sso'], queryFn: accounts.sso, enabled: !!info.accountsUrl });
  if (!info.accountsUrl) return <p className="text-sm text-muted-foreground">{t('hosted')}</p>;
  if (settings.isPending) return <Loading />;
  if (settings.isError) return <ErrorNote context={t('loadFailed')} error={settings.error} />;
  return <Form key={settings.dataUpdatedAt} saved={settings.data} />;
}

function Form({ saved }: { saved: SSOSettings }) {
  const t = useTranslations('settings.sso');
  const tc = useTranslations('common');
  const client = useQueryClient();
  const [issuer, setIssuer] = useState(saved.issuer ?? '');
  const [clientId, setClientId] = useState(saved.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [required, setRequired] = useState(saved.required ?? false);
  const [autoJoin, setAutoJoin] = useState(saved.autoJoin ?? false);
  const refresh = () => client.invalidateQueries({ queryKey: ['workspace-sso'] });
  const save = useMutation({
    mutationFn: () => accounts.saveSSO({ issuer, clientId, clientSecret, required, autoJoin }),
    onSuccess: () => {
      toast.success(t('saved'));
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: accounts.removeSSO,
    onSuccess: () => {
      toast.success(t('removed'));
      return refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="max-w-2xl space-y-4" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <Panel title={t('provider')}>
        <div className="space-y-3">
          <Field label={t('issuer')} hint={t('issuerHint')}>
            <input
              className={controlClass}
              type="url"
              required
              placeholder="https://accounts.example.com"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
          </Field>
          <Field label={t('clientId')}>
            <input className={controlClass} required value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </Field>
          <Field label={t('clientSecret')} hint={saved.configured ? t('secretKept') : undefined}>
            <input
              className={controlClass}
              type="password"
              autoComplete="off"
              required={!saved.configured}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </Field>
          <Field label={t('redirect')} hint={t('redirectHint')}>
            <input className={`${controlClass} font-mono text-xs`} readOnly value={saved.redirectUrl} />
          </Field>
          {saved.configured && (
            <Field label={t('loginUrl')} hint={t('loginUrlHint')}>
              <input className={`${controlClass} font-mono text-xs`} readOnly value={saved.loginUrl} />
            </Field>
          )}
        </div>
      </Panel>
      <Panel flush>
        <div className="divide-y divide-border px-4">
          <SwitchRow label={t('required')} hint={t('requiredHint')} value={required} onChange={setRequired} />
          <SwitchRow label={t('autoJoin')} hint={t('autoJoinHint')} value={autoJoin} onChange={setAutoJoin} />
        </div>
      </Panel>
      {save.isError && <ErrorNote context={t('saveFailed')} error={save.error} />}
      {remove.isError && <ErrorNote context={t('removeFailed')} error={remove.error} />}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={save.isPending}>
          {tc('save')}
        </Button>
        {saved.configured && (
          <Button variant="danger" className="ml-auto" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('remove')}
          </Button>
        )}
      </div>
    </form>
  );
}
