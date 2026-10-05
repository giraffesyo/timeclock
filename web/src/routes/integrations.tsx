import { createFileRoute } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { TogglIntegration } from '@/components/integrations/toggl';
import { Page } from '@/components/page';
import { useSession } from '@/lib/session';

export const Route = createFileRoute('/integrations')({ component: IntegrationsPage });

function IntegrationsPage() {
  const t = useTranslations('integrations');
  const { admin } = useSession();
  return (
    <Page title={t('title')} description={admin ? t('description') : undefined}>
      {admin ? (
        <div className="space-y-6">
          <TogglIntegration />
          <section aria-label={t('otherConnections')} className="divide-y divide-border border-y border-border">
            {(['googleCalendar', 'gusto'] as const).map((name) => (
              <div key={name} className="flex flex-wrap items-center justify-between gap-2 py-4">
                <h2 className="text-sm font-medium">{t(name)}</h2>
                <span className="text-sm text-muted-foreground">{t('notAvailable')}</span>
              </div>
            ))}
          </section>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
      )}
    </Page>
  );
}
