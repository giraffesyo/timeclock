import { createFileRoute } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { AdminPage } from '@/components/admin-page';
import { People } from '@/components/settings/people';

export const Route = createFileRoute('/people')({ component: PeoplePage });

function PeoplePage() {
  const t = useTranslations('manage.people');
  return (
    <AdminPage title={t('title')} description={t('description')} wide>
      <People />
    </AdminPage>
  );
}
