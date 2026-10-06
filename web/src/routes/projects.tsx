import { createFileRoute } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { AdminPage } from '@/components/admin-page';
import { Catalog } from '@/components/settings/catalog';

export const Route = createFileRoute('/projects')({ component: ProjectsPage });

function ProjectsPage() {
  const t = useTranslations('manage.projects');
  return (
    <AdminPage title={t('title')} description={t('description')}>
      <Catalog />
    </AdminPage>
  );
}
