import { AlertCircleIcon, InfoCircleIcon, LoaderIcon, SuccessIcon, WarningTriangleIcon } from '@parallelworks/ui/icons';
import { Toaster as Sonner } from 'sonner';
import { useTranslations } from 'use-intl';

/** Toasts, on the theme's panel tokens. */
export function Toaster() {
  const t = useTranslations('shell.toast');
  return (
    <Sonner
      position="bottom-right"
      containerAriaLabel={t('label')}
      icons={{
        success: <SuccessIcon className="size-4 text-success" />,
        info: <InfoCircleIcon className="size-4 text-info" />,
        warning: <WarningTriangleIcon className="size-4 text-warning" />,
        error: <AlertCircleIcon className="size-4 text-danger" />,
        loading: <LoaderIcon className="size-4" />,
      }}
      toastOptions={{
        closeButtonAriaLabel: t('close'),
        classNames: {
          toast: '!bg-card !text-card-foreground !border-border',
          description: '!text-muted-foreground',
        },
      }}
    />
  );
}
