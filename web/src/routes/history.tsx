import { createFileRoute } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { AdminPage } from '@/components/admin-page';
import { History } from '@/components/settings/history';

export const Route = createFileRoute('/history')({ component: HistoryPage });

function HistoryPage() {
  const t = useTranslations('manage.history');
  return (
    <AdminPage title={t('title')} description={t('description')} wide>
      <History />
    </AdminPage>
  );
}
