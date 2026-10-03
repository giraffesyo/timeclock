import { createFileRoute } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Empty, ErrorNote, Loading, Page, Panel } from '@/components/page';
import { RequestForm } from '@/components/time-off/request-form';
import { TimeOffList } from '@/components/time-off/time-off-list';
import { useTimeOff } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { addDays } from '@/lib/time';

export const Route = createFileRoute('/time-off')({ component: TimeOffPage });

function TimeOffPage() {
  const t = useTranslations('timeOff');
  const { today } = useSession();
  // A year back and six months ahead: what payroll might still ask about, and what's planned.
  const timeOff = useTimeOff(addDays(today, -365), addDays(today, 183));

  const upcoming = (timeOff.data ?? []).filter((item) => item.day >= today);
  const past = (timeOff.data ?? []).filter((item) => item.day < today);

  return (
    <Page title={t('title')} description={t('description')}>
      <div className="space-y-4">
        <RequestForm />

        <Panel flush title={t('list.upcoming')}>
          {timeOff.isError ? (
            <ErrorNote className="m-4" context={t('list.loadFailed')} error={timeOff.error} />
          ) : timeOff.isPending ? (
            <Loading />
          ) : upcoming.length === 0 ? (
            <Empty>{t('list.emptyUpcoming')}</Empty>
          ) : (
            <TimeOffList items={upcoming} />
          )}
        </Panel>

        {timeOff.isSuccess && (
          <Panel flush title={t('list.past')}>
            {past.length === 0 ? <Empty>{t('list.emptyPast')}</Empty> : <TimeOffList items={past} newestFirst />}
          </Panel>
        )}
      </div>
    </Page>
  );
}
